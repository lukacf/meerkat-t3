//! Read the pinned MobKit console acceptance record without admitting or replaying work.
use meerkat_mobkit::{ConsoleFrame, ConsoleTimelineInteractionAccepted as ConsoleInteractionAccepted};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

use crate::mobkit_registry::ConsoleExpectedTarget;
use crate::{console_expected_target, normalize_project_path, normalize_state_root_path,
    object_params, optional_string, required_mob_id, required_nonempty_string, stable_slug, GatewayError};

pub async fn read(params: Option<&Value>) -> Result<Value, GatewayError> {
    let params = object_params(params)?;
    let project = normalize_project_path(&required_nonempty_string(params, "projectPath")?)?;
    let state = optional_string(params, "stateRoot")
        .map(|value| normalize_state_root_path(&value)).transpose()?
        .unwrap_or_else(|| project.join(".rkat"));
    let mob_id = required_mob_id(params)?;
    let expected = console_expected_target(params)?;
    let key = required_nonempty_string(params, "idempotencyKey")?;
    let console_read = crate::mobkit_registry::storage_upgrade::read_console(
        &state.join("mobkit").join(stable_slug(&mob_id)),
    )?;
    tokio::task::spawn_blocking(move || {
        let console_read = console_read;
        let path = &console_read.path;
        let receipt = read_receipt(path, &expected, &key)?;
        Ok(match receipt {
            Some(receipt) => {
                let completion = read_completion(path, &expected, &receipt.interaction_id)?;
                json!({"mobId":mob_id,"identity":expected.identity,"found":true,"receipt":receipt,"completion":completion})
            },
            None => json!({"mobId":mob_id,"identity":expected.identity,"found":false}),
        })
    }).await.map_err(|error| receipt_error(error.to_string()))?
}

fn receipt_error(error: impl std::fmt::Display) -> GatewayError {
    GatewayError::policy("Cannot read native message acceptance", Some(json!({"error":error.to_string()})))
}

fn read_receipt(path: &Path, expected: &ConsoleExpectedTarget, key: &str) -> Result<Option<ConsoleInteractionAccepted>, GatewayError> {
    let session = expected.session_id.as_deref().ok_or_else(|| GatewayError::invalid("Receipt lookup needs its exact native session", None))?;
    if !path.is_file() { return Ok(None); }
    // This is the same pinned console frame decoder as native history. Opening
    // read-only avoids loading agents or migrating the store during recovery.
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(receipt_error)?;
    conn.busy_timeout(std::time::Duration::from_secs(2)).map_err(receipt_error)?;
    let dedupe = format!("send:{}:{}:meerkat-app:{}",expected.runtime_key,expected.identity,key);
    let frame: Option<ConsoleFrame> = conn.query_row(
        "SELECT cursor_seq,id,dedupe_key,timestamp_ms,runtime_key,identity,conversation_id,session_id,kind,status,frame_version,updated_at_ms,payload_json,source_kind,source_cursor,source_event_id,interaction_id,parent_frame_id,caused_by_frame_id,turn_id,run_id FROM console_frames WHERE dedupe_key=?1",
        [&dedupe], crate::native_history::decode_frame,
    ).optional().map_err(receipt_error)?;
    let Some(frame) = frame else { return Ok(None); };
    if frame.identity != expected.identity || frame.runtime_key != expected.runtime_key
        || frame.session_id.as_deref() != Some(session) || frame.kind != "user_input"
        || frame.payload.get("origin").and_then(Value::as_str) != Some("meerkat-app")
        || frame.payload.get("idempotency_key").and_then(Value::as_str) != Some(key) {
        return Err(GatewayError::conflict("Native acceptance belongs to a different message or session", None));
    }
    let interaction_id = frame.interaction_id.ok_or_else(|| GatewayError::conflict("Native acceptance has no interaction identity",None))?;
    Ok(Some(ConsoleInteractionAccepted {
        interaction_id, identity:frame.identity, conversation_id:frame.conversation_id,
        session_id:frame.session_id, input_frame_id:frame.id, cursor:frame.cursor, status:frame.status,
    }))
}

