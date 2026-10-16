//! Consumer build identity, derived from the lock used by Cargo.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(crate) fn build_info() -> Value {
    build_info_from_lock(include_str!("../../Cargo.lock"))
}

fn locked_package_version<'a>(lock: &'a toml::Value, names: &[&str]) -> Option<&'a str> {
    let mut matches = lock
        .get("package")?
        .as_array()?
        .iter()
        .filter(|package| package.get("name").and_then(toml::Value::as_str)
            .is_some_and(|name| names.contains(&name)));
    let version = matches.next()?.get("version")?.as_str()?;
    // A path or git package is still a resolved Cargo dependency. A name alone
    // cannot identify one of multiple packages, so leave ambiguity explicit.
    if version.trim().is_empty() || matches.next().is_some() {
        return None;
    }
    Some(version)
}

fn build_info_from_lock(lock: &str) -> Value {
    let parsed = toml::from_str::<toml::Value>(lock).ok();
    let version = |names: &[&str]| parsed.as_ref().and_then(|lock| locked_package_version(lock, names));
    json!({
        "gatewayVersion": env!("CARGO_PKG_VERSION"),
        "meerkatVersion": version(&["meerkat"]),
        // Cargo records the published package name, not the dependency alias.
        // Keep the app wire field stable across MobKit's 0.9 package rename.
        "mobkitVersion": version(&["meerkat-meta", "meerkat-mobkit"]),
        // Version labels do not claim registry publication or source equality.
        // The exact lock remains part of the manifest/health identity check.
        "cargoLockSha256": format!("{:x}", Sha256::digest(lock.as_bytes())),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_the_current_locked_runtime() {
        let info = build_info();
        assert!(info["meerkatVersion"].as_str().is_some_and(|value| !value.is_empty()));
        assert!(info["mobkitVersion"].as_str().is_some_and(|value| !value.is_empty()));
        assert_eq!(info["cargoLockSha256"].as_str().unwrap().len(), 64);
    }

    #[test]
    fn reports_registry_versions() {
        let info = build_info_from_lock(r#"
version = 4
[[package]]
name = "unrelated"
version = "9.9.9"
[[package]]
name = "meerkat"
version = "0.8.51"
source = "registry+https://github.com/rust-lang/crates.io-index"
[[package]]
name = "meerkat-mobkit"
version = "0.8.46"
source = "registry+https://github.com/rust-lang/crates.io-index"
"#);
        assert_eq!(info["meerkatVersion"], "0.8.51");
        assert_eq!(info["mobkitVersion"], "0.8.46");
    }

    #[test]
    fn reports_published_meta_versions_in_the_existing_mobkit_field() {
        let info = build_info_from_lock(r#"
version = 4
[[package]]
name = "meerkat"
version = "0.9.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
[[package]]
name = "meerkat-meta"
version = "0.9.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
"#);
        assert_eq!(info["meerkatVersion"], "0.9.1");
        assert_eq!(info["mobkitVersion"], "0.9.1");
    }

    #[test]
    fn refuses_ambiguous_meta_and_legacy_mobkit_packages() {
        for names in [
            ["meerkat-meta", "meerkat-mobkit"],
            ["meerkat-mobkit", "meerkat-meta"],
            ["meerkat-meta", "meerkat-meta"],
        ] {
            let lock = names.iter().map(|name|
                format!("[[package]]\nname = '{name}'\nversion = '0.9.1'\n")
            ).collect::<String>();
            assert!(build_info_from_lock(&lock)["mobkitVersion"].is_null());
        }
    }

    #[test]
    fn reports_path_package_versions_without_a_source_field() {
        let info = build_info_from_lock(r#"
version = 4
[[package]]
name = "meerkat"
version = "0.8.52"
[[package]]
name = "meerkat-mobkit"
version = "0.8.49"
"#);
        assert_eq!(info["meerkatVersion"], "0.8.52");
        assert_eq!(info["mobkitVersion"], "0.8.49");
    }

    #[test]
    fn reports_a_unique_git_package_without_claiming_registry_origin() {
        let info = build_info_from_lock(r#"
version = 4
[[package]]
name = "meerkat"
version = "0.8.52"
source = "git+https://example.invalid/meerkat?rev=0123456789#0123456789"
"#);
        assert_eq!(info["meerkatVersion"], "0.8.52");
    }

    #[test]
    fn refuses_missing_malformed_or_empty_versions() {
        for lock in [
            "not valid = [",
            "version = 4",
            "[[package]]\nname = 'other'\nversion = '1.2.3'",
            "[[package]]\nname = 'meerkat'",
            "[[package]]\nname = 'meerkat'\nversion = 52",
            "[[package]]\nname = 'meerkat'\nversion = ' '",
        ] {
            assert!(build_info_from_lock(lock)["meerkatVersion"].is_null(), "{lock}");
        }
    }

    #[test]
    fn refuses_duplicate_names_even_when_versions_match() {
        for second_version in ["0.8.51", "0.8.52"] {
            let lock = format!(r#"
version = 4
[[package]]
name = "meerkat"
version = "0.8.52"
[[package]]
name = "meerkat"
version = "{second_version}"
source = "registry+https://github.com/rust-lang/crates.io-index"
"#);
            assert!(build_info_from_lock(&lock)["meerkatVersion"].is_null());
        }
    }

    #[test]
    fn binds_the_exact_lock_bytes_not_just_version_labels() {
        let lock = "[[package]]\nname = 'meerkat'\nversion = '0.8.52'\n";
        let first = build_info_from_lock(lock);
        let second = build_info_from_lock(&format!("{lock}# different locked bytes\n"));
        assert_eq!(first["meerkatVersion"], second["meerkatVersion"]);
        assert_eq!(first["cargoLockSha256"], format!("{:x}", Sha256::digest(lock.as_bytes())));
        assert_ne!(first["cargoLockSha256"], second["cargoLockSha256"]);
    }
}
