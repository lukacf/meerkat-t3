//! Consumer-owned attribution for desktop inputs and read-only native follow-up replay.
//! This journal excludes exact desktop-observed completions; it never owns agent work.
use crate::mobkit_registry::ConsoleExpectedTarget;
use crate::{
    native_history, normalize_project_path, normalize_state_root_path, object_params,
    optional_string, required_nonempty_string, stable_slug, GatewayError,
};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

static JOURNAL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug)]
pub(crate) struct Attribution {
    pub state_root: PathBuf,
    pub thread_id: String,
    pub mob_id: String,
    pub session_id: String,
    pub run_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u32,
    thread_id: String,
    mob_id: String,
    session_id: String,
    needs_baseline: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    start_after_cursor: Option<i64>,
    #[serde(default)]
    excluded_source_event_ids: BTreeSet<String>,
    #[serde(default)]
    pending_run_ids: BTreeSet<String>,
}

fn journal_path(state: &Path, thread: &str, mob: &str) -> PathBuf {
    let digest = Sha256::digest(format!("{thread}\0{mob}").as_bytes());
    state
        .join("thread-followups")
        .join(format!("{digest:x}.json"))
}
fn io_error(error: impl std::fmt::Display) -> GatewayError {
    GatewayError::policy(
        "Native follow-up attribution is unavailable",
        Some(json!({"error":error.to_string()})),
    )
}
fn load(path: &Path) -> Result<Option<Journal>, GatewayError> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(io_error),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(error)),
    }
}
fn save(path: &Path, journal: &Journal) -> Result<(), GatewayError> {
    let parent = path
        .parent()
        .ok_or_else(|| io_error("journal has no parent"))?;
    std::fs::create_dir_all(parent).map_err(io_error)?;
    let temp = parent.join(format!(".attribution-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)?;
        file.write_all(&serde_json::to_vec(journal)?)?;
        file.sync_all()?;
        std::fs::rename(&temp, path)?;
        std::fs::File::open(parent)?.sync_all()?;
        Ok::<_, Box<dyn std::error::Error>>(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result.map_err(io_error)
}
fn validate(journal: &Journal, attribution: &Attribution) -> Result<(), GatewayError> {
    if journal.version != 1
        || journal.thread_id != attribution.thread_id
        || journal.mob_id != attribution.mob_id
        || journal.session_id != attribution.session_id
        || journal.start_after_cursor.is_some_and(|cursor| cursor < 0)
    {
        return Err(GatewayError::conflict(
            "Native follow-up session attribution changed",
            None,
        ));
    }
    Ok(())
}

fn current_console_cursor(attribution: &Attribution) -> Result<i64, GatewayError> {
    let console = attribution
        .state_root
        .join("mobkit")
        .join(stable_slug(&attribution.mob_id))
        .join("console.sqlite");
    if !console.is_file() {
        return Ok(0);
    }
    let conn =
        Connection::open_with_flags(console, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(io_error)?;
    conn.busy_timeout(std::time::Duration::from_secs(2))
        .map_err(io_error)?;
    conn.query_row(
        "SELECT COALESCE(MAX(cursor_seq),0) FROM console_frames WHERE identity='ingress' AND runtime_key='default' AND session_id=?1",
        [&attribution.session_id],
        |row| row.get(0),
    )
    .map_err(io_error)
}

pub(crate) fn begin(attribution: &Attribution) -> Result<(), GatewayError> {
    let _lock = JOURNAL_LOCK.lock().map_err(io_error)?;
    let path = journal_path(
        &attribution.state_root,
        &attribution.thread_id,
        &attribution.mob_id,
    );
    let mut journal = match load(&path)? {
        Some(mut journal) if journal.session_id == attribution.session_id => {
            validate(&journal, attribution)?;
            if journal.needs_baseline && journal.pending_run_ids.is_empty() {
                journal.start_after_cursor = Some(current_console_cursor(attribution)?);
                journal.needs_baseline = false;
            }
            journal
        }
        _ => {
            // Before the first observed input, native history has no reliable
            // app/peer attribution. Start at its exact durable cursor so future
            // replies work without replaying old app messages. Recovering prior
            // missing replies requires an audited journal with no cutoff.
            Journal {
                version: 1,
                thread_id: attribution.thread_id.clone(),
                mob_id: attribution.mob_id.clone(),
                session_id: attribution.session_id.clone(),
                needs_baseline: false,
                start_after_cursor: Some(current_console_cursor(attribution)?),
                excluded_source_event_ids: BTreeSet::new(),
                pending_run_ids: BTreeSet::new(),
            }
        }
    };
    journal.pending_run_ids.insert(attribution.run_id.clone());
    save(&path, &journal)
}

pub(crate) fn record(attribution: &Attribution, source_event_id: &str) -> Result<(), GatewayError> {
    let _lock = JOURNAL_LOCK.lock().map_err(io_error)?;
    let path = journal_path(
        &attribution.state_root,
        &attribution.thread_id,
        &attribution.mob_id,
    );
    let mut journal = load(&path)?.ok_or_else(|| io_error("missing input attribution"))?;
    validate(&journal, attribution)?;
    if !journal.pending_run_ids.contains(&attribution.run_id) {
        return Err(io_error("input is not pending"));
    }
    journal
        .excluded_source_event_ids
        .insert(source_event_id.to_string());
    save(&path, &journal)
}
pub(crate) fn finish(attribution: &Attribution) -> Result<(), GatewayError> {
    let _lock = JOURNAL_LOCK.lock().map_err(io_error)?;
    let path = journal_path(
        &attribution.state_root,
        &attribution.thread_id,
        &attribution.mob_id,
    );
    let mut journal = load(&path)?.ok_or_else(|| io_error("missing input attribution"))?;
    validate(&journal, attribution)?;
    journal.pending_run_ids.remove(&attribution.run_id);
    save(&path, &journal)
}

/// Resolve only the persisted current ingress binding. Stored bridge references
/// are replay-only fields, so decode the pinned v9 journal shape explicitly and
/// refuse unknown versions instead of opening a mob store that migrates it.
fn persisted_session(path: &Path, mob_id: &str) -> Result<Option<String>, GatewayError> {
    if !path.is_file() {
        return Ok(None);
    }
    let conn =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(io_error)?;
    conn.busy_timeout(std::time::Duration::from_secs(2))
        .map_err(io_error)?;
    let mut stmt = conn
        .prepare("SELECT event_json FROM mob_events WHERE mob_id=?1 ORDER BY cursor DESC")
        .map_err(io_error)?;
    let rows = stmt
        .query_map([mob_id], |row| row.get::<_, Vec<u8>>(0))
        .map_err(io_error)?;
    for row in rows {
        let encoded: Value = serde_json::from_slice(&row.map_err(io_error)?).map_err(io_error)?;
        if encoded["schema_version"] != 9 {
            return Err(io_error("unsupported native mob event version"));
        }
        let event = &encoded["event"];
        if event["mob_id"] != mob_id {
            return Err(io_error("native mob ownership mismatch"));
        }
        let kind = &event["kind"];
        if kind["agent_identity"] != "ingress" {
            continue;
        }
        match kind["type"].as_str() {
            Some("member_retired") => return Ok(None),
            Some("member_spawned" | "member_session_binding_recovered") => {
                return kind
                    .get("bridge_session_id")
                    .or_else(|| kind["bridge_member_ref"].get("bridge_session_id"))
                    .and_then(Value::as_str)
                    .map(|session| {
                        meerkat_core::SessionId::parse(session)
                            .map(|_| Some(session.to_string()))
                            .map_err(io_error)
                    })
                    .unwrap_or_else(|| Err(io_error("native ingress has no session binding")));
            }
            _ => {}
        }
    }
    Ok(None)
}

pub(crate) async fn read(
    params: Option<&Value>,
    active_run_ids: BTreeSet<String>,
) -> Result<Value, GatewayError> {
    let params = object_params(params)?;
    let project = normalize_project_path(&required_nonempty_string(params, "projectPath")?)?;
    let state = optional_string(params, "stateRoot")
        .map(|path| normalize_state_root_path(&path))
        .transpose()?
        .unwrap_or_else(|| project.join(".rkat"));
    let thread = required_nonempty_string(params, "threadId")?;
    let mob = required_nonempty_string(params, "mobId")?;
    let after = params
        .get("after")
        .map(|cursor| {
            cursor
                .as_str()
                .and_then(|cursor| cursor.strip_prefix("console:"))
                .filter(|cursor| {
                    !cursor.is_empty() && cursor.bytes().all(|byte| byte.is_ascii_digit())
                })
                .and_then(|x| x.parse::<i64>().ok())
                .ok_or_else(|| GatewayError::invalid("Invalid follow-up cursor", None))
        })
        .transpose()?;
    tokio::task::spawn_blocking(move || {
        let mut result = read_blocking(&state, &thread, &mob, after)?;
        if result["status"] == "paused" {
            let journal = load(&journal_path(&state, &thread, &mob))?
                .ok_or_else(|| io_error("missing pending journal"))?;
            if journal.pending_run_ids.is_disjoint(&active_run_ids) {
                result["status"] = json!("needs_recovery");
            }
        }
        Ok(result)
    })
    .await
    .map_err(io_error)?
}
fn read_blocking(
    state: &Path,
    thread: &str,
    mob: &str,
    after: Option<i64>,
) -> Result<Value, GatewayError> {
    let _lock = JOURNAL_LOCK.lock().map_err(io_error)?;
    let mob_root = state.join("mobkit").join(stable_slug(mob));
    let Some(session) = persisted_session(&mob_root.join("mob.sqlite"), mob)? else {
        return Ok(json!({"status":"unavailable","frames":[],"exhausted":true}));
    };
    let Some(journal) = load(&journal_path(state, thread, mob))? else {
        return Ok(
            json!({"status":"needs_baseline","sessionId":session,"frames":[],"exhausted":true}),
        );
    };
    validate(
        &journal,
        &Attribution {
            state_root: state.into(),
            thread_id: thread.into(),
            mob_id: mob.into(),
            session_id: session.clone(),
            run_id: String::new(),
        },
    )?;
    if !journal.pending_run_ids.is_empty() {
        return Ok(json!({"status":"paused","sessionId":session,"frames":[],"exhausted":true}));
    }
    if journal.needs_baseline {
        return Ok(
            json!({"status":"needs_baseline","sessionId":session,"frames":[],"exhausted":true}),
        );
    }
    let expected = ConsoleExpectedTarget {
        identity: "ingress".into(),
        runtime_key: "default".into(),
        runtime_member_id: "ingress".into(),
        session_id: Some(session.clone()),
        source_mob_id: None,
    };
    let page = native_history::read_log(
        &mob_root.join("console.sqlite"),
        &expected,
        100,
        None,
        after.max(journal.start_after_cursor),
        true,
    )?;
    let frames = page["frames"]
        .as_array()
        .ok_or_else(|| io_error("invalid native frame page"))?
        .iter()
        .filter(|frame| {
            frame["session_id"] == session
                && frame["status"] == "completed"
                && frame["source"]["kind"] == "console_event"
                && matches!(
                    frame["payload"]["source_event_type"].as_str(),
                    Some("run_completed" | "interaction_complete")
                )
                && frame["source_event_id"]
                    .as_str()
                    .is_some_and(|id| !journal.excluded_source_event_ids.contains(id))
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut result =
        json!({"status":"ready","sessionId":session,"frames":frames,"exhausted":page["exhausted"]});
    if let Some(cursor) = page["next_cursor"].as_str() {
        result["nextCursor"] = json!(cursor);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use meerkat_mobkit::{
        ConsoleFrameSource, ConsoleFrameSourceKind, ConsoleFrameStatus, ConsoleLogStore,
        NewConsoleFrame, SqliteConsoleLogStore,
    };

    fn root() -> PathBuf {
        let path = std::env::temp_dir().join(format!("thread-followups-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(path.join("mobkit/mob")).unwrap();
        path
    }
    fn binding(root: &Path, session: &str) {
        let conn = Connection::open(root.join("mobkit/mob/mob.sqlite")).unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS mob_events(cursor INTEGER PRIMARY KEY,mob_id TEXT,event_json BLOB)").unwrap();
        conn.execute("INSERT INTO mob_events(mob_id,event_json) VALUES('mob',?1)", [serde_json::to_vec(&json!({"schema_version":9,"event":{"mob_id":"mob","kind":{"type":"member_spawned","agent_identity":"ingress","bridge_member_ref":{"kind":"session","bridge_session_id":session}}}})).unwrap()]).unwrap();
    }
    fn attribution(root: &Path, session: &str) -> Attribution {
        Attribution {
            state_root: root.into(),
            thread_id: "thread".into(),
            mob_id: "mob".into(),
            session_id: session.into(),
            run_id: "app-run".into(),
        }
    }
    async fn frame(store: &SqliteConsoleLogStore, id: &str, session: Option<&str>, text: &str) {
        store.append_if_absent(NewConsoleFrame{id:Some(id.into()),dedupe_key:id.into(),timestamp_ms:1,runtime_key:"default".into(),identity:"ingress".into(),conversation_id:Some("ingress".into()),session_id:session.map(str::to_string),kind:"interaction_complete".into(),status:ConsoleFrameStatus::Completed,payload:json!({"source_event_type":"run_completed","type":"run_completed","result":text}),source:ConsoleFrameSource{member_provenance: None,kind:ConsoleFrameSourceKind::ConsoleEvent,source_cursor:None},source_event_id:Some(id.into()),interaction_id:None,turn_id:None,run_id:None,parent_frame_id:None,caused_by_frame_id:None}).await.unwrap();
    }
    #[tokio::test]
    async fn follows_exact_native_completions_after_app_turn_without_replay_duplicates() {
        let root = root();
        let session = meerkat_core::SessionId::new().to_string();
        binding(&root, &session);
        let store = SqliteConsoleLogStore::open(root.join("mobkit/mob/console.sqlite")).unwrap();
        let a = attribution(&root, &session);
        begin(&a).unwrap();
        frame(&store, "evt-agent-app", Some(&session), "same reply").await;
        frame(&store, "evt-agent-peer1", Some(&session), "same reply").await;
        frame(&store, "evt-agent-peer2", Some(&session), "same reply").await;
        frame(&store, "foreign", Some("another-session"), "foreign reply").await;
        frame(&store, "unattributed", None, "unattributed reply").await;
        assert_eq!(
            read_blocking(&root, "thread", "mob", None).unwrap()["status"],
            "paused"
        );
        record(&a, "evt-agent-app").unwrap();
        finish(&a).unwrap();
        let page = read_blocking(&root, "thread", "mob", None).unwrap();
        assert_eq!(page["status"], "ready");
        let ids = page["frames"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["source_event_id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(ids, ["evt-agent-peer1", "evt-agent-peer2"]);
        assert_eq!(
            read_blocking(&root, "thread", "mob", None).unwrap(),
            page,
            "cold replay retains exact stable identities"
        );
        let after = page["nextCursor"]
            .as_str()
            .unwrap()
            .strip_prefix("console:")
            .unwrap()
            .parse()
            .unwrap();
        assert!(
            read_blocking(&root, "thread", "mob", Some(after)).unwrap()["frames"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn legacy_history_starts_future_observation_on_next_explicit_input() {
        let root = root();
        let session = meerkat_core::SessionId::new().to_string();
        binding(&root, &session);
        let store = SqliteConsoleLogStore::open(root.join("mobkit/mob/console.sqlite")).unwrap();
        frame(&store, "existing", Some(&session), "already shown").await;
        assert_eq!(
            read_blocking(&root, "thread", "mob", None).unwrap()["status"],
            "needs_baseline"
        );
        assert!(!root.join("thread-followups").exists());
        let a = attribution(&root, &session);
        begin(&a).unwrap();
        let initial_cursor = load(&journal_path(&root, "thread", "mob"))
            .unwrap()
            .unwrap()
            .start_after_cursor
            .unwrap();
        assert!(initial_cursor > 0);
        frame(&store, "app", Some(&session), "new app response").await;
        record(&a, "app").unwrap();
        finish(&a).unwrap();
        frame(&store, "peer", Some(&session), "new peer response").await;
        let page = read_blocking(&root, "thread", "mob", Some(0)).unwrap();
        assert_eq!(page["status"], "ready");
        let ids = page["frames"]
            .as_array()
            .unwrap()
            .iter()
            .map(|frame| frame["source_event_id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            ["peer"],
            "old unknown history and exact new app output stay excluded"
        );
        begin(&a).unwrap();
        finish(&a).unwrap();
        assert_eq!(
            read_blocking(&root, "thread", "mob", Some(0)).unwrap(),
            page,
            "later inputs must not move the initial cutoff past an unconsumed peer reply"
        );
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn binding_replacement_never_replays_a_previous_session() {
        let root = root();
        let session = meerkat_core::SessionId::new().to_string();
        binding(&root, &session);
        begin(&attribution(&root, &session)).unwrap();
        finish(&attribution(&root, &session)).unwrap();
        let replacement = meerkat_core::SessionId::new().to_string();
        binding(&root, &replacement);
        assert!(read_blocking(&root, "thread", "mob", None).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_source_persistence_keeps_follower_paused() {
        let root = root();
        let session = meerkat_core::SessionId::new().to_string();
        binding(&root, &session);
        let a = attribution(&root, &session);
        begin(&a).unwrap();
        let mut wrong = a.clone();
        wrong.run_id = "unowned".into();
        assert!(record(&wrong, "event").is_err());
        assert_eq!(
            read_blocking(&root, "thread", "mob", None).unwrap()["status"],
            "paused"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn legacy_baseline_transition_preserves_orphaned_pending_inputs() {
        let root = root();
        let session = meerkat_core::SessionId::new().to_string();
        binding(&root, &session);
        let store = SqliteConsoleLogStore::open(root.join("mobkit/mob/console.sqlite")).unwrap();
        frame(&store, "existing", Some(&session), "old reply").await;
        let path = journal_path(&root, "thread", "mob");
        let mut journal: Journal = serde_json::from_value(json!({
            "version":1,"threadId":"thread","mobId":"mob","sessionId":session,
            "needsBaseline":true,"excludedSourceEventIds":[],"pendingRunIds":["orphan"]
        }))
        .unwrap();
        save(&path, &journal).unwrap();
        let a = attribution(&root, &session);
        begin(&a).unwrap();
        finish(&a).unwrap();
        journal = load(&path).unwrap().unwrap();
        assert!(journal.needs_baseline);
        assert!(journal.start_after_cursor.is_none());
        assert_eq!(journal.pending_run_ids, BTreeSet::from(["orphan".into()]));
        let params = json!({"projectPath":root,"stateRoot":root,"threadId":"thread","mobId":"mob"});
        assert_eq!(
            read(Some(&params), BTreeSet::new()).await.unwrap()["status"],
            "needs_recovery"
        );

        // This fixture models explicit recovery of the orphan. A later user
        // input can then establish the future boundary without a manual audit.
        journal.pending_run_ids.clear();
        save(&path, &journal).unwrap();
        begin(&a).unwrap();
        finish(&a).unwrap();
        let transitioned = load(&path).unwrap().unwrap();
        assert!(!transitioned.needs_baseline);
        assert!(transitioned.start_after_cursor.is_some());
        assert!(
            read_blocking(&root, "thread", "mob", None).unwrap()["frames"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn followup_cursor_must_be_a_nonnegative_native_console_sequence() {
        let root = root();
        let mut params =
            json!({"projectPath":root,"stateRoot":root,"threadId":"thread","mobId":"mob"});
        for invalid in [
            json!(null),
            json!(7),
            json!(true),
            json!(""),
            json!("console:"),
            json!("console:-1"),
            json!("console:+1"),
            json!("other:1"),
            json!("console:9223372036854775808"),
        ] {
            params["after"] = invalid;
            assert!(
                read(Some(&params), BTreeSet::new()).await.is_err(),
                "invalid cursor: {}",
                params["after"]
            );
        }
        params["after"] = json!("console:0");
        assert_eq!(
            read(Some(&params), BTreeSet::new()).await.unwrap()["status"],
            "unavailable"
        );
        assert!(!root.join("thread-followups").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn orphaned_input_requires_recovery_without_advancing_a_cursor() {
        let root = root();
        let session = meerkat_core::SessionId::new().to_string();
        binding(&root, &session);
        let store = SqliteConsoleLogStore::open(root.join("mobkit/mob/console.sqlite")).unwrap();
        let a = attribution(&root, &session);
        begin(&a).unwrap();
        let params = json!({
            "projectPath":root,"stateRoot":root,"threadId":"thread","mobId":"mob"
        });
        let paused = read(Some(&params), BTreeSet::from([a.run_id.clone()]))
            .await
            .unwrap();
        assert_eq!(paused["status"], "paused");
        assert!(paused.get("nextCursor").is_none());
        let recovered = read(Some(&params), BTreeSet::new()).await.unwrap();
        assert_eq!(recovered["status"], "needs_recovery");
        assert!(recovered["frames"].as_array().unwrap().is_empty());
        assert!(recovered.get("nextCursor").is_none());
        finish(&a).unwrap();
        let ready = read(Some(&params), BTreeSet::new()).await.unwrap();
        assert_eq!(ready["status"], "ready");
        assert!(
            ready.get("nextCursor").is_none(),
            "absent cursor is omitted"
        );
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovered_and_retired_bindings_follow_durable_native_ownership() {
        let root = root();
        let original = meerkat_core::SessionId::new().to_string();
        let recovered = meerkat_core::SessionId::new().to_string();
        binding(&root, &original);
        let path = root.join("mobkit/mob/mob.sqlite");
        let conn = Connection::open(&path).unwrap();
        for kind in [
            json!({"type":"member_session_binding_recovered","agent_identity":"ingress","bridge_session_id":recovered}),
            json!({"type":"member_spawned","agent_identity":"other","bridge_member_ref":{"bridge_session_id":original}}),
        ] {
            conn.execute(
                "INSERT INTO mob_events(mob_id,event_json) VALUES('mob',?1)",
                [serde_json::to_vec(
                    &json!({"schema_version":9,"event":{"mob_id":"mob","kind":kind}}),
                )
                .unwrap()],
            )
            .unwrap();
        }
        assert_eq!(persisted_session(&path, "mob").unwrap(), Some(recovered));
        conn.execute("INSERT INTO mob_events(mob_id,event_json) VALUES('mob',?1)", [serde_json::to_vec(&json!({"schema_version":9,"event":{"mob_id":"mob","kind":{"type":"member_retired","agent_identity":"ingress"}}})).unwrap()]).unwrap();
        assert_eq!(persisted_session(&path, "mob").unwrap(), None);
        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }
}
