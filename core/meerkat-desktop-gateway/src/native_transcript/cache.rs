//! Bounded, disposable decodes of freshly revalidated native whole-blob rows.
use meerkat_core::{Session, SessionId};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::SystemTime,
};

// These limits bound retained documents and entry count, not measured Rust
// heap. Large valid documents remain readable through the uncached decoder.
const MAX_ENTRIES: usize = 16;
const MAX_RETAINED_BYTES: usize = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES: usize = 8 * 1024 * 1024;

pub(super) type Store = Mutex<DecodeCache>;

pub(super) fn shared() -> &'static Store {
    static CACHE: OnceLock<Store> = OnceLock::new();
    CACHE.get_or_init(Store::default)
}

#[derive(Clone, PartialEq, Eq)]
struct DatabaseIdentity {
    path: PathBuf,
    device: u64,
    inode: u64,
    created: SystemTime,
}

pub(super) struct Database {
    identity: DatabaseIdentity,
}

impl Database {
    #[cfg(unix)]
    pub(super) fn capture(path: &Path) -> Option<Self> {
        use std::os::unix::fs::MetadataExt;
        let canonical = path.canonicalize().ok()?;
        // Do not open/close a separate raw descriptor: closing one can release
        // process-level POSIX locks held by a live SQLite connection. Metadata
        // identifies the path without interfering with SQLite's lock owner.
        let metadata = std::fs::metadata(&canonical).ok()?;
        if !metadata.is_file() {
            return None;
        }
        Some(Self {
            identity: DatabaseIdentity {
                path: canonical,
                device: metadata.dev(),
                inode: metadata.ino(),
                created: metadata.created().ok()?,
            },
        })
    }

    // A platform without a stable file identity keeps the original validated
    // read path rather than guessing identity from timestamps or file size.
    #[cfg(not(unix))]
    pub(super) fn capture(_path: &Path) -> Option<Self> {
        None
    }

    pub(super) fn still_current(&self, path: &Path) -> bool {
        Self::capture(path).is_some_and(|current| current.identity == self.identity)
    }

    pub(super) fn key(&self, session: &SessionId, revision: i64, digest: &str) -> Key {
        Key {
            database: self.identity.clone(),
            session: session.to_string(),
            revision,
            digest: digest.to_owned(),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Key {
    database: DatabaseIdentity,
    session: String,
    revision: i64,
    digest: String,
}

struct Entry {
    key: Key,
    bytes: Vec<u8>,
    session: Arc<Session>,
}

#[derive(Default)]
pub(super) struct DecodeCache {
    entries: VecDeque<Entry>,
    retained_bytes: usize,
}

impl DecodeCache {
    pub(super) fn get(&mut self, key: &Key, bytes: &[u8]) -> Option<Arc<Session>> {
        let index = self.entries.iter().position(|entry| &entry.key == key)?;
        let entry = self.entries.remove(index)?;
        if entry.bytes != bytes {
            // Even an unchanged authority revision/digest may have a corrupt
            // body. A miss forces native decode and digest validation again.
            self.retained_bytes -= entry.bytes.len();
            return None;
        }
        let session = Arc::clone(&entry.session);
        self.entries.push_back(entry);
        Some(session)
    }

    pub(super) fn insert(&mut self, key: Key, bytes: Vec<u8>, session: Arc<Session>) {
        // Keep only the most recently read revision for a session at a path,
        // including when that path has been replaced with another database.
        self.entries.retain(|entry| {
            let retain =
                entry.key.database.path != key.database.path || entry.key.session != key.session;
            if !retain {
                self.retained_bytes -= entry.bytes.len();
            }
            retain
        });
        if bytes.len() > MAX_ENTRY_BYTES || bytes.len() > MAX_RETAINED_BYTES {
            return;
        }
        while self.entries.len() >= MAX_ENTRIES
            || self.retained_bytes + bytes.len() > MAX_RETAINED_BYTES
        {
            let Some(entry) = self.entries.pop_front() else {
                break;
            };
            self.retained_bytes -= entry.bytes.len();
        }
        self.retained_bytes += bytes.len();
        self.entries.push_back(Entry {
            key,
            bytes,
            session,
        });
    }
}

#[cfg(all(test, unix))]
mod tests;
