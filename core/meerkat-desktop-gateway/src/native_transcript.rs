//! A read-only view of committed native session messages, separate from events.
//! The native WholeBlob authority selects the body; the current native decoder
//! verifies its digest and session identity. No runtime is opened or admitted.
use crate::GatewayError;
use meerkat_core::{types::Message, Session, SessionId};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};

mod cache;

const MAX_DOCUMENT_BYTES: i64 = 64 * 1024 * 1024;
const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;

pub(crate) fn read_session(
    path: &Path,
    session_id: &str,
    expected_revision: Option<&str>,
) -> Result<Option<(Arc<Session>, String)>, GatewayError> {
    read_session_with_cache(path, session_id, expected_revision, cache::shared())
}

fn read_session_with_cache(
    path: &Path,
    session_id: &str,
    expected_revision: Option<&str>,
    cache: &cache::Store,
) -> Result<Option<(Arc<Session>, String)>, GatewayError> {
    let session_id = SessionId::parse(session_id)
        .map_err(|_| GatewayError::invalid("Invalid native transcript session", None))?;
    if !path.is_file() {
        return Ok(None);
    }
    let database = cache::Database::capture(path);
    let mut conn =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(read_error)?;
    conn.busy_timeout(std::time::Duration::from_secs(2))
        .map_err(read_error)?;
    let tx = conn.transaction().map_err(read_error)?;
    let has_authority: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='runtime_whole_blob_authority')",
        [], |row| row.get(0),
    ).map_err(read_error)?;
    if !has_authority {
        return Ok(None);
    }
    // WholeBlob is the explicit persistence profile composed by this app. A
    // migrated body is only a frozen predecessor, so never display it as head.
    let head_canonical: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM runtime_head_canonical_profile_pin UNION ALL SELECT 1 FROM runtime_session_authority UNION ALL SELECT 1 FROM runtime_head_canonical_activations)",
        [], |row| row.get(0),
    ).map_err(read_error)?;
    if head_canonical {
        return Err(GatewayError::conflict(
            "Saved transcript requires the native head-canonical reader",
            None,
        ));
    }
    let runtime = meerkat_runtime::identifiers::LogicalRuntimeId::for_session(&session_id);
    let row = tx.query_row(
        "SELECT a.authority_version,a.session_id,a.store_revision,a.blob_sha256,length(b.session_snapshot),CASE WHEN length(b.session_snapshot)<=?2 THEN b.session_snapshot END FROM runtime_whole_blob_authority a LEFT JOIN runtime_whole_blob_bodies b ON b.blob_sha256=a.blob_sha256 WHERE a.runtime_id=?1",
        rusqlite::params![runtime.0, MAX_DOCUMENT_BYTES],
        |row| Ok((row.get::<_,i64>(0)?, row.get::<_,String>(1)?, row.get::<_,i64>(2)?, row.get::<_,String>(3)?, row.get::<_,Option<i64>>(4)?, row.get::<_,Option<Vec<u8>>>(5)?)),
    ).optional().map_err(read_error)?;
    tx.rollback().map_err(read_error)?;
    if database
        .as_ref()
        .is_some_and(|database| !database.still_current(path))
    {
        return Err(GatewayError::conflict(
            "Native transcript database changed while reading. Refresh the conversation",
            None,
        ));
    }
    let Some((version, owner, revision, digest, length, bytes)) = row else {
        return Ok(None);
    };
    if version != 1 || revision < 1 || owner != session_id.to_string() {
        return Err(GatewayError::conflict(
            "Native transcript authority does not match this session",
            None,
        ));
    }
    if length.is_some_and(|length| length > MAX_DOCUMENT_BYTES) {
        return Err(GatewayError::conflict(
            "Saved native transcript exceeds the bounded reader size",
            None,
        ));
    }
    let bytes = bytes.ok_or_else(|| {
        GatewayError::conflict(
            "Native transcript authority references a missing body",
            None,
        )
    })?;
    // The cache never selects a body or trusts a digest alone. Each request
    // reads the current native authority and complete body above, then compares
    // those exact bytes with a previously validated immutable decode.
    let key = database
        .as_ref()
        .map(|database| database.key(&session_id, revision, &digest));
    let cached = key.as_ref().and_then(|key| {
        cache
            .lock()
            .ok()
            .and_then(|mut cache| cache.get(key, &bytes))
    });
    let session = if let Some(session) = cached {
        session
    } else {
        let session = decode(&bytes, &session_id, &digest)?;
        if let Some(key) = key {
            if let Ok(mut cache) = cache.lock() {
                cache.insert(key, bytes, Arc::clone(&session));
            }
        }
        session
    };
    let revision = revision.to_string();
    if expected_revision.is_some_and(|expected| expected != revision) {
        return Err(GatewayError::conflict(
            "Saved conversation changed. Refresh before loading older messages",
            None,
        ));
    }
    Ok(Some((session, revision)))
}

