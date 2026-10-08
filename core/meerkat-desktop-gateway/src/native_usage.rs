//! Read-only lifetime usage for the current T3 provider storage directory.
//! Native session authority owns the counters. Rosters and completion events
//! are deliberately not used: they omit retired sessions or repeat totals.
//! SQLite read-only connections may maintain WAL/SHM coordination sidecars;
//! this reader never writes session authority or application content.
use crate::{normalize_state_root_path, object_params, required_nonempty_string, GatewayError};
use meerkat_core::{types::Usage, SessionId};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const MAX_STORES: usize = 1_024;
const MAX_SESSIONS: usize = 10_000;
const MAX_DIRECTORIES: usize = 20_000;
const MAX_SESSION_BYTES: u64 = 128 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const SCAN_DEADLINE: Duration = Duration::from_secs(10);
static SCAN_ACTIVE: AtomicBool = AtomicBool::new(false);

struct ScanPermit<'a>(&'a AtomicBool);
impl<'a> ScanPermit<'a> {
    fn acquire(active: &'a AtomicBool) -> Option<Self> {
        active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self(active))
    }
}
impl Drop for ScanPermit<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

struct ScanControl {
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
}
impl ScanControl {
    fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            deadline: Instant::now() + SCAN_DEADLINE,
        }
    }
    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            Err("The native usage read was cancelled. Retry to read current usage.".into())
        } else if Instant::now() >= self.deadline {
            Err(
                "The native usage read reached its time limit. Retry after current work settles."
                    .into(),
            )
        } else {
            Ok(())
        }
    }
}
struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Totals {
    #[serde(skip)]
    observed_sessions: usize,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: Option<u64>,
    cache_creation_tokens: Option<u64>,
    reasoning_tokens: Option<u64>,
}

