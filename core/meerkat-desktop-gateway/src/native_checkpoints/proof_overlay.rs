//! Test-only proof of the released HTTP hook boundary and its payload limitation.
use super::*;
use std::collections::HashMap;

use base64::Engine;
use meerkat_core::{
    Config, ConfigDelta, ConfigError, ConfigStore, HookAdapterConfig, HookEntryConfig,
    HookExecutionMode, HookId, HookPoint,
};
use serde::Serialize;

const HOOK_PREFIX: &str = "desktop.workspace-checkpoint.";

#[derive(Clone)]
pub(super) struct Bridge {
    url: String,
    token: String,
}

impl Bridge {
    pub(super) fn new(url: String, token: String) -> Result<Self, String> {
        let parsed =
            reqwest::Url::parse(&url).map_err(|_| "Invalid checkpoint callback URL".to_string())?;
        if parsed.scheme() != "http"
            || !matches!(parsed.host_str(), Some("127.0.0.1" | "[::1]" | "::1"))
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || token.trim().is_empty()
            || reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")).is_err()
        {
            return Err(
                "Checkpoint callbacks require an authenticated loopback HTTP endpoint".into(),
            );
        }
        Ok(Self { url, token })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Scope<'a> {
    pub(super) project_path: &'a PathBuf,
    pub(super) workspace: &'a PathBuf,
    pub(super) state_root: &'a PathBuf,
    pub(super) mob_id: &'a str,
}

pub(crate) fn runtime_config_store(
    store: Arc<dyn ConfigStore>,
    input: &crate::mobkit_registry::CreateMobInput,
) -> Result<Arc<dyn ConfigStore>, String> {
    let bridge = test_bridges()
        .lock()
        .unwrap()
        .get(&input.state_root)
        .cloned();
    let Some(bridge) = bridge else {
        return Ok(store);
    };
    let scope = base64::engine::general_purpose::STANDARD.encode(
        serde_json::to_vec(&Scope {
            project_path: &input.config_project_path,
            workspace: &input.project_path,
            state_root: &input.state_root,
            mob_id: &input.mob_id,
        })
        .map_err(|error| error.to_string())?,
    );
    let headers = HashMap::from([
        (
            "authorization".to_string(),
            format!("Bearer {}", bridge.token),
        ),
        ("x-t3-checkpoint-scope".to_string(), scope),
    ]);
    let entries = [
        HookPoint::RunStarted,
        HookPoint::RunCompleted,
        HookPoint::RunFailed,
    ]
    .into_iter()
    .map(|point| HookEntryConfig {
        id: HookId::new(format!("{HOOK_PREFIX}{point:?}")),
        point,
        mode: HookExecutionMode::Foreground,
        priority: -10_000,
        timeout_ms: Some(30_000),
        runtime: HookAdapterConfig::http(&bridge.url, "POST", headers.clone()),
        ..Default::default()
    })
    .collect();
    Ok(Arc::new(RuntimeConfigStore {
        inner: store,
        entries,
    }))
}

struct RuntimeConfigStore {
    inner: Arc<dyn ConfigStore>,
    entries: Vec<HookEntryConfig>,
}
impl RuntimeConfigStore {
    fn strip(&self, config: &mut Config) {
        config
            .hooks
            .entries
            .retain(|entry| !self.entries.iter().any(|own| own.id == entry.id));
    }
    fn overlay(&self, mut config: Config) -> Config {
        self.strip(&mut config);
        config.hooks.entries.extend(self.entries.clone());
        config
    }
}
#[async_trait::async_trait]
impl ConfigStore for RuntimeConfigStore {
    async fn get(&self) -> Result<Config, ConfigError> {
        Ok(self.overlay(self.inner.get().await?))
    }
    async fn set(&self, mut config: Config) -> Result<(), ConfigError> {
        self.strip(&mut config);
        self.inner.set(config).await
    }
    async fn patch(&self, delta: ConfigDelta) -> Result<Config, ConfigError> {
        // Patches operate only on the authoritative raw store, never a copied
        // effective document. Runtime overlays are added to the returned view.
        Ok(self.overlay(self.inner.patch(delta).await?))
    }
}

pub(super) fn test_bridges() -> &'static std::sync::Mutex<HashMap<PathBuf, Bridge>> {
    static BRIDGES: std::sync::OnceLock<std::sync::Mutex<HashMap<PathBuf, Bridge>>> =
        std::sync::OnceLock::new();
    BRIDGES.get_or_init(Default::default)
}