fn decode(
    bytes: &[u8],
    session_id: &SessionId,
    digest: &str,
) -> Result<Arc<Session>, GatewayError> {
    let decoded = Session::decode_whole_blob_document(bytes).map_err(|error| {
        GatewayError::conflict(
            "Native transcript cannot be decoded",
            Some(json!({"error":error.to_string()})),
        )
    })?;
    if decoded.row_sha256_token() != digest {
        return Err(GatewayError::conflict(
            "Native transcript body does not match its committed digest",
            None,
        ));
    }
    let session = decoded.into_session();
    if session.id() != session_id {
        return Err(GatewayError::conflict(
            "Native transcript body belongs to a different session",
            None,
        ));
    }
    Ok(Arc::new(session))
}

pub(crate) fn read(
    path: &Path,
    session_id: &str,
    limit: usize,
    before: Option<usize>,
    expected_revision: Option<&str>,
) -> Result<Option<Value>, GatewayError> {
    let Some((session, revision)) = read_session(path, session_id, expected_revision)? else {
        return Ok(None);
    };
    let end = before.unwrap_or(session.messages().len());
    if end > session.messages().len() {
        return Err(GatewayError::invalid(
            "Invalid native transcript message offset",
            None,
        ));
    }
    let visible = |message: &&Message| !matches!(message, Message::System(_));
    let total = session.messages().iter().filter(visible).count();
    let mut messages = Vec::new();
    let mut page_bytes = 0;
    let mut exhausted = true;
    for (offset, message) in session.messages()[..end]
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, message)| !matches!(message, Message::System(_)))
    {
        if messages.len() == limit.clamp(1, 100) {
            exhausted = false;
            break;
        }
        let mut entry = json!({"offset":offset,"message":message});
        // This is only the display serialization. The verified native body is
        // untouched; image bytes use the same content address as live events.
        crate::media::reference_inline_images(&mut entry["message"]);
        let entry_bytes = serde_json::to_vec(&entry)
            .map_err(|error| {
                GatewayError::policy(
                    "Cannot serialize committed native message",
                    Some(json!({"error":error.to_string()})),
                )
            })?
            .len();
        if page_bytes + entry_bytes > MAX_PAGE_BYTES {
            if messages.is_empty() {
                return Err(GatewayError::conflict(
                    "One saved native message exceeds the bounded page size",
                    None,
                ));
            }
            exhausted = false;
            break;
        }
        page_bytes += entry_bytes;
        messages.push(entry);
    }
    messages.reverse();
    let next_before = messages.first().and_then(|entry| entry["offset"].as_u64());
    let mut result = json!({"sessionId":session_id.to_string(),"storeRevision":revision,"messages":messages,"totalMessages":total,"exhausted":exhausted});
    if !exhausted {
        result["nextBefore"] = json!(next_before);
    }
    Ok(Some(result))
}

