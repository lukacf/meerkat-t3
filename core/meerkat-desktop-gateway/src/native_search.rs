//! Read-only search of a verified committed session. No runtime is admitted.
use crate::{
    GatewayError, console_expected_target, normalize_project_path, normalize_state_root_path,
    object_params, optional_string, required_mob_id, required_nonempty_string, stable_slug,
};
use serde_json::{Value, json};

pub(crate) async fn search(params: Option<&Value>) -> Result<Value, GatewayError> {
    let params = object_params(params)?;
    let project = normalize_project_path(&required_nonempty_string(params, "projectPath")?)?;
    let state = optional_string(params, "stateRoot")
        .map(|value| normalize_state_root_path(&value))
        .transpose()?
        .unwrap_or_else(|| project.join(".rkat"));
    let mob_id = required_mob_id(params)?;
    let expected = console_expected_target(params)?;
    let query = required_nonempty_string(params, "query")?;
    let query = query.trim().to_owned();
    if !(2..=200).contains(&query.chars().count()) {
        return Err(GatewayError::invalid(
            "Search query must contain 2-200 characters",
            None,
        ));
    }
    let session_id = expected
        .session_id
        .ok_or_else(|| GatewayError::conflict("Agent has no recorded native session", None))?;
    let path = state
        .join("mobkit")
        .join(stable_slug(&mob_id))
        .join("runtime.sqlite");
    tokio::task::spawn_blocking(move || {
        let Some((session, revision)) = crate::native_transcript::read_session(&path, &session_id, None)? else {
            return Err(GatewayError::conflict("Saved native messages are unavailable", None));
        };
        for (offset, message) in session.messages().iter().enumerate().rev() {
            let value = serde_json::to_value(message).map_err(|error| GatewayError::policy("Cannot read saved native message", Some(json!({"error":error.to_string()}))))?;
            if let Some((source, text)) = message_text(&value) {
                if let Some(snippet) = excerpt(&text, &query) {
                    return Ok(json!({"match":{"sessionId":session_id,"storeRevision":revision,"offset":offset,"source":source,"snippet":snippet}}));
                }
            }
        }
        Ok(json!({"match":null}))
    }).await.map_err(|error| GatewayError::policy("Native search failed", Some(json!({"error":error.to_string()}))))?
}

fn message_text(value: &Value) -> Option<(&'static str, String)> {
    let source = match value["role"].as_str()? {
        "user" => "user",
        "assistant" | "block_assistant" => "assistant",
        _ => return None,
    };
    let text = if let Some(text) = value["content"].as_str() {
        text.to_owned()
    } else {
        value["blocks"]
            .as_array()
            .or_else(|| value["content"].as_array())?
            .iter()
            .filter_map(|block| {
                let kind = block["block_type"]
                    .as_str()
                    .or_else(|| block["type"].as_str())?;
                if kind != "text" {
                    return None;
                }
                block["text"]
                    .as_str()
                    .or_else(|| block["data"]["text"].as_str())
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    Some((source, text))
}

fn excerpt(text: &str, query: &str) -> Option<String> {
    let folded = text.to_lowercase();
    let at = folded.find(&query.to_lowercase())?;
    // Map expansions such as dotted capital I back to the original character.
    let mut folded_bytes = 0;
    let char_at = text
        .chars()
        .position(|character| {
            folded_bytes += character.to_lowercase().map(char::len_utf8).sum::<usize>();
            folded_bytes > at
        })
        .unwrap_or(0);
    let chars: Vec<char> = text.chars().collect();
    let start = char_at.saturating_sub(55).min(chars.len());
    // The wire contract's length is in UTF-16 code units (JavaScript strings).
    let mut units = 0;
    let mut taken = 0;
    let mut snippet: String = chars[start..]
        .iter()
        .take_while(|character| {
            units += character.len_utf16();
            if units > 230 {
                false
            } else {
                taken += 1;
                true
            }
        })
        .collect();
    if start > 0 {
        snippet.insert_str(0, "...");
    }
    if start + taken < chars.len() {
        snippet.push_str("...");
    }
    Some(snippet)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn searches_visible_messages_without_reasoning_tools_or_system_text() {
        assert!(message_text(&json!({"role":"system","content":"secret"})).is_none());
        assert!(message_text(&json!({"role":"tool","content":"secret"})).is_none());
        let (_, text) = message_text(&json!({"role":"block_assistant","blocks":[
            {"block_type":"thinking","data":{"text":"private"}},
            {"block_type":"text","data":{"text":"Public reply"}},
            {"block_type":"tool_use","data":{"text":"tool arguments"}}
        ]}))
        .unwrap();
        assert_eq!(text, "Public reply");
        assert_eq!(excerpt(&text, "REPLY"), Some("Public reply".into()));
        assert_eq!(
            excerpt("Find 100% literal", "100%"),
            Some("Find 100% literal".into())
        );
        assert!(
            excerpt("🙂".repeat(100).as_str(), "🙂🙂")
                .unwrap()
                .chars()
                .count()
                <= 240
        );
    }
    #[tokio::test]
    async fn search_reads_cold_committed_authority_without_mutation() {
        use meerkat_core::Session;
        use rusqlite::Connection;
        use sha2::{Digest, Sha256};
        let root = std::env::temp_dir().join(format!("native-search-{}", uuid::Uuid::new_v4()));
        let state = root.join("state");
        let database_dir = state.join("mobkit").join(stable_slug("mob"));
        std::fs::create_dir_all(&database_dir).unwrap();
        let path = database_dir.join("runtime.sqlite");
        let mut session = Session::new();
        for message in [
            json!({"role":"system","content":"private needle"}),
            json!({"role":"user","content":"old needle request"}),
            json!({"role":"block_assistant","blocks":[{"block_type":"text","data":{"text":"review needle result"}}]}),
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
        let mut params = json!({"projectPath":root.to_string_lossy(),"stateRoot":state.to_string_lossy(),"mobId":"mob","query":"needle", "expected":{"identity":"reviewer","runtimeKey":"default","runtimeMemberId":"reviewer-member","sessionId":session_id,"sourceMobId":null}});
        let result = search(Some(&params)).await.unwrap();
        assert_eq!(result["match"]["sessionId"], session_id);
        assert_eq!(result["match"]["storeRevision"], "7");
        assert_eq!(result["match"]["offset"], 2);
        assert_eq!(result["match"]["snippet"], "review needle result");
        params["query"] = json!("private needle");
        assert_eq!(search(Some(&params)).await.unwrap()["match"], Value::Null);
        params["expected"]["sessionId"] = json!(meerkat_core::SessionId::new().to_string());
        assert!(search(Some(&params)).await.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(std::fs::read_dir(&database_dir).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
