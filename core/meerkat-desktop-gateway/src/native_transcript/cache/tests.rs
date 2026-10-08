use super::*;
use crate::native_transcript::{read_session_with_cache, MAX_DOCUMENT_BYTES};
use rusqlite::Connection;
use serde_json::json;
use sha2::{Digest, Sha256};

struct Fixture {
    root: PathBuf,
    path: PathBuf,
    session: Session,
    cache: Store,
}

impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("native-transcript-cache-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("runtime.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE runtime_whole_blob_authority(runtime_id TEXT PRIMARY KEY,authority_version INTEGER,session_id TEXT,store_revision INTEGER,blob_sha256 TEXT); CREATE TABLE runtime_whole_blob_bodies(blob_sha256 TEXT PRIMARY KEY,session_snapshot BLOB); CREATE TABLE runtime_head_canonical_profile_pin(singleton INTEGER); CREATE TABLE runtime_session_authority(runtime_id TEXT); CREATE TABLE runtime_head_canonical_activations(runtime_id TEXT);").unwrap();
        drop(conn);
        let mut session = Session::new();
        session.push(
            serde_json::from_value(json!({"role":"user","content":"original task"})).unwrap(),
        );
        let fixture = Self {
            root,
            path,
            session,
            cache: Store::default(),
        };
        fixture.commit(&fixture.session, 7);
        fixture
    }

    fn commit(&self, session: &Session, revision: i64) {
        let bytes = serde_json::to_vec(session).unwrap();
        let digest = format!("row-sha256:{:x}", Sha256::digest(&bytes));
        let mut conn = Connection::open(&self.path).unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute(
            "INSERT OR REPLACE INTO runtime_whole_blob_bodies VALUES(?1,?2)",
            rusqlite::params![digest, bytes],
        )
        .unwrap();
        tx.execute(
            "INSERT OR REPLACE INTO runtime_whole_blob_authority VALUES(?1,1,?2,?3,?4)",
            rusqlite::params![
                meerkat_runtime::identifiers::LogicalRuntimeId::for_session(session.id()).0,
                session.id().to_string(),
                revision,
                digest
            ],
        )
        .unwrap();
        tx.commit().unwrap();
    }

    fn read(
        &self,
        revision: Option<&str>,
    ) -> Result<Option<(Arc<Session>, String)>, crate::GatewayError> {
        read_session_with_cache(
            &self.path,
            &self.session.id().to_string(),
            revision,
            &self.cache,
        )
    }

    fn execute(&self, sql: &str) {
        Connection::open(&self.path)
            .unwrap()
            .execute_batch(sql)
            .unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn warm_decode_reuse_still_reads_current_authority_and_leaves_database_unchanged() {
    let fixture = Fixture::new();
    let database = std::fs::read(&fixture.path).unwrap();
    let (first, _) = fixture.read(None).unwrap().unwrap();
    let (warm, revision) = fixture.read(Some("7")).unwrap().unwrap();
    assert!(Arc::ptr_eq(&first, &warm));
    assert_eq!(revision, "7");
    assert_eq!(std::fs::read(&fixture.path).unwrap(), database);
    assert_eq!(std::fs::read_dir(&fixture.root).unwrap().count(), 1);
    assert!(fixture
        .read(Some("6"))
        .unwrap_err()
        .to_string()
        .contains("changed"));

    fixture.execute("UPDATE runtime_whole_blob_authority SET authority_version=2");
    assert!(fixture
        .read(None)
        .unwrap_err()
        .to_string()
        .contains("authority"));
    fixture
        .execute("UPDATE runtime_whole_blob_authority SET authority_version=1, store_revision=0");
    assert!(fixture
        .read(None)
        .unwrap_err()
        .to_string()
        .contains("authority"));
    fixture.execute(
        "UPDATE runtime_whole_blob_authority SET store_revision=7, session_id='foreign-session'",
    );
    assert!(fixture
        .read(None)
        .unwrap_err()
        .to_string()
        .contains("authority"));
    fixture.execute("DELETE FROM runtime_whole_blob_authority");
    assert!(fixture.read(None).unwrap().is_none());
}

#[test]
fn unchanged_revision_and_digest_cannot_hide_altered_body() {
    let fixture = Fixture::new();
    let (original, _) = fixture.read(None).unwrap().unwrap();
    let mut changed = fixture.session.clone();
    changed.push(
        serde_json::from_value(json!({"role":"user","content":"changed under same authority"}))
            .unwrap(),
    );
    Connection::open(&fixture.path)
        .unwrap()
        .execute(
            "UPDATE runtime_whole_blob_bodies SET session_snapshot=?1",
            [serde_json::to_vec(&changed).unwrap()],
        )
        .unwrap();
    assert!(fixture
        .read(None)
        .unwrap_err()
        .to_string()
        .contains("digest"));
    assert!(fixture.cache.lock().unwrap().entries.is_empty());

    fixture.commit(&fixture.session, 7);
    let (restored, _) = fixture.read(None).unwrap().unwrap();
    assert!(!Arc::ptr_eq(&original, &restored));
    fixture.execute("UPDATE runtime_whole_blob_bodies SET session_snapshot=x'7b7d'");
    assert!(fixture
        .read(None)
        .unwrap_err()
        .to_string()
        .contains("decoded"));
}

#[test]
fn changed_revision_or_committed_body_replaces_decode_and_fences_old_pages() {
    let fixture = Fixture::new();
    let (original, _) = fixture.read(None).unwrap().unwrap();
    fixture.execute("UPDATE runtime_whole_blob_authority SET store_revision=8");
    assert!(fixture
        .read(Some("7"))
        .unwrap_err()
        .to_string()
        .contains("changed"));
    let (revision_only, revision) = fixture.read(Some("8")).unwrap().unwrap();
    assert_eq!(revision, "8");
    assert!(!Arc::ptr_eq(&original, &revision_only));

    let mut changed = fixture.session.clone();
    changed.push(serde_json::from_value(json!({"role":"user","content":"next task"})).unwrap());
    fixture.commit(&changed, 9);
    let (current, revision) = fixture.read(Some("9")).unwrap().unwrap();
    assert_eq!(revision, "9");
    assert_eq!(current.messages().len(), changed.messages().len());
    assert!(!Arc::ptr_eq(&revision_only, &current));
    assert_eq!(fixture.cache.lock().unwrap().entries.len(), 1);
    assert!(fixture
        .read(Some("8"))
        .unwrap_err()
        .to_string()
        .contains("changed"));
}

#[test]
fn cached_session_rejects_missing_oversized_and_foreign_bodies() {
    let fixture = Fixture::new();
    fixture.read(None).unwrap().unwrap();
    fixture.execute("DELETE FROM runtime_whole_blob_bodies");
    assert!(fixture
        .read(None)
        .unwrap_err()
        .to_string()
        .contains("missing body"));

    fixture.commit(&fixture.session, 7);
    Connection::open(&fixture.path)
        .unwrap()
        .execute(
            "UPDATE runtime_whole_blob_bodies SET session_snapshot=zeroblob(?1)",
            [MAX_DOCUMENT_BYTES + 1],
        )
        .unwrap();
    assert!(fixture
        .read(None)
        .unwrap_err()
        .to_string()
        .contains("bounded reader"));

    let foreign = Session::new();
    let bytes = serde_json::to_vec(&foreign).unwrap();
    let digest = format!("row-sha256:{:x}", Sha256::digest(&bytes));
    let mut conn = Connection::open(&fixture.path).unwrap();
    let tx = conn.transaction().unwrap();
    tx.execute(
        "INSERT INTO runtime_whole_blob_bodies VALUES(?1,?2)",
        rusqlite::params![digest, bytes],
    )
    .unwrap();
    tx.execute(
        "UPDATE runtime_whole_blob_authority SET blob_sha256=?1",
        [&digest],
    )
    .unwrap();
    tx.commit().unwrap();
    drop(conn);
    assert!(fixture
        .read(None)
        .unwrap_err()
        .to_string()
        .contains("different session"));
}

#[test]
fn replacing_database_at_same_path_does_not_reuse_old_decode() {
    let fixture = Fixture::new();
    let (original, _) = fixture.read(None).unwrap().unwrap();
    let previous = fixture.root.join("previous.sqlite");
    std::fs::rename(&fixture.path, &previous).unwrap();
    std::fs::copy(&previous, &fixture.path).unwrap();
    let (replacement, _) = fixture.read(None).unwrap().unwrap();
    assert!(!Arc::ptr_eq(&original, &replacement));
    assert_eq!(fixture.cache.lock().unwrap().entries.len(), 1);
    fixture.execute("UPDATE runtime_whole_blob_bodies SET session_snapshot=x'7b7d'");
    assert!(fixture.read(None).is_err());
    std::fs::remove_file(&fixture.path).unwrap();
    assert!(fixture.read(None).unwrap().is_none());
}

#[test]
fn head_canonical_profile_changes_reject_even_a_warm_unchanged_body() {
    let fixture = Fixture::new();
    fixture.read(None).unwrap().unwrap();
    for (table, value) in [
        ("runtime_head_canonical_profile_pin", "1"),
        ("runtime_session_authority", "'session'"),
        ("runtime_head_canonical_activations", "'session'"),
    ] {
        fixture.execute(&format!("INSERT INTO {table} VALUES({value})"));
        assert!(fixture
            .read(None)
            .unwrap_err()
            .to_string()
            .contains("head-canonical"));
        fixture.execute(&format!("DELETE FROM {table}"));
        assert!(fixture.read(None).unwrap().is_some());
    }
}

#[test]
fn cache_eviction_obeys_entry_and_document_byte_caps() {
    let fixture = Fixture::new();
    let mut cache = DecodeCache::default();
    let mut keys = Vec::new();
    for index in 0..=MAX_ENTRIES {
        let database = Database::capture(&fixture.path).unwrap();
        let session = Arc::new(Session::new());
        let key = database.key(session.id(), 1, "digest");
        cache.insert(key.clone(), vec![index as u8], session);
        keys.push(key);
    }
    assert_eq!(cache.entries.len(), MAX_ENTRIES);
    assert!(cache.get(&keys[0], &[0]).is_none());
    assert!(cache.get(&keys[1], &[1]).is_some());
    assert_eq!(cache.retained_bytes, MAX_ENTRIES);

    let newest = Database::capture(&fixture.path).unwrap();
    let session = Arc::new(Session::new());
    let key = newest.key(session.id(), 1, "digest");
    cache.insert(key, vec![0], session);
    assert!(cache.get(&keys[2], &[2]).is_none());
    assert!(cache.get(&keys[1], &[1]).is_some());

    let mut cache = DecodeCache::default();
    for _ in 0..=MAX_RETAINED_BYTES / MAX_ENTRY_BYTES {
        let database = Database::capture(&fixture.path).unwrap();
        let session = Arc::new(Session::new());
        let key = database.key(session.id(), 1, "digest");
        cache.insert(key, vec![0; MAX_ENTRY_BYTES], session);
    }
    assert_eq!(cache.retained_bytes, MAX_RETAINED_BYTES);
    assert_eq!(cache.entries.len(), MAX_RETAINED_BYTES / MAX_ENTRY_BYTES);
    let database = Database::capture(&fixture.path).unwrap();
    let session = Arc::new(Session::new());
    let key = database.key(session.id(), 1, "oversized");
    cache.insert(key.clone(), vec![0; MAX_ENTRY_BYTES + 1], session);
    assert_eq!(cache.retained_bytes, MAX_RETAINED_BYTES);
    assert!(!cache.entries.iter().any(|entry| entry.key == key));
}