fn read_error(error: rusqlite::Error) -> GatewayError {
    GatewayError::policy(
        "Cannot read committed native messages",
        Some(json!({"error":error.to_string()})),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use sha2::{Digest, Sha256};

    #[test]
    fn committed_messages_are_exact_paged_and_read_only() {
        let root = std::env::temp_dir().join(format!("native-transcript-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("runtime.sqlite");
        let mut session = Session::new();
        let image = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nimage");
        for message in [
            json!({"role":"system","content":"private instructions"}),
            json!({"role":"user","content":"original task"}),
            json!({"role":"block_assistant","blocks":[{"block_type":"text","data":{"text":"original answer"}}]}),
            json!({"role":"user","content":[{"type":"image","media_type":"image/png","source":"inline","data":image}]}),
            json!({"role":"user","content":"second task"}),
        ] {
            session.push(serde_json::from_value(message).unwrap());
        }
        let session_id = session.id().to_string();
        let bytes = serde_json::to_vec(&session).unwrap();
        let digest = format!("row-sha256:{:x}", Sha256::digest(&bytes));
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE runtime_whole_blob_authority(runtime_id TEXT PRIMARY KEY,authority_version INTEGER,session_id TEXT,store_revision INTEGER,blob_sha256 TEXT); CREATE TABLE runtime_whole_blob_bodies(blob_sha256 TEXT PRIMARY KEY,session_snapshot BLOB); CREATE TABLE runtime_head_canonical_profile_pin(singleton INTEGER); CREATE TABLE runtime_session_authority(runtime_id TEXT); CREATE TABLE runtime_head_canonical_activations(runtime_id TEXT);").unwrap();
        conn.execute(
            "INSERT INTO runtime_whole_blob_authority VALUES(?1,1,?2,7,?3)",
            rusqlite::params![
                meerkat_runtime::identifiers::LogicalRuntimeId::for_session(session.id()).0,
                session_id,
                digest
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO runtime_whole_blob_bodies VALUES(?1,?2)",
            rusqlite::params![digest, bytes],
        )
        .unwrap();
        drop(conn);
        let original = std::fs::read(&path).unwrap();
        let page = read(&path, &session_id, 1, None, None).unwrap().unwrap();
        assert_eq!(page["messages"][0]["message"]["content"], "second task");
        assert_eq!(page["totalMessages"], 4);
        assert_eq!(page["nextBefore"], 4);
        let image_page = read(&path, &session_id, 1, Some(4), Some("7"))
            .unwrap()
            .unwrap();
        let projected_image = &image_page["messages"][0]["message"]["content"][0];
        assert_eq!(projected_image["source"], "blob");
        assert_eq!(
            projected_image["blob_id"],
            json!(meerkat_core::blob::content_blob_id("image/png", &image))
        );
        assert!(projected_image.get("data").is_none());
        let older = read(&path, &session_id, 2, Some(3), Some("7"))
            .unwrap()
            .unwrap();
        assert_eq!(
            older["messages"][0]["message"],
            serde_json::to_value(&session.messages()[1]).unwrap()
        );
        assert_eq!(
            older["messages"][1]["message"],
            serde_json::to_value(&session.messages()[2]).unwrap()
        );
        assert_eq!(older["exhausted"], true);
        assert!(read(&path, &session_id, 2, Some(3), Some("6")).is_err());
        assert!(read(&path, &SessionId::new().to_string(), 2, None, None)
            .unwrap()
            .is_none());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE runtime_whole_blob_bodies SET session_snapshot=?1",
            [b"{}".as_slice()],
        )
        .unwrap();
        drop(conn);
        assert!(read(&path, &session_id, 2, None, None).is_err());
        let mut oversized = session.clone();
        oversized.push(
            serde_json::from_value(json!({"role":"user","content":"x".repeat(MAX_PAGE_BYTES)}))
                .unwrap(),
        );
        let bytes = serde_json::to_vec(&oversized).unwrap();
        let digest = format!("row-sha256:{:x}", Sha256::digest(&bytes));
        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE runtime_whole_blob_authority SET blob_sha256=?1",
            [&digest],
        )
        .unwrap();
        conn.execute("DELETE FROM runtime_whole_blob_bodies", [])
            .unwrap();
        conn.execute(
            "INSERT INTO runtime_whole_blob_bodies VALUES(?1,?2)",
            rusqlite::params![digest, bytes],
        )
        .unwrap();
        drop(conn);
        let error = read(&path, &session_id, 100, None, None).unwrap_err();
        assert!(error.to_string().contains("bounded page size"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
