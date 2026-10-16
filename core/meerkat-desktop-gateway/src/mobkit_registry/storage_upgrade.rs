//! Adapt the app's historical filename, then let the native migration own schemas.
//! Only bootstrap, before opening any store, may call `prepare`.
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use meerkat_mobkit::storage_layout::{MetaStorageLayout, CANONICAL_CONSOLE_DB_FILE_NAME};
use meerkat_mobkit::storage_migrate::MigrateMode;
use meerkat_mobkit::storage_predecessor::{
    adopt_predecessor_state, unfinished_adoption, PredecessorAdoptRequest,
    PREDECESSOR_CONSOLE_DB_FILE_NAMES,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::GatewayError;

const APP_CONSOLE: &str = "console.sqlite";
const JOURNAL: &str = ".meerkat-t3-console-adoption.json";
const BACKUP: &str = ".meerkat-t3-console-pre-0.9";
const LOCK: &str = ".meerkat-t3-storage-upgrade.lock";
const SUFFIXES: [&str; 3] = ["", "-wal", "-shm"];
const MOVED_MARKER: &[u8] = b"Meerkat T3 storage adoption v1\nThis SQLite database has moved. Use Meerkat T3 0.9 or newer.\n";

pub(super) struct PreparedStorage {
    _lock: File,
    topology: Option<meerkat_mobkit::TopologyController>,
}
impl PreparedStorage {
    pub(super) fn handoff_topology(&mut self) {
        // UnifiedRuntime takes the same native lifetime lock next. The app
        // bootstrap lock stays held, and old app console opens hit the marker.
        self.topology.take();
    }
}

pub(crate) struct ConsoleRead {
    pub(crate) path: PathBuf,
    _lock: Option<File>,
}

/// Keep the app migration lock shared across resolution and the entire raw
/// SQLite read, so a concurrent upgrade cannot turn accepted data into absent.
pub(crate) fn read_console(root: &Path) -> Result<ConsoleRead, GatewayError> {
    let lock = if root.exists() {
        ensure_directory(root)?;
        let lock = open_lock(root)?;
        lock.try_lock_shared()
            .map_err(|error| failure(format!("Conversation storage is being upgraded: {error}")))?;
        Some(lock)
    } else {
        None
    };
    Ok(ConsoleRead {
        path: console_database_path(root)?,
        _lock: lock,
    })
}

fn open_lock(root: &Path) -> Result<File, GatewayError> {
    let lock_path = root.join(LOCK);
    regular_file(&lock_path)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(lock_path).map_err(failure)
}

fn is_moved_marker(path: &Path) -> Result<bool, GatewayError> {
    if !regular_file(path)? {
        return Ok(false);
    }
    if fs::metadata(path).map_err(failure)?.len() != MOVED_MARKER.len() as u64 {
        return Ok(false);
    }
    Ok(fs::read(path).map_err(failure)? == MOVED_MARKER)
}

fn install_marker(root: &Path, source: &Path) -> Result<(), GatewayError> {
    let path = root.join(format!("{APP_CONSOLE}.{}.moved.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(failure)?;
    file.write_all(MOVED_MARKER).map_err(failure)?;
    file.sync_all().map_err(failure)?;
    fs::rename(path, source).map_err(failure)?;
    sync_directory(root)
}

#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> Result<bool, GatewayError> {
    use std::os::unix::fs::MetadataExt;
    let a = fs::metadata(a).map_err(failure)?;
    let b = fs::metadata(b).map_err(failure)?;
    Ok(a.dev() == b.dev() && a.ino() == b.ino())
}
#[cfg(not(unix))]
fn same_file(_a: &Path, _b: &Path) -> Result<bool, GatewayError> {
    Err(failure(
        "Interrupted file-link adoption needs manual file identity verification on this platform",
    ))
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    BackingUp,
    Prepared,
    Moved,
    Complete,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    phase: Phase,
}

fn failure(error: impl std::fmt::Display) -> GatewayError {
    GatewayError::policy(
        "Cannot upgrade saved conversation storage",
        Some(json!({"error": error.to_string()})),
    )
}

fn regular_file(path: &Path) -> Result<bool, GatewayError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(true),
        Ok(_) => Err(failure(format!(
            "Expected an ordinary file: {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(failure(error)),
    }
}
fn ensure_directory(path: &Path) -> Result<(), GatewayError> {
    let metadata = fs::symlink_metadata(path).map_err(failure)?;
    if !metadata.file_type().is_dir() {
        return Err(failure(format!(
            "Expected an ordinary directory: {}",
            path.display()
        )));
    }
    Ok(())
}
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}
fn sync_directory(path: &Path) -> Result<(), GatewayError> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(failure)?;
    Ok(())
}
fn journal(root: &Path) -> Result<Option<Journal>, GatewayError> {
    let path = root.join(JOURNAL);
    if !regular_file(&path)? {
        return Ok(None);
    }
    let value: Journal =
        serde_json::from_slice(&fs::read(path).map_err(failure)?).map_err(failure)?;
    if value.version != 1 {
        return Err(failure("Unrecognized app storage adoption journal version"));
    }
    Ok(Some(value))
}
fn save_journal(root: &Path, value: &Journal) -> Result<(), GatewayError> {
    // A unique staged file is never reused after a crash. Old staging evidence
    // remains beside the journal and cannot redirect a later write.
    let temporary = root.join(format!("{JOURNAL}.{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(failure)?;
    file.write_all(&serde_json::to_vec(value).map_err(failure)?)
        .map_err(failure)?;
    file.sync_all().map_err(failure)?;
    fs::rename(temporary, root.join(JOURNAL)).map_err(failure)?;
    sync_directory(root)
}

/// Saved-history reads do not create a runtime or migrate storage. During the
/// upgrade they refuse an incomplete move rather than report an empty history.
pub(crate) fn console_database_path(root: &Path) -> Result<PathBuf, GatewayError> {
    let source = root.join(APP_CONSOLE);
    let source_marker = is_moved_marker(&source)?;
    let source_exists = regular_file(&source)? && !source_marker;
    let adoption = journal(root)?;
    if source_marker && adoption.is_none() {
        return Err(failure("Moved conversation marker has no adoption journal"));
    }
    if let Some(value) = adoption {
        if value.phase != Phase::Complete {
            return Err(failure(
                "Conversation storage adoption is unfinished; reconnect to resume it",
            ));
        }
        if source_exists
            || !source_marker
            || !regular_file(&root.join(CANONICAL_CONSOLE_DB_FILE_NAME))?
        {
            return Err(failure(
                "Completed conversation adoption has conflicting or missing files",
            ));
        }
    }
    if let Some(reason) = unfinished_adoption(root) {
        return Err(failure(reason));
    }
    if source_exists {
        // Cold reads retain the old schema decoder. Resolving a new layout here
        // would refuse unrelated predecessor stores before bootstrap can adopt.
        for name in PREDECESSOR_CONSOLE_DB_FILE_NAMES
            .into_iter()
            .chain([CANONICAL_CONSOLE_DB_FILE_NAME])
        {
            for suffix in SUFFIXES {
                if regular_file(&sibling(&root.join(name), suffix))? {
                    return Err(failure(
                        "Both original and adopted conversation stores exist",
                    ));
                }
            }
        }
        return Ok(source);
    }
    MetaStorageLayout::with_injected_roots(root.to_path_buf(), None)
        .console_db()
        .map(|database| database.path)
        .map_err(failure)
}

/// Caller owns offline bootstrap admission for this exact mob root. The app
/// lock serializes this adapter; native adoption independently checks runtime
/// registrations and holds SQLite maintenance fences for its own mutations.
pub(super) async fn prepare(
    root: &Path,
    policy: meerkat_mobkit::TopologyControlPolicy,
) -> Result<PreparedStorage, GatewayError> {
    ensure_directory(root)?;
    let lock = open_lock(root)?;
    lock.try_lock()
        .map_err(|error| failure(format!("Storage upgrade is already owned: {error}")))?;
    let topology_path = root.join("topology-control.json");
    regular_file(&topology_path)?;
    regular_file(&topology_path.with_extension("json.lock"))?;
    // This is the exact native lifetime owner used by both .8 and .9, not an
    // app guess based on current SQLite activity. A running predecessor refuses
    // here before its conversation files or the app journal can be changed.
    let topology = meerkat_mobkit::TopologyController::load_or_default(policy, topology_path)
        .map_err(failure)?;
    let mut request = PredecessorAdoptRequest {
        state_dir: root.to_path_buf(),
        predecessor_home: None,
        gateway_home: None,
        homes_explicit: true,
        mode: MigrateMode::DryRun,
    };
    // A crash between hard-linking the original database and replacing its
    // name with the marker leaves two names for one inode. Native inspection
    // correctly refuses that state, so finish only the already-journaled app
    // move under custody before asking native adoption to inspect its slot.
    // Fresh migrations still validate every native store before moving ours.
    let recovering = journal(root)?.is_some_and(|value| value.phase != Phase::Complete);
    let plan = if recovering {
        None
    } else {
        let plan = adopt_predecessor_state(&request).await;
        if plan.has_errors() {
            return Err(failure(plan.errors.join("; ")));
        }
        Some(plan)
    };
    let root_owned = root.to_path_buf();
    // The physical file-copy task retains custody if this async caller is
    // cancelled. A later bootstrap cannot overlap that unfinished worker.
    let (lock, topology, app_moved) = tokio::task::spawn_blocking(move || {
        let result = stage_console(&root_owned);
        (lock, topology, result)
    })
    .await
    .map_err(failure)?;
    let custody = PreparedStorage {
        _lock: lock,
        topology: Some(topology),
    };
    let app_moved = app_moved?;
    let plan = match plan {
        Some(plan) => plan,
        None => {
            let plan = adopt_predecessor_state(&request).await;
            if plan.has_errors() {
                return Err(failure(plan.errors.join("; ")));
            }
            plan
        }
    };
    if !app_moved && plan.actions.is_empty() && unfinished_adoption(root).is_none() {
        return Ok(custody);
    }
    request.mode = MigrateMode::Apply;
    let report = adopt_predecessor_state(&request).await;
    if report.has_errors() || !report.complete {
        return Err(failure(format!(
            "Native storage adoption is incomplete: {}",
            report.errors.join("; ")
        )));
    }
    if app_moved {
        save_journal(
            root,
            &Journal {
                version: 1,
                phase: Phase::Complete,
            },
        )?;
    }
    Ok(custody)
}

fn stage_console(root: &Path) -> Result<bool, GatewayError> {
    let source = root.join(APP_CONSOLE);
    let predecessor = root.join(PREDECESSOR_CONSOLE_DB_FILE_NAMES[0]);
    let canonical = root.join(CANONICAL_CONSOLE_DB_FILE_NAME);
    // Check every path before changing any. Never follow a symlink or merge
    // two histories, including stale WAL/SHM files without their database.
    for main in [
        &source,
        &predecessor,
        &canonical,
        &root.join(PREDECESSOR_CONSOLE_DB_FILE_NAMES[1]),
    ] {
        for suffix in SUFFIXES {
            regular_file(&sibling(main, suffix))?;
        }
    }
    let mut value = journal(root)?;
    if value.is_none() && is_moved_marker(&source)? {
        return Err(failure("Moved conversation marker has no adoption journal"));
    }
    if value
        .as_ref()
        .is_some_and(|value| value.phase == Phase::Complete)
    {
        if !is_moved_marker(&source)? || !regular_file(&canonical)? {
            return Err(failure(
                "Completed conversation adoption has conflicting or missing files",
            ));
        }
        return Ok(false);
    }
    if value.is_none() && !regular_file(&source)? {
        if SUFFIXES[1..]
            .iter()
            .any(|suffix| sibling(&source, suffix).exists())
        {
            return Err(failure(
                "Original conversation store has orphaned SQLite sidecars",
            ));
        }
        return Ok(false);
    }
    regular_file(&meerkat_sqlite::fence_lock_path(&source))?;
    let _source_fence = meerkat_sqlite::ExclusiveFence::try_acquire(&source)
        .map_err(failure)?
        .ok_or_else(|| failure("Original conversation storage is still in use"))?;
    if value.is_none() {
        for name in PREDECESSOR_CONSOLE_DB_FILE_NAMES
            .into_iter()
            .chain([CANONICAL_CONSOLE_DB_FILE_NAME])
        {
            if SUFFIXES
                .iter()
                .any(|suffix| sibling(&root.join(name), suffix).exists())
            {
                return Err(failure(
                    "A native console store already exists beside the original app store",
                ));
            }
        }
        if root.join(BACKUP).exists() {
            return Err(failure(
                "Conversation backup exists without its adoption journal",
            ));
        }
        value = Some(Journal {
            version: 1,
            phase: Phase::BackingUp,
        });
        save_journal(root, value.as_ref().expect("journal assigned"))?;
    }
    let mut value = value.expect("existing or created journal");
    if value.phase == Phase::BackingUp {
        if !regular_file(&source)? || regular_file(&predecessor)? || regular_file(&canonical)? {
            return Err(failure("Conversation storage changed during backup"));
        }
        backup_family(root, &source)?;
        value.phase = Phase::Prepared;
        save_journal(root, &value)?;
    }
    if value.phase == Phase::Prepared {
        if regular_file(&canonical)? {
            return Err(failure(
                "Canonical conversation storage appeared before native adoption",
            ));
        }
        regular_file(&meerkat_sqlite::fence_lock_path(&predecessor))?;
        let _destination_fence = meerkat_sqlite::ExclusiveFence::try_acquire(&predecessor)
            .map_err(failure)?
            .ok_or_else(|| failure("Native conversation destination is in use"))?;
        if regular_file(&source)? && !is_moved_marker(&source)? {
            if regular_file(&predecessor)? && !same_file(&source, &predecessor)? {
                return Err(failure(
                    "Both original and native predecessor conversation stores exist",
                ));
            }
            let connection = rusqlite::Connection::open_with_flags(
                &source,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
            )
            .map_err(failure)?;
            connection
                .busy_timeout(std::time::Duration::ZERO)
                .map_err(failure)?;
            let (busy, _, _): (i64, i64, i64) = connection
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .map_err(failure)?;
            if busy != 0 {
                return Err(failure(
                    "Conversation WAL is busy; close the previous app before upgrading",
                ));
            }
            drop(connection);
            // Keep the DB inode reachable while atomically replacing its old
            // name with a non-SQLite marker. There is no missing-name window in
            // which an old app could create a second empty conversation store.
            if !regular_file(&predecessor)? {
                fs::hard_link(&source, &predecessor).map_err(failure)?;
                sync_directory(root)?;
            }
            install_marker(root, &source)?;
        } else if !regular_file(&predecessor)? {
            return Err(failure("Prepared conversation store is missing"));
        }
        for suffix in &SUFFIXES[1..] {
            let from = sibling(&source, suffix);
            let to = sibling(&predecessor, suffix);
            if regular_file(&from)? {
                if regular_file(&to)? {
                    return Err(failure("Competing SQLite sidecars during adoption"));
                }
                fs::rename(from, to).map_err(failure)?;
            }
        }
        sync_directory(root)?;
        value.phase = Phase::Moved;
        save_journal(root, &value)?;
    }
    if !is_moved_marker(&source)? || (!regular_file(&predecessor)? && !regular_file(&canonical)?) {
        return Err(failure(
            "Moved conversation store has conflicting or missing files",
        ));
    }
    Ok(true)
}

fn backup_family(root: &Path, source: &Path) -> Result<(), GatewayError> {
    let backup = root.join(BACKUP);
    match fs::create_dir(&backup) {
        Ok(()) => sync_directory(root)?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            ensure_directory(&backup)?
        }
        Err(error) => return Err(failure(error)),
    }
    for suffix in SUFFIXES {
        let from = sibling(source, suffix);
        if !regular_file(&from)? {
            continue;
        }
        let to = backup.join(format!("{APP_CONSOLE}{suffix}"));
        if regular_file(&to)? {
            if digest(&from)? != digest(&to)? {
                return Err(failure(
                    "Conversation backup differs from the untouched source",
                ));
            }
        } else {
            let temporary = backup.join(format!(
                "{APP_CONSOLE}{suffix}.{}.tmp",
                uuid::Uuid::new_v4()
            ));
            let mut input = File::open(&from).map_err(failure)?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(failure)?;
            output
                .set_permissions(input.metadata().map_err(failure)?.permissions())
                .map_err(failure)?;
            std::io::copy(&mut input, &mut output).map_err(failure)?;
            output.sync_all().map_err(failure)?;
            fs::rename(temporary, &to).map_err(failure)?;
            sync_directory(&backup)?;
        }
    }
    sync_directory(&backup)
}
fn digest(path: &Path) -> Result<Vec<u8>, GatewayError> {
    use sha2::{Digest, Sha256};
    let mut input = File::open(path).map_err(failure)?;
    let mut hash = Sha256::new();
    let mut bytes = [0; 8192];
    loop {
        let read = input.read(&mut bytes).map_err(failure)?;
        if read == 0 {
            return Ok(hash.finalize().to_vec());
        }
        hash.update(&bytes[..read]);
    }
}

#[cfg(test)]
mod tests;
