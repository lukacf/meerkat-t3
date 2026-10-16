use super::*;
use meerkat_mobkit::{ConsoleLogStore, NewConsoleFrame, SqliteConsoleLogStore};

async fn old_console(root: &Path) -> rusqlite::Connection {
    let path = root.join(APP_CONSOLE);
    let store = SqliteConsoleLogStore::open(&path).expect("create fixture console");
    let frame: NewConsoleFrame = serde_json::from_value(json!({
        "dedupe_key":"upgrade-history", "timestamp_ms": 1000,
        "runtime_key":"default", "identity":"ingress", "session_id":"saved-session",
        "kind":"assistant_message", "status":"completed", "payload":{"text":"retained history"},
        "source":{"kind":"session_history"}
    }))
    .unwrap();
    store.append_if_absent(frame).await.unwrap();
    drop(store);
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    // Fixture construction only. Production delegates domain adoption to Meta.
    connection
        .execute(
            "UPDATE meerkat_schema SET domain='mobkit-console' WHERE domain='meta-console'",
            [],
        )
        .unwrap();
    connection
}

#[tokio::test]
async fn adopts_original_console_and_preserves_wal_history_and_backup() {
    let root = tempfile::tempdir().unwrap();
    let connection = old_console(root.path()).await;
    assert!(
        fs::metadata(root.path().join("console.sqlite-wal"))
            .unwrap()
            .len()
            > 0
    );
    let original = digest(&root.path().join(APP_CONSOLE)).unwrap();
    let original_wal = digest(&root.path().join("console.sqlite-wal")).unwrap();
    assert_eq!(
        console_database_path(root.path()).unwrap(),
        root.path().join(APP_CONSOLE)
    );
    prepare(root.path(), super::super::desktop_topology_policy())
        .await
        .unwrap();
    drop(connection);
    let canonical = console_database_path(root.path()).unwrap();
    assert_eq!(canonical, root.path().join(CANONICAL_CONSOLE_DB_FILE_NAME));
    assert!(is_moved_marker(&root.path().join(APP_CONSOLE)).unwrap());
    assert!(SqliteConsoleLogStore::open(root.path().join(APP_CONSOLE)).is_err());
    let store = SqliteConsoleLogStore::open(&canonical).unwrap();
    let page = store.query_frames(Default::default()).await.unwrap();
    assert_eq!(page.frames.len(), 1);
    assert_eq!(page.frames[0].payload["text"], "retained history");
    assert_eq!(
        digest(&root.path().join(BACKUP).join(APP_CONSOLE)).unwrap(),
        original
    );
    assert_eq!(
        digest(&root.path().join(BACKUP).join("console.sqlite-wal")).unwrap(),
        original_wal
    );
    drop(store);
    prepare(root.path(), super::super::desktop_topology_policy())
        .await
        .unwrap();
    assert!(matches!(
        journal(root.path()).unwrap().unwrap().phase,
        Phase::Complete
    ));
}

#[tokio::test]
async fn refuses_competing_console_without_changing_original() {
    let root = tempfile::tempdir().unwrap();
    let connection = old_console(root.path()).await;
    drop(connection);
    let original = digest(&root.path().join(APP_CONSOLE)).unwrap();
    let other =
        SqliteConsoleLogStore::open(root.path().join(CANONICAL_CONSOLE_DB_FILE_NAME)).unwrap();
    drop(other);
    assert!(
        prepare(root.path(), super::super::desktop_topology_policy())
            .await
            .is_err()
    );
    assert_eq!(digest(&root.path().join(APP_CONSOLE)).unwrap(), original);
    assert!(!root.path().join(BACKUP).exists());
    assert!(console_database_path(root.path()).is_err());
}

#[tokio::test]
async fn resumes_after_app_file_move_before_native_adoption() {
    let root = tempfile::tempdir().unwrap();
    drop(old_console(root.path()).await);
    assert!(stage_console(root.path()).unwrap());
    assert!(console_database_path(root.path()).is_err());
    assert!(root
        .path()
        .join(PREDECESSOR_CONSOLE_DB_FILE_NAMES[0])
        .is_file());
    prepare(root.path(), super::super::desktop_topology_policy())
        .await
        .unwrap();
    let store = SqliteConsoleLogStore::open(console_database_path(root.path()).unwrap()).unwrap();
    assert_eq!(
        store
            .query_frames(Default::default())
            .await
            .unwrap()
            .frames
            .len(),
        1
    );
}

#[tokio::test]
async fn a_live_store_fence_refuses_movement_and_then_retries() {
    let root = tempfile::tempdir().unwrap();
    drop(old_console(root.path()).await);
    let path = root.path().join(APP_CONSOLE);
    let fence = meerkat_sqlite::ExclusiveFence::try_acquire(&path)
        .unwrap()
        .unwrap();
    assert!(
        prepare(root.path(), super::super::desktop_topology_policy())
            .await
            .is_err()
    );
    assert!(path.is_file());
    assert!(!root
        .path()
        .join(PREDECESSOR_CONSOLE_DB_FILE_NAMES[0])
        .exists());
    drop(fence);
    prepare(root.path(), super::super::desktop_topology_policy())
        .await
        .unwrap();
    assert!(console_database_path(root.path()).unwrap().is_file());
}

