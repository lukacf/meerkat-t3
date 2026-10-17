//! Host-selected storage locations, consumed by the native config and credential APIs.
//! This selects a native backend; it does not copy accounts or interpret auth state.

use std::path::{Component, PathBuf};

use meerkat_providers::auth_store::TokenStoreBackend;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug)]
pub(crate) struct DesktopAuthScope {
    root: PathBuf,
}

impl DesktopAuthScope {
    pub(crate) fn from_env() -> Result<Option<Self>, String> {
        std::env::var_os("MEERKAT_DESKTOP_AUTH_ROOT")
            .map(|root| Self::new(PathBuf::from(root)))
            .transpose()
    }

    pub(crate) fn new(root: PathBuf) -> Result<Self, String> {
        if !root.is_absolute()
            || root.to_str().is_none()
            || root
                .components()
                .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        {
            return Err("The desktop auth root must be a normalized absolute path".into());
        }
        Ok(Self { root })
    }

    pub(crate) fn global_config_path(&self) -> PathBuf {
        self.root.join("config.toml")
    }

    pub(crate) fn state_root(&self) -> PathBuf {
        self.root.join("realms")
    }

    pub(crate) fn token_backend(&self) -> TokenStoreBackend {
        // A stable service name separates this host's native keyring entries
        // as well as its file fallback and native cross-process refresh locks.
        let digest = Sha256::digest(self.root.as_os_str().as_encoded_bytes());
        TokenStoreBackend::Auto {
            root: self.root.join("credentials"),
            service_name: format!("meerkat-t3-auth-{digest:x}"),
        }
    }

    #[cfg(test)]
    pub(crate) fn root(&self) -> &std::path::Path {
        &self.root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_auth_scope_selects_distinct_native_storage_without_os_access() {
        let directory = tempfile::tempdir().unwrap();
        let first = DesktopAuthScope::new(directory.path().join("first")).unwrap();
        let second = DesktopAuthScope::new(directory.path().join("second")).unwrap();
        let first_backend = first.token_backend();
        let second_backend = second.token_backend();
        let default_backend = TokenStoreBackend::default_keyring_auto().unwrap();
        assert_ne!(first_backend, second_backend);
        assert_ne!(first_backend, default_backend);
        assert_eq!(
            first_backend,
            DesktopAuthScope::new(first.root().to_owned())
                .unwrap()
                .token_backend()
        );
        assert_eq!(
            first_backend.refresh_lock_dir(),
            Some(first.root().join("credentials/refresh-locks"))
        );
        assert_eq!(first.global_config_path(), first.root().join("config.toml"));
        assert_ne!(first.state_root(), second.state_root());
        assert!(DesktopAuthScope::new(PathBuf::from("relative")).is_err());
        assert!(DesktopAuthScope::new(directory.path().join("child/../other")).is_err());
        // Selecting native constructors must not create or inspect credential files.
        assert!(!first.root().exists());
        assert!(!second.root().exists());
    }
}
