//! Consumer build identity, derived from the lock used by Cargo.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(crate) fn build_info() -> Value {
    let lock = include_str!("../../Cargo.lock");
    let release = |name: &str| {
        lock.split("[[package]]").find_map(|package| {
            let mut package_name = None;
            let mut version = None;
            let mut registry = false;
            for line in package.lines() {
                if let Some(value) = line.strip_prefix("name = \"") {
                    package_name = value.strip_suffix('"');
                }
                if let Some(value) = line.strip_prefix("version = \"") {
                    version = value.strip_suffix('"');
                }
                registry |= line.starts_with("source = \"registry+");
            }
            (package_name == Some(name) && registry).then_some(version).flatten()
        })
    };
    json!({
        "gatewayVersion": env!("CARGO_PKG_VERSION"),
        "meerkatVersion": release("meerkat"),
        "mobkitVersion": release("meerkat-mobkit"),
        "cargoLockSha256": format!("{:x}", Sha256::digest(lock.as_bytes())),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn identifies_the_locked_released_runtime() {
        let info = super::build_info();
        assert_eq!(info["meerkatVersion"], "0.8.51");
        assert_eq!(info["mobkitVersion"], "0.8.46");
        assert_eq!(info["cargoLockSha256"].as_str().unwrap().len(), 64);
    }
}