impl Totals {
    fn add(&mut self, usage: Usage) -> Result<(), String> {
        fn sum(left: u64, right: u64) -> Result<u64, String> {
            left.checked_add(right)
                .filter(|value| *value <= MAX_SAFE_INTEGER)
                .ok_or_else(|| "Recorded usage exceeds the supported exact counter range.".into())
        }
        fn optional(
            left: Option<u64>,
            right: Option<u64>,
            first: bool,
        ) -> Result<Option<u64>, String> {
            match (left, right, first) {
                (_, Some(value), true) => sum(0, value).map(Some),
                (Some(left), Some(right), false) => sum(left, right).map(Some),
                _ => Ok(None),
            }
        }
        let first = self.observed_sessions == 0;
        self.input_tokens = sum(self.input_tokens, usage.input_tokens)?;
        self.output_tokens = sum(self.output_tokens, usage.output_tokens)?;
        // Consumers may display their sum; keep that operation exact too.
        sum(self.input_tokens, self.output_tokens)?;
        self.cache_read_tokens = optional(self.cache_read_tokens, usage.cache_read_tokens, first)?;
        self.cache_creation_tokens = optional(
            self.cache_creation_tokens,
            usage.cache_creation_tokens,
            first,
        )?;
        self.reasoning_tokens = optional(self.reasoning_tokens, usage.reasoning_tokens, first)?;
        self.observed_sessions += 1;
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Issue {
    code: &'static str,
    store: Option<String>,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    observed_at: String,
    scope: &'static str,
    coverage: &'static str,
    stores: usize,
    sessions: usize,
    totals: Option<Totals>,
    issues: Vec<Issue>,
    exclusions: [&'static str; 2],
}

pub(crate) async fn read(params: Option<&Value>) -> Result<Value, GatewayError> {
    let params = object_params(params)?;
    let root = normalize_state_root_path(&required_nonempty_string(params, "providerStateRoot")?)?;
    let Some(permit) = ScanPermit::acquire(&SCAN_ACTIVE) else {
        return Ok(serde_json::json!({
            "observedAt": chrono::Utc::now().to_rfc3339(), "scope":"current-provider-storage",
            "coverage":"unavailable", "stores":0, "sessions":0, "totals":null,
            "issues":[{"code":"scan-busy","store":null,"message":"Another native usage read is in progress. Retry shortly."}],
            "exclusions":["auxiliary-generation","previous-provider-storage"]
        }));
    };
    let control = ScanControl::new();
    let _cancel_on_drop = CancelOnDrop(Arc::clone(&control.cancelled));
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        serde_json::to_value(snapshot_with_control(&root, &control)).map_err(|error| {
            GatewayError::policy(
                "Could not encode recorded native usage",
                Some(serde_json::json!({"error":error.to_string()})),
            )
        })
    })
    .await
    .map_err(|error| {
        GatewayError::policy(
            "Could not read recorded native usage",
            Some(serde_json::json!({"error":error.to_string()})),
        )
    })?
}

#[cfg(test)]
fn snapshot(root: &Path) -> Snapshot {
    snapshot_with_control(root, &ScanControl::new())
}

fn snapshot_with_control(root: &Path, control: &ScanControl) -> Snapshot {
    let mut result = Snapshot {
        observed_at: String::new(),
        scope: "current-provider-storage",
        coverage: "unavailable",
        stores: 0,
        sessions: 0,
        totals: None,
        issues: Vec::new(),
        exclusions: ["auxiliary-generation", "previous-provider-storage"],
    };
    let mut totals = Totals::default();
    let mut session_bytes = 0_u64;
    let census = discover(root, control);
    match census {
        Err(message) => result.issues.push(Issue {
            code: "storage-unavailable",
            store: None,
            message,
        }),
        Ok(stores) => {
            result.stores = stores.len();
            let mut file_ids = BTreeSet::new();
            let mut session_ids = BTreeSet::new();
            for store in &stores {
                if let Err(message) = control.check() {
                    result.issues.push(Issue {
                        code: "scan-interrupted",
                        store: None,
                        message,
                    });
                    break;
                }
                let relative = store
                    .strip_prefix(root)
                    .unwrap_or(store)
                    .to_string_lossy()
                    .into_owned();
                let read = (|| {
                    if !file_ids.insert(file_identity(store)?) {
                        return Err(
                            "Two retained store paths refer to the same native database.".into(),
                        );
                    }
                    let sessions = session_census(store)?;
                    result.sessions += sessions.len();
                    if result.sessions > MAX_SESSIONS {
                        return Err("Native usage exceeds the bounded session census. No total was produced.".into());
                    }
                    for (session_id, (revision, bytes)) in &sessions {
                        control.check()?;
                        if !session_ids.insert(session_id.clone()) {
                            return Err("The same native session is retained in more than one store. Copied or divergent stores cannot be combined into one total.".into());
                        }
                        session_bytes = session_bytes.checked_add(*bytes)
                            .filter(|total| *total <= MAX_SESSION_BYTES)
                            .ok_or_else(|| "Native session bodies exceed the bounded usage reader. No total was produced.".to_string())?;
                        let (session, _) = crate::native_transcript::read_session(store, session_id, Some(revision))
                            .map_err(|_| "Native session authority is unavailable or changed during the read. Retry after current work settles.".to_string())?
                            .ok_or_else(|| "A catalog session has no readable committed native authority.".to_string())?;
                        totals.add(session.reported_total_usage())?;
                        control.check()?;
                    }
                    if session_census(store)? != sessions {
                        return Err("Native sessions changed during the census. Retry after current work settles.".into());
                    }
                    Ok::<(), String>(())
                })();
                if let Err(message) = read {
                    result.issues.push(Issue {
                        code: "store-unavailable",
                        store: Some(relative),
                        message,
                    });
                }
            }
            match discover(root, control) {
                Ok(after) if after == stores => {}
                _ => result.issues.push(Issue { code: "storage-changed", store: None,
                    message: "The retained native store census changed during the read. Retry after current work settles.".into() }),
            }
        }
    }
    if result.issues.is_empty() {
        result.coverage = "complete";
        result.totals = Some(totals);
    }
    result.observed_at = chrono::Utc::now().to_rfc3339();
    result
}

/// Only the two layouts this adapter owns. Unrelated files and directories
/// outside these layouts are not evidence of missing native usage.
fn discover(root: &Path, control: &ScanControl) -> Result<BTreeSet<PathBuf>, String> {
    control.check()?;
    let mut budget = MAX_DIRECTORIES;
    let mut scopes = directories(&root.join("projects"), &mut budget, control)?;
    for project in directories(&root.join("project-agents"), &mut budget, control)? {
        scopes.extend(directories(&project, &mut budget, control)?);
    }
    let mut stores = BTreeSet::new();
    for scope in scopes {
        for mob in directories(&scope.join("mobkit"), &mut budget, control)? {
            control.check()?;
            let database = mob.join("runtime.sqlite");
            match std::fs::symlink_metadata(&database) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                    return Err(
                        "A retained native database is not a regular file. No total was produced."
                            .into(),
                    );
                }
                Ok(_) => {
                    stores.insert(database);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    if mob.join("sessions.sqlite").exists() || mob.join("mob.sqlite").exists() {
                        return Err("Retained native state is missing its authoritative runtime database. No total was produced.".into());
                    }
                }
                Err(_) => return Err("A retained native database could not be inspected.".into()),
            }
            if stores.len() > MAX_STORES {
                return Err(
                    "Native usage exceeds the bounded store census. No total was produced.".into(),
                );
            }
        }
    }
    Ok(stores)
}