#[tokio::test]
async fn busy_wal_never_moves_a_partially_checkpointed_database() {
    let root = tempfile::tempdir().unwrap();
    let writer = old_console(root.path()).await;
    let reader = rusqlite::Connection::open(root.path().join(APP_CONSOLE)).unwrap();
    reader
        .execute_batch("BEGIN; SELECT * FROM console_frames;")
        .unwrap();
    writer
        .execute("UPDATE console_frames SET timestamp_ms=2000", [])
        .unwrap();
    assert!(
        prepare(root.path(), super::super::desktop_topology_policy())
            .await
            .is_err()
    );
    assert!(root.path().join(APP_CONSOLE).is_file());
    assert!(!root
        .path()
        .join(PREDECESSOR_CONSOLE_DB_FILE_NAMES[0])
        .exists());
    drop(reader);
    drop(writer);
    prepare(root.path(), super::super::desktop_topology_policy())
        .await
        .unwrap();
    let store = SqliteConsoleLogStore::open(console_database_path(root.path()).unwrap()).unwrap();
    assert_eq!(
        store.query_frames(Default::default()).await.unwrap().frames[0].timestamp_ms,
        2000
    );
}

#[cfg(unix)]
#[tokio::test]
async fn refuses_symlink_source_without_touching_target() {
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    drop(old_console(other.path()).await);
    let target = other.path().join(APP_CONSOLE);
    let before = digest(&target).unwrap();
    std::os::unix::fs::symlink(&target, root.path().join(APP_CONSOLE)).unwrap();
    assert!(
        prepare(root.path(), super::super::desktop_topology_policy())
            .await
            .is_err()
    );
    assert_eq!(digest(&target).unwrap(), before);
    assert!(console_database_path(root.path()).is_err());
}

#[tokio::test]
async fn interrupted_backup_stage_is_not_mistaken_for_complete_backup() {
    let root = tempfile::tempdir().unwrap();
    drop(old_console(root.path()).await);
    save_journal(
        root.path(),
        &Journal {
            version: 1,
            phase: Phase::BackingUp,
        },
    )
    .unwrap();
    fs::create_dir(root.path().join(BACKUP)).unwrap();
    fs::write(
        root.path()
            .join(BACKUP)
            .join("console.sqlite.interrupted.tmp"),
        b"partial copy",
    )
    .unwrap();
    prepare(root.path(), super::super::desktop_topology_policy())
        .await
        .unwrap();
    let store = SqliteConsoleLogStore::open(console_database_path(root.path()).unwrap()).unwrap();
    assert_eq!(
        store
            .query_frames(Default::default())
            .await
            .unwrap()
            .frames
            .len(),
        1
    );
    assert!(root
        .path()
        .join(BACKUP)
        .join("console.sqlite.interrupted.tmp")
        .exists());
}

#[tokio::test]
async fn cold_original_history_does_not_require_adopting_other_native_stores() {
    let root = tempfile::tempdir().unwrap();
    drop(old_console(root.path()).await);
    fs::write(
        root.path().join("mobkit_metadata.sqlite3"),
        b"unopened predecessor marker",
    )
    .unwrap();
    assert_eq!(
        console_database_path(root.path()).unwrap(),
        root.path().join(APP_CONSOLE)
    );
    assert!(!root.path().join(JOURNAL).exists());
}

#[tokio::test]
async fn native_topology_lifetime_owner_refuses_before_changing_history() {
    let root = tempfile::tempdir().unwrap();
    drop(old_console(root.path()).await);
    let original = digest(&root.path().join(APP_CONSOLE)).unwrap();
    let owner = meerkat_mobkit::TopologyController::load_or_default(
        super::super::desktop_topology_policy(),
        root.path().join("topology-control.json"),
    )
    .unwrap();
    assert!(
        prepare(root.path(), super::super::desktop_topology_policy())
            .await
            .is_err()
    );
    assert_eq!(digest(&root.path().join(APP_CONSOLE)).unwrap(), original);
    assert!(!root.path().join(JOURNAL).exists());
    drop(owner);
    prepare(root.path(), super::super::desktop_topology_policy())
        .await
        .unwrap();
}

#[tokio::test]
async fn reader_guard_prevents_move_between_location_and_sql_read() {
    let root = tempfile::tempdir().unwrap();
    drop(old_console(root.path()).await);
    let reader = read_console(root.path()).unwrap();
    assert!(
        prepare(root.path(), super::super::desktop_topology_policy())
            .await
            .is_err()
    );
    assert!(reader.path.is_file());
    assert!(!root.path().join(JOURNAL).exists());
    drop(reader);
    prepare(root.path(), super::super::desktop_topology_policy())
        .await
        .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn interrupted_hardlink_resumes_without_forking_the_original_history() {
    let root = tempfile::tempdir().unwrap();
    drop(old_console(root.path()).await);
    let source = root.path().join(APP_CONSOLE);
    backup_family(root.path(), &source).unwrap();
    save_journal(
        root.path(),
        &Journal {
            version: 1,
            phase: Phase::Prepared,
        },
    )
    .unwrap();
    fs::hard_link(
        &source,
        root.path().join(PREDECESSOR_CONSOLE_DB_FILE_NAMES[0]),
    )
    .unwrap();
    prepare(root.path(), super::super::desktop_topology_policy())
        .await
        .unwrap();
    assert!(is_moved_marker(&source).unwrap());
    let store = SqliteConsoleLogStore::open(console_database_path(root.path()).unwrap()).unwrap();
    assert_eq!(
        store
            .query_frames(Default::default())
            .await
            .unwrap()
            .frames
            .len(),
        1
    );
}

#[tokio::test]
async fn completed_adoption_with_missing_canonical_is_not_empty_history() {
    let root = tempfile::tempdir().unwrap();
    drop(old_console(root.path()).await);
    prepare(root.path(), super::super::desktop_topology_policy())
        .await
        .unwrap();
    fs::rename(
        root.path().join(CANONICAL_CONSOLE_DB_FILE_NAME),
        root.path().join("retained-for-test.sqlite"),
    )
    .unwrap();
    assert!(console_database_path(root.path()).is_err());
}
