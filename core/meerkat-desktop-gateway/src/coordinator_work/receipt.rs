//! Read-only projection of canonical runtime steering admission.
//! No console frame, runtime activation, migration, or input replay is involved.
use super::failure;
use crate::mobkit_registry::ConsoleExpectedTarget;
use crate::{console_expected_target, object_params, required_nonempty_string, GatewayError};
use meerkat_core::{InputId, SessionId};
use meerkat_runtime::{identifiers::LogicalRuntimeId, input_state::StoredInputState};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

pub(super) fn native_key(
    mob: &str,
    expected: &ConsoleExpectedTarget,
    request: &str,
) -> Result<String, GatewayError> {
    let encoded = serde_json::to_vec(&(
        mob,
        &expected.runtime_key,
        &expected.identity,
        &expected.runtime_member_id,
        &expected.session_id,
        &expected.source_mob_id,
        request,
    ))
    .map_err(failure)?;
    Ok(format!(
        "meerkat-app:coordinator-steer:v1:{:x}",
        Sha256::digest(encoded)
    ))
}

pub(super) fn accepted(
    expected: &ConsoleExpectedTarget,
    session: &SessionId,
    input: &InputId,
    request: &str,
    native_key: &str,
) -> Value {
    json!({
        "kind":"runtime_input", "status":"accepted", "identity":expected.identity,
        "sessionId":session, "inputId":input, "requestId":request, "idempotencyKey":native_key,
    })
}

pub(crate) async fn read(params: Option<&Value>) -> Result<Value, GatewayError> {
    let object = object_params(params)?;
    let project = crate::normalize_project_path(&required_nonempty_string(object, "projectPath")?)?;
    let state = crate::optional_string(object, "stateRoot")
        .map(|value| crate::normalize_state_root_path(&value))
        .transpose()?
        .unwrap_or_else(|| project.join(".rkat"));
    let mob = crate::required_mob_id(object)?;
    let expected = console_expected_target(object)?;
    let request = required_nonempty_string(object, "idempotencyKey")?;
    let session = SessionId::parse(
        expected
            .session_id
            .as_deref()
            .ok_or_else(|| failure("Receipt lookup needs the original native session"))?,
    )
    .map_err(failure)?;
    let key = native_key(&mob, &expected, &request)?;
    let path = state
        .join("mobkit")
        .join(crate::stable_slug(&mob))
        .join("runtime.sqlite");
    let receipt = tokio::task::spawn_blocking(move || {
        read_input(&path, &session, &key)
            .map(|input| input.map(|input| accepted(&expected, &session, &input, &request, &key)))
    })
    .await
    .map_err(failure)??;
    if let Some(receipt) = receipt {
        return Ok(json!({"found":true,"receipt":receipt}));
    }
    // Previously accepted releases used the native MobKit console receipt.
    // Reading it preserves response-loss recovery without resending anything.
    crate::native_receipt::read(params).await
}

