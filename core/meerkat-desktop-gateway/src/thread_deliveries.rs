//! Durable delivery of app-attributed output. This is a presentation outbox,
//! not an execution scheduler or a second source of native session state.
use crate::{GatewayError, thread_followups::Attribution};
use meerkat_desktop_contracts::EventEmit;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{io::Write, path::{Path, PathBuf}, sync::Mutex};

static LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Delivery {
    version: u8,
    thread_id: String,
    mob_id: String,
    event: EventEmit,
}
fn digest(value: &str) -> String { format!("{:x}", Sha256::digest(value.as_bytes())) }
fn directory(state: &Path, thread: &str, mob: &str) -> PathBuf {
    state.join("thread-deliveries").join(digest(&format!("{thread}\0{mob}")))
}
fn failure(error: impl std::fmt::Display) -> GatewayError {
    GatewayError::policy("Conversation delivery could not be persisted", Some(json!({"kind":"delivery_unavailable","error":error.to_string()})))
}
fn decode(path: &Path, thread: &str, mob: &str) -> Result<Delivery, GatewayError> {
    let value: Delivery = serde_json::from_slice(&std::fs::read(path).map_err(failure)?).map_err(failure)?;
    if value.version != 1 || value.thread_id != thread || value.mob_id != mob || value.event.thread_id.as_deref() != Some(thread) {
        return Err(failure("delivery scope mismatch"));
    }
    Ok(value)
}
pub(crate) fn persist(scope: &Attribution, event: &EventEmit) -> Result<(), GatewayError> {
    let _guard = LOCK.lock().map_err(failure)?;
    if event.thread_id.as_deref() != Some(&scope.thread_id) || event.run_id.as_deref() != Some(&scope.run_id) {
        return Err(failure("delivery attribution mismatch"));
    }
    let directory = directory(&scope.state_root, &scope.thread_id, &scope.mob_id);
    std::fs::create_dir_all(&directory).map_err(failure)?;
    let path = directory.join(format!("{}.json", digest(&event.event_id)));
    if path.exists() {
        let existing = decode(&path, &scope.thread_id, &scope.mob_id)?;
        if serde_json::to_value(existing.event).map_err(failure)? != serde_json::to_value(event).map_err(failure)? {
            return Err(failure("delivery identity was reused with different content"));
        }
        return Ok(());
    }
    let temporary = directory.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        file.write_all(&serde_json::to_vec(&Delivery {version:1,thread_id:scope.thread_id.clone(),mob_id:scope.mob_id.clone(),event:event.clone()})?)?;
        file.sync_all()?;
        std::fs::rename(&temporary, &path)?;
        std::fs::File::open(&directory)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() { let _ = std::fs::remove_file(temporary); }
    result.map_err(failure)
}
pub(crate) fn read(state: &Path, thread: &str, mob: &str) -> Result<Vec<EventEmit>, GatewayError> {
    let _guard = LOCK.lock().map_err(failure)?;
    let directory = directory(state, thread, mob);
    let entries = match std::fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(failure(error)),
    };
    let mut events = Vec::new();
    for entry in entries {
        let path = entry.map_err(failure)?.path();
        if path.extension().is_some_and(|ext| ext == "json") { events.push(decode(&path,thread,mob)?.event); }
    }
    // Output precedes its terminal even if both have the same clock value.
    events.sort_by(|a,b| a.timestamp.cmp(&b.timestamp).then_with(|| (a.kind != "run.output.complete").cmp(&(b.kind != "run.output.complete"))).then_with(||a.event_id.cmp(&b.event_id)));
    events.truncate(100);
    Ok(events)
}
pub(crate) fn acknowledge(state: &Path, thread: &str, mob: &str, event_id: &str) -> Result<(), GatewayError> {
    let _guard = LOCK.lock().map_err(failure)?;
    let directory = directory(state,thread,mob);
    let path = directory.join(format!("{}.json",digest(event_id)));
    if !path.exists() { return Ok(()); }
    let delivery = decode(&path,thread,mob)?;
    if delivery.event.event_id != event_id { return Err(failure("delivery acknowledgement mismatch")); }
    std::fs::remove_file(path).map_err(failure)?;
    std::fs::File::open(directory).and_then(|file|file.sync_all()).map_err(failure)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cold_replay_preserves_identity_and_requires_exact_scope_acknowledgement() {
        let root = std::env::temp_dir().join(format!("delivery-test-{}",uuid::Uuid::new_v4()));
        let scope = Attribution {state_root:root.clone(),thread_id:"thread".into(),mob_id:"mob".into(),session_id:"session".into(),run_id:"run".into()};
        let event = EventEmit {event_id:"final".into(),kind:"run.output.complete".into(),timestamp:chrono::Utc::now(),thread_id:Some("thread".into()),run_id:Some("run".into()),payload:json!({"text":"actual final"}),trace_id:"trace".into()};
        persist(&scope,&event).unwrap();
        persist(&scope,&event).unwrap();
        let mut changed = event.clone(); changed.payload["text"] = json!("wrong");
        assert!(persist(&scope,&changed).is_err());
        for _ in 0..2 { assert_eq!(serde_json::to_value(read(&root,"thread","mob").unwrap()).unwrap(),json!([event])); }
        acknowledge(&root,"other-thread","mob","final").unwrap();
        assert_eq!(read(&root,"thread","mob").unwrap().len(),1);
        acknowledge(&root,"thread","mob","final").unwrap();
        acknowledge(&root,"thread","mob","final").unwrap();
        assert!(read(&root,"thread","mob").unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unwritable_outbox_refuses_delivery() {
        let root = std::env::temp_dir().join(format!("delivery-blocked-{}",uuid::Uuid::new_v4()));
        std::fs::write(&root,b"blocked").unwrap();
        let scope = Attribution {state_root:root.clone(),thread_id:"thread".into(),mob_id:"mob".into(),session_id:"session".into(),run_id:"run".into()};
        let event = EventEmit {event_id:"final".into(),kind:"run.output.complete".into(),timestamp:chrono::Utc::now(),thread_id:Some("thread".into()),run_id:Some("run".into()),payload:json!({"text":"actual final"}),trace_id:"trace".into()};
        assert!(persist(&scope,&event).is_err());
        std::fs::remove_file(root).unwrap();
    }
}