fn directories(
    path: &Path,
    budget: &mut usize,
    control: &ScanControl,
) -> Result<Vec<PathBuf>, String> {
    control.check()?;
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("A native storage directory could not be inspected.".into()),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() =>
            return Err("A native storage directory is unavailable or linked to another location. No total was produced.".into()),
        Ok(_) => {}
    }
    let entries =
        std::fs::read_dir(path).map_err(|_| "A native storage directory could not be read.")?;
    let mut children = Vec::new();
    for entry in entries {
        control.check()?;
        *budget = budget
            .checked_sub(1)
            .ok_or("Native usage exceeds the bounded directory census.")?;
        let entry = entry.map_err(|_| "A native storage directory entry could not be read.")?;
        let kind = entry
            .file_type()
            .map_err(|_| "A native storage directory entry could not be inspected.")?;
        if kind.is_symlink() {
            return Err(
                "A native storage subtree is linked to another location. No total was produced."
                    .into(),
            );
        }
        if kind.is_dir() {
            children.push(entry.path());
        }
    }
    children.sort();
    Ok(children)
}

fn file_identity(path: &Path) -> Result<String, String> {
    let metadata =
        std::fs::metadata(path).map_err(|_| "A native database could not be inspected.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        path.canonicalize()
            .map(|path| path.to_string_lossy().into_owned())
            .map_err(|_| "A native database location could not be resolved.".into())
    }
}

