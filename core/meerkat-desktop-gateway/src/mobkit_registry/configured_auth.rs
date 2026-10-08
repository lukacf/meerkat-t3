//! Bind a desktop-owned mob to its workspace's canonical credential chain.
use super::*;

pub(super) fn mob_config_store(
    inner: Arc<dyn ConfigStore>,
    mob_id: &str,
    workspace_realm: RealmId,
) -> Result<Arc<MobConfigStore>, String> {
    let mob_realm = meerkat_core::mob_realm_id(mob_id)
        .map_err(|error| format!("Invalid native mob realm: {error}"))?;
    Ok(Arc::new(MobConfigStore {
        inner,
        mob_realm,
        workspace_realm,
        child_realms: std::sync::OnceLock::new(),
    }))
}

pub(super) struct MobConfigStore {
    inner: Arc<dyn ConfigStore>,
    mob_realm: RealmId,
    workspace_realm: RealmId,
    child_realms: std::sync::OnceLock<Arc<ChildRealmReader>>,
}

type ChildRealmFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<RealmId>, String>> + Send>>;
type ChildRealmReader = dyn Fn() -> ChildRealmFuture + Send + Sync;

impl MobConfigStore {
    pub(super) fn bind_child_realms(&self, reader: Arc<ChildRealmReader>) -> Result<(), String> {
        self.child_realms
            .set(reader)
            .map_err(|_| "Native child-mob configuration owner was already bound".to_string())
    }

    fn parent_realm(&self, config: &mut Config, mob_realm: &RealmId) -> Result<(), ConfigError> {
        // MobKit owns the mob realm. Its desktop host owns only this exact
        // parent relationship; native resolution still owns every binding.
        let realm = config.realm.entry(mob_realm.to_string()).or_default();
        if realm
            .parent
            .as_ref()
            .is_some_and(|parent| parent != &self.workspace_realm)
        {
            return Err(ConfigError::Validation(format!(
                "Native mob {} is configured under a different workspace realm",
                mob_realm,
            )));
        }
        realm.parent = Some(self.workspace_realm.clone());
        Ok(())
    }

    async fn scoped(&self, mut config: Config) -> Result<Config, ConfigError> {
        self.parent_realm(&mut config, &self.mob_realm)?;
        if let Some(read_children) = self.child_realms.get() {
            // Read exact membership from the owning native registry on every
            // build. A child is inserted before it can spawn a member; this
            // snapshot does not wait for child actors or cache their IDs.
            // This state is composed without persistent child restoration.
            // A persistent composition must provision realm links before
            // restoration instead of recursing from a config read.
            for realm in read_children().await.map_err(ConfigError::Validation)? {
                self.parent_realm(&mut config, &realm)?;
            }
        }
        // An unconfigured workspace still participates in the canonical
        // chain and inherits global settings. No bindings are synthesized.
        config
            .realm
            .entry(self.workspace_realm.to_string())
            .or_default();
        Ok(config)
    }
}

#[async_trait::async_trait]
impl ConfigStore for MobConfigStore {
    async fn get(&self) -> Result<Config, ConfigError> {
        self.scoped(self.inner.get().await?).await
    }

    async fn set(&self, _config: Config) -> Result<(), ConfigError> {
        Err(ConfigError::Validation(
            "Write workspace configuration through its owning config runtime".into(),
        ))
    }

    async fn patch(&self, _delta: ConfigDelta) -> Result<Config, ConfigError> {
        Err(ConfigError::Validation(
            "Write workspace configuration through its owning config runtime".into(),
        ))
    }
}

#[cfg(test)]
mod tests;