pub(crate) fn read_input(
    path: &Path,
    session: &SessionId,
    key: &str,
) -> Result<Option<InputId>, GatewayError> {
    if !path.is_file() {
        return Ok(None);
    }
    let mut connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(failure)?;
    connection
        .busy_timeout(std::time::Duration::from_secs(2))
        .map_err(failure)?;
    let tx = connection.transaction().map_err(failure)?;
    let runtime = LogicalRuntimeId::for_session(session).to_string();
    // The maintained index and its source row are observed in one snapshot.
    // Any unindexable evidence prevents a guessed miss and possible replay.
    let uncertain = tx
        .query_row(
            "SELECT 1 FROM runtime_input_idempotency_unindexable_rows WHERE runtime_id=?1 LIMIT 1",
            [&runtime],
            |_| Ok(()),
        )
        .optional()
        .map_err(failure)?
        .is_some();
    if uncertain {
        return Err(failure("Native steering receipt index is uncertain"));
    }
    let row = tx.query_row(
        "SELECT k.input_id,s.state_json FROM runtime_input_idempotency_keys k LEFT JOIN runtime_input_states s ON s.runtime_id=k.runtime_id AND s.input_id=k.input_id WHERE k.runtime_id=?1 AND k.idempotency_key=?2",
        rusqlite::params![runtime,key], |row| {
            let id: String = row.get(0)?;
            let bytes = match row.get_ref(1)? {
                rusqlite::types::ValueRef::Text(bytes) | rusqlite::types::ValueRef::Blob(bytes) => Some(bytes.to_vec()),
                _ => None,
            };
            Ok((id,bytes))
        },
    ).optional().map_err(failure)?;
    let Some((id, bytes)) = row else {
        return Ok(None);
    };
    let bytes = bytes.ok_or_else(|| failure("Native steering receipt lost its source input"))?;
    // Use the released version-aware native decoder, never infer admission
    // or success from model text or a mutable session status.
    let stored: StoredInputState = serde_json::from_slice(&bytes).map_err(failure)?;
    if stored.state.input_id.to_string() != id
        || stored
            .state
            .idempotency_key
            .as_ref()
            .map(|value| value.0.as_str())
            != Some(key)
        || stored.state.prompt_replay_identity.is_none()
    {
        return Err(failure(
            "Native steering receipt does not match its admitted input",
        ));
    }
    Ok(Some(stored.state.input_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use meerkat_runtime::{MeerkatMachine, SessionServiceRuntimeExt};
    use std::sync::Arc;

    fn expected(session: &SessionId) -> ConsoleExpectedTarget {
        ConsoleExpectedTarget {
            identity: "ingress".into(),
            runtime_key: "default".into(),
            runtime_member_id: "ingress".into(),
            session_id: Some(session.to_string()),
            source_mob_id: None,
        }
    }

    #[tokio::test]
    async fn cold_receipt_reads_native_admission_and_rejects_uncertain_index() {
        let root =
            std::env::temp_dir().join(format!("native-steer-receipt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("runtime.sqlite");
        let session = SessionId::new();
        let expected = expected(&session);
        let key = native_key("mob-a", &expected, "request-a").unwrap();
        assert!(read_input(&path, &session, &key).unwrap().is_none());
        assert!(!path.exists());
        let store = Arc::new(meerkat_runtime::store::SqliteRuntimeStore::new(&path).unwrap());
        let machine = MeerkatMachine::persistent_without_blobs(store);
        machine.register_session(session.clone()).await.unwrap();
        let input = super::super::steer_input("Resume with this instruction".into(), key.clone());
        let input_id = input.id().clone();
        machine.accept_input(&session, input).await.unwrap();
        drop(machine);
        assert_eq!(read_input(&path, &session, &key).unwrap(), Some(input_id));
        assert!(read_input(&path, &SessionId::new(), &key)
            .unwrap()
            .is_none());
        assert!(read_input(&path, &session, "another-key")
            .unwrap()
            .is_none());
        let connection = Connection::open(&path).unwrap();
        connection.execute("INSERT INTO runtime_input_idempotency_unindexable_rows(runtime_id,input_id,reason) VALUES (?1,?2,?3)",
            rusqlite::params![LogicalRuntimeId::for_session(&session).to_string(),"invalid-input","fixture uncertainty"]).unwrap();
        assert!(read_input(&path, &session, &key).is_err());
        drop(connection);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_key_binds_every_addressing_fact() {
        let session = SessionId::new();
        let original = expected(&session);
        let key = native_key("mob", &original, "request").unwrap();
        for changed in [
            ConsoleExpectedTarget {
                identity: "replacement".into(),
                ..original.clone()
            },
            ConsoleExpectedTarget {
                runtime_key: "replacement".into(),
                ..original.clone()
            },
            ConsoleExpectedTarget {
                runtime_member_id: "replacement".into(),
                ..original.clone()
            },
            ConsoleExpectedTarget {
                session_id: Some(SessionId::new().to_string()),
                ..original.clone()
            },
            ConsoleExpectedTarget {
                source_mob_id: Some("child".into()),
                ..original.clone()
            },
        ] {
            assert_ne!(native_key("mob", &changed, "request").unwrap(), key);
        }
        assert_ne!(
            native_key("replacement", &original, "request").unwrap(),
            key
        );
        assert_ne!(native_key("mob", &original, "replacement").unwrap(), key);
    }
}