/// The catalog discovers all retained sessions, not just current members.
/// Cross-check both sets so a missing catalog row cannot silently lower totals.
fn session_census(path: &Path) -> Result<BTreeMap<String, (String, u64)>, String> {
    let mut connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "The native database could not be opened read-only.")?;
    connection
        .busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|_| "The native database is unavailable.")?;
    let transaction = connection
        .transaction()
        .map_err(|_| "The native database could not be read consistently.")?;
    let result = (|| {
        let mut catalog = BTreeSet::new();
        let mut query = transaction
            .prepare("SELECT session_id FROM runtime_session_catalog LIMIT ?1")
            .map_err(|_| "The native store has no supported authoritative session catalog.")?;
        let rows = query
            .query_map([MAX_SESSIONS + 1], |row| row.get::<_, String>(0))
            .map_err(|_| "The native session catalog could not be read.")?;
        for row in rows {
            let id = row.map_err(|_| "The native session catalog is unreadable.")?;
            if !catalog.insert(id) {
                return Err("The native session catalog contains duplicate identities.".into());
            }
        }
        if catalog.len() > MAX_SESSIONS {
            return Err("Native usage exceeds the bounded session census.".into());
        }
        // HeadCanonical requires its own native reader; never read a frozen predecessor.
        let head: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM runtime_head_canonical_profile_pin UNION ALL SELECT 1 FROM runtime_session_authority UNION ALL SELECT 1 FROM runtime_head_canonical_activations)", [], |row| row.get(0))
            .map_err(|_| "The native authority profile could not be verified.")?;
        if head {
            return Err("This native store requires the head-canonical usage reader.".into());
        }
        let mut authority = BTreeMap::new();
        let mut query = transaction.prepare("SELECT a.runtime_id,a.session_id,a.store_revision,length(b.session_snapshot) FROM runtime_whole_blob_authority a LEFT JOIN runtime_whole_blob_bodies b ON b.blob_sha256=a.blob_sha256 LIMIT ?1")
            .map_err(|_| "The native store has no supported committed session authority.")?;
        let rows = query
            .query_map([MAX_SESSIONS + 1], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, u64>(3)?,
                ))
            })
            .map_err(|_| "The native session authorities could not be read.")?;
        for row in rows {
            let (runtime, id, revision, bytes) = row.map_err(|_| {
                "The native session authority is unreadable or its body is missing."
            })?;
            let session = SessionId::parse(&id)
                .map_err(|_| "The native session authority has an invalid identity.")?;
            if meerkat_runtime::identifiers::LogicalRuntimeId::for_session(&session).0 != runtime
                || revision < 1
            {
                return Err("The native session authority does not match its session.".into());
            }
            if authority
                .insert(id, (revision.to_string(), bytes))
                .is_some()
            {
                return Err("The native session authority contains duplicate identities.".into());
            }
        }
        if catalog != authority.keys().cloned().collect() {
            return Err("The native session catalog and committed authority disagree. No total was produced.".into());
        }
        Ok(authority)
    })();
    transaction
        .rollback()
        .map_err(|_| "The native read transaction could not be closed.")?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use meerkat_core::Session;
    use sha2::{Digest, Sha256};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("native-usage-{}", uuid::Uuid::new_v4())))
        }
        fn store(&self, relative: &str, usages: &[(u64, u64)]) -> PathBuf {
            let directory = self.0.join(relative);
            std::fs::create_dir_all(&directory).unwrap();
            let path = directory.join("runtime.sqlite");
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE runtime_session_catalog(session_id TEXT); CREATE TABLE runtime_whole_blob_authority(runtime_id TEXT PRIMARY KEY,authority_version INTEGER,session_id TEXT,store_revision INTEGER,blob_sha256 TEXT); CREATE TABLE runtime_whole_blob_bodies(blob_sha256 TEXT PRIMARY KEY,session_snapshot BLOB); CREATE TABLE runtime_head_canonical_profile_pin(singleton INTEGER); CREATE TABLE runtime_session_authority(runtime_id TEXT); CREATE TABLE runtime_head_canonical_activations(runtime_id TEXT);").unwrap();
            for (input, output) in usages {
                let mut session = Session::new();
                session.record_cumulative_usage(Usage {
                    input_tokens: *input,
                    output_tokens: *output,
                    ..Usage::default()
                });
                let bytes = serde_json::to_vec(&session).unwrap();
                let digest = format!("row-sha256:{:x}", Sha256::digest(&bytes));
                conn.execute(
                    "INSERT INTO runtime_session_catalog VALUES (?1)",
                    [session.id().to_string()],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO runtime_whole_blob_authority VALUES (?1,1,?2,7,?3)",
                    rusqlite::params![
                        meerkat_runtime::identifiers::LogicalRuntimeId::for_session(session.id()).0,
                        session.id().to_string(),
                        digest,
                    ],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO runtime_whole_blob_bodies VALUES (?1,?2)",
                    rusqlite::params![digest, bytes],
                )
                .unwrap();
            }
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn counts_cold_coordinator_worker_retired_and_project_agent_sessions_once() {
        let fixture = Fixture::new();
        // No roster or loaded runtime is present. All retained sessions count.
        let thread = fixture.store(
            "projects/project/mobkit/thread",
            &[(100, 10), (30, 3), (50, 5)],
        );
        let specialist = fixture.store("project-agents/project/agent/mobkit/domain", &[(20, 2)]);
        // An unrelated directory is outside the two adapter-owned layouts.
        fixture.store("unrelated/backup", &[(900, 900)]);
        let before = [
            std::fs::read(&thread).unwrap(),
            std::fs::read(&specialist).unwrap(),
        ];
        for _ in 0..2 {
            let result = snapshot(&fixture.0);
            assert_eq!(result.coverage, "complete");
            assert_eq!((result.stores, result.sessions), (2, 4));
            let totals = result.totals.unwrap();
            assert_eq!((totals.input_tokens, totals.output_tokens), (200, 20));
            assert_eq!(totals.cache_read_tokens, None);
        }
        assert_eq!(std::fs::read(&thread).unwrap(), before[0]);
        assert_eq!(std::fs::read(&specialist).unwrap(), before[1]);
    }

    #[test]
    fn missing_catalog_entry_prevents_partial_total() {
        let fixture = Fixture::new();
        let path = fixture.store("projects/project/mobkit/thread", &[(100, 10)]);
        Connection::open(path)
            .unwrap()
            .execute("DELETE FROM runtime_session_catalog", [])
            .unwrap();
        let result = snapshot(&fixture.0);
        assert_eq!(result.coverage, "unavailable");
        assert!(result.totals.is_none());
        assert!(result.issues[0].message.contains("disagree"));
    }

    #[test]
    fn corrupt_or_head_canonical_authority_never_falls_back_to_other_totals() {
        let fixture = Fixture::new();
        fixture.store("projects/project/mobkit/good", &[(100, 10)]);
        let path = fixture.store("projects/project/mobkit/bad", &[(30, 3)]);
        let conn = Connection::open(path).unwrap();
        conn.execute(
            "UPDATE runtime_whole_blob_authority SET blob_sha256='bad'",
            [],
        )
        .unwrap();
        assert!(snapshot(&fixture.0).totals.is_none());
        conn.execute(
            "INSERT INTO runtime_head_canonical_profile_pin VALUES (1)",
            [],
        )
        .unwrap();
        let result = snapshot(&fixture.0);
        assert_eq!(result.coverage, "unavailable");
        assert!(result.totals.is_none());
        assert!(result
            .issues
            .iter()
            .any(|issue| issue.message.contains("head-canonical")));
    }

    #[test]
    fn missing_runtime_store_is_not_zero_spend() {
        let fixture = Fixture::new();
        let directory = fixture.0.join("projects/project/mobkit/thread");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("sessions.sqlite"), []).unwrap();
        let result = snapshot(&fixture.0);
        assert_eq!(result.coverage, "unavailable");
        assert!(result.totals.is_none());
    }

    #[test]
    fn empty_storage_is_zero_without_creating_files() {
        let fixture = Fixture::new();
        let result = snapshot(&fixture.0);
        assert_eq!(result.coverage, "complete");
        assert_eq!((result.stores, result.sessions), (0, 0));
        assert_eq!(result.totals.unwrap().input_tokens, 0);
        assert!(!fixture.0.exists());
    }

    #[test]
    fn exact_counter_overflow_prevents_a_total() {
        let mut totals = Totals::default();
        totals
            .add(Usage {
                input_tokens: MAX_SAFE_INTEGER,
                ..Usage::default()
            })
            .unwrap();
        assert!(totals
            .add(Usage {
                input_tokens: 1,
                ..Usage::default()
            })
            .is_err());
    }

    #[test]
    fn optional_counters_stay_unknown_if_any_session_did_not_report_them() {
        let known = Usage {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_tokens: Some(20),
            cache_creation_tokens: Some(5),
            reasoning_tokens: Some(2),
            ..Usage::default()
        };
        let unknown = Usage {
            input_tokens: 40,
            output_tokens: 4,
            ..Usage::default()
        };
        for values in [[known.clone(), unknown.clone()], [unknown, known.clone()]] {
            let mut totals = Totals::default();
            for usage in values {
                totals.add(usage).unwrap();
            }
            totals.add(known.clone()).unwrap();
            assert_eq!((totals.input_tokens, totals.output_tokens), (240, 24));
            assert_eq!(totals.cache_read_tokens, None);
            assert_eq!(totals.cache_creation_tokens, None);
            assert_eq!(totals.reasoning_tokens, None);
        }
        let mut totals = Totals::default();
        totals.add(known.clone()).unwrap();
        totals.add(known).unwrap();
        assert_eq!(totals.cache_read_tokens, Some(40));
        assert_eq!(totals.cache_creation_tokens, Some(10));
        assert_eq!(totals.reasoning_tokens, Some(4));
    }

    #[cfg(unix)]
    #[test]
    fn aliases_cannot_double_count_native_sessions() {
        let fixture = Fixture::new();
        let path = fixture.store("projects/project/mobkit/first", &[(100, 10)]);
        let other = fixture.0.join("projects/project/mobkit/alias");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::hard_link(path, other.join("runtime.sqlite")).unwrap();
        let result = snapshot(&fixture.0);
        assert_eq!(result.coverage, "unavailable");
        assert!(result.totals.is_none());
        assert!(result
            .issues
            .iter()
            .any(|issue| issue.message.contains("same native database")));
    }

    #[test]
    fn copied_stores_cannot_double_count_the_same_logical_session() {
        let fixture = Fixture::new();
        let path = fixture.store("projects/project/mobkit/first", &[(100, 10)]);
        let copied = fixture.0.join("projects/project/mobkit/copy");
        std::fs::create_dir_all(&copied).unwrap();
        std::fs::copy(path, copied.join("runtime.sqlite")).unwrap();
        let result = snapshot(&fixture.0);
        assert_eq!(result.coverage, "unavailable");
        assert!(result.totals.is_none());
        assert!(result
            .issues
            .iter()
            .any(|issue| issue.message.contains("same native session")));
    }

    #[test]
    fn scan_admission_never_queues_a_second_read() {
        let active = AtomicBool::new(false);
        let first = ScanPermit::acquire(&active).unwrap();
        assert!(ScanPermit::acquire(&active).is_none());
        drop(first);
        assert!(ScanPermit::acquire(&active).is_some());
    }

    #[test]
    fn expired_or_cancelled_scans_do_not_return_partial_totals() {
        let fixture = Fixture::new();
        fixture.store("projects/project/mobkit/thread", &[(100, 10)]);
        let mut control = ScanControl::new();
        control.deadline = Instant::now();
        let expired = snapshot_with_control(&fixture.0, &control);
        assert_eq!(expired.coverage, "unavailable");
        assert!(expired.totals.is_none());
        assert!(expired
            .issues
            .iter()
            .any(|issue| issue.message.contains("time limit")));
        let control = ScanControl::new();
        let guard = CancelOnDrop(Arc::clone(&control.cancelled));
        drop(guard);
        let cancelled = snapshot_with_control(&fixture.0, &control);
        assert_eq!(cancelled.coverage, "unavailable");
        assert!(cancelled.totals.is_none());
        assert!(cancelled
            .issues
            .iter()
            .any(|issue| issue.message.contains("cancelled")));
    }

    #[test]
    fn reads_committed_wal_tail_without_changing_session_authority() {
        let fixture = Fixture::new();
        let path = fixture.store("projects/project/mobkit/thread", &[(100, 10)]);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        let mut session = Session::new();
        session.record_cumulative_usage(Usage {
            input_tokens: 70,
            output_tokens: 7,
            ..Usage::default()
        });
        let bytes = serde_json::to_vec(&session).unwrap();
        let digest = format!("row-sha256:{:x}", Sha256::digest(&bytes));
        connection
            .execute(
                "INSERT INTO runtime_session_catalog VALUES (?1)",
                [session.id().to_string()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO runtime_whole_blob_authority VALUES (?1,1,?2,8,?3)",
                rusqlite::params![
                    meerkat_runtime::identifiers::LogicalRuntimeId::for_session(session.id()).0,
                    session.id().to_string(),
                    digest,
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO runtime_whole_blob_bodies VALUES (?1,?2)",
                rusqlite::params![digest, bytes],
            )
            .unwrap();
        let authority = || {
            connection.prepare("SELECT runtime_id,session_id,store_revision,blob_sha256 FROM runtime_whole_blob_authority ORDER BY session_id").unwrap()
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?)))
            .unwrap().collect::<Result<Vec<_>, _>>().unwrap()
        };
        let before = authority();
        let changes = connection.total_changes();
        let result = snapshot(&fixture.0);
        assert_eq!(result.coverage, "complete");
        assert_eq!(result.sessions, 2);
        let totals = result.totals.unwrap();
        assert_eq!((totals.input_tokens, totals.output_tokens), (170, 17));
        assert_eq!(authority(), before);
        assert_eq!(connection.total_changes(), changes);
    }
}