fn read_completion(path: &Path, expected: &ConsoleExpectedTarget, interaction: &str) -> Result<Option<ConsoleFrame>, GatewayError> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(receipt_error)?;
    conn.busy_timeout(std::time::Duration::from_secs(2)).map_err(receipt_error)?;
    // Match the exact accepted input's causal identity, including older frames
    // outside the recent activity page. Sessionless console events are valid
    // only with one unambiguous durable session anchor, as in native_history.
    conn.query_row(
        "SELECT cursor_seq,id,dedupe_key,timestamp_ms,runtime_key,identity,conversation_id,session_id,kind,status,frame_version,updated_at_ms,payload_json,source_kind,source_cursor,source_event_id,interaction_id,parent_frame_id,caused_by_frame_id,turn_id,run_id FROM console_frames f WHERE identity=?1 AND runtime_key=?2 AND interaction_id=?3 AND kind IN ('interaction_complete','interaction_failed') AND (session_id=?4 OR (session_id IS NULL AND EXISTS (SELECT 1 FROM console_frames a WHERE a.identity=f.identity AND a.runtime_key=f.runtime_key AND a.session_id=?4 AND a.interaction_id=f.interaction_id) AND NOT EXISTS (SELECT 1 FROM console_frames a WHERE a.identity=f.identity AND a.runtime_key=f.runtime_key AND a.session_id IS NOT NULL AND a.session_id!=?4 AND a.interaction_id=f.interaction_id))) AND COALESCE(json_extract(payload_json,'$.handling_mode'),'')!='steer' AND COALESCE(json_extract(payload_json,'$.reason'),'')!='steer_delivered' AND COALESCE(json_extract(payload_json,'$.source_event_type'),'')!='session_history' AND COALESCE(json_extract(payload_json,'$.type'),'')!='session_history' ORDER BY cursor_seq DESC LIMIT 1",
        rusqlite::params![expected.identity,expected.runtime_key,interaction,expected.session_id], crate::native_history::decode_frame,
    ).optional().map_err(receipt_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use meerkat_mobkit::{ConsoleFrameSource,ConsoleFrameSourceKind,ConsoleFrameStatus,ConsoleLogStore,NewConsoleFrame,SqliteConsoleLogStore};

    #[tokio::test]
    async fn cold_lookup_preserves_native_receipt_and_refuses_replacement_session() {
        let root = std::env::temp_dir().join(format!("native-receipt-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("console.sqlite");
        let expected = ConsoleExpectedTarget {identity:"reviewer".into(),runtime_key:"default".into(),runtime_member_id:"member".into(),session_id:Some("original".into()),source_mob_id:None};
        assert!(read_receipt(&path,&expected,"request").unwrap().is_none());
        assert!(!path.exists());
        let store = SqliteConsoleLogStore::open(&path).unwrap();
        let frame = store.append_if_absent(NewConsoleFrame {
            id:Some("input-frame".into()),dedupe_key:"send:default:reviewer:meerkat-app:request".into(),timestamp_ms:1,
            runtime_key:"default".into(),identity:"reviewer".into(),conversation_id:Some("reviewer".into()),
            session_id:Some("original".into()),kind:"user_input".into(),status:ConsoleFrameStatus::Delivered,
            payload:json!({"origin":"meerkat-app","idempotency_key":"request","content":"Review"}),
            source:ConsoleFrameSource{member_provenance: None,kind:ConsoleFrameSourceKind::Send,source_cursor:None},
            source_event_id:None,interaction_id:Some("interaction".into()),turn_id:None,run_id:None,parent_frame_id:None,caused_by_frame_id:None,
        }).await.unwrap().frame;
        assert!(read_completion(&path,&expected,"interaction").unwrap().is_none());
        for (index, session, interaction, reason) in [
            (2,None,"interaction",None),
            (3,None,"another",None),
            (4,None,"interaction",Some("steer_delivered")),
        ] {
            store.append_if_absent(NewConsoleFrame {
                id:Some(format!("completion-{index}")),dedupe_key:format!("completion-{index}"),timestamp_ms:index,
                runtime_key:"default".into(),identity:"reviewer".into(),conversation_id:Some("reviewer".into()),
                session_id:session.map(str::to_string),kind:"interaction_complete".into(),status:ConsoleFrameStatus::Completed,
                payload:json!({"result":"Done","reason":reason}),
                source:ConsoleFrameSource{member_provenance: None,kind:ConsoleFrameSourceKind::ConsoleEvent,source_cursor:None},
                source_event_id:None,interaction_id:Some(interaction.into()),turn_id:None,run_id:None,parent_frame_id:None,caused_by_frame_id:None,
            }).await.unwrap();
        }
        drop(store);
        let receipt = read_receipt(&path,&expected,"request").unwrap().unwrap();
        assert_eq!(receipt.input_frame_id,frame.id);
        assert_eq!(receipt.cursor,frame.cursor);
        assert_eq!(receipt.interaction_id,"interaction");
        assert_eq!(receipt.status,ConsoleFrameStatus::Delivered);
        assert_eq!(read_completion(&path,&expected,"interaction").unwrap().unwrap().id,"completion-2");
        assert!(read_completion(&path,&expected,"another").unwrap().is_none());
        assert!(read_receipt(&path,&expected,"absent").unwrap().is_none());
        let replacement = ConsoleExpectedTarget{session_id:Some("replacement".into()),..expected};
        assert!(read_receipt(&path,&replacement,"request").is_err());
        assert!(read_completion(&path,&replacement,"interaction").unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
