use std::sync::atomic::{AtomicBool, Ordering};

use meerkat_providers::auth_store::{EphemeralTokenStore, InMemoryCoordinator, TokenStoreError};
use tokio::sync::Notify;

use super::*;

#[derive(Default)]
struct ControlledStore {
    inner: EphemeralTokenStore,
    fail_load: AtomicBool,
    fail_after_save: AtomicBool,
    pause_load: AtomicBool,
    entered: Notify,
    resume: Notify,
}

#[async_trait::async_trait]
impl TokenStore for ControlledStore {
    async fn load(&self, key: &TokenKey) -> Result<Option<PersistedTokens>, TokenStoreError> {
        if self.fail_load.load(Ordering::SeqCst) {
            return Err(TokenStoreError::Unavailable("isolated activation read failure".into()));
        }
        if self.pause_load.swap(false, Ordering::SeqCst) {
            self.entered.notify_one();
            self.resume.notified().await;
        }
        self.inner.load(key).await
    }
    async fn save(&self, key: &TokenKey, tokens: &PersistedTokens) -> Result<(), TokenStoreError> {
        self.inner.save(key, tokens).await?;
        if self.fail_after_save.load(Ordering::SeqCst) {
            self.fail_load.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
    async fn clear(&self, key: &TokenKey) -> Result<(), TokenStoreError> {
        self.inner.clear(key).await
    }
    async fn list(&self) -> Result<Vec<TokenKey>, TokenStoreError> { self.inner.list().await }
    async fn observe_status(&self, key: &TokenKey) -> Result<meerkat_providers::auth_store::TokenStoreObservation, TokenStoreError> {
        // This in-memory fixture retains its deterministic failure and CAS
        // pause at the observation seam used by account activation.
        if self.fail_load.load(Ordering::SeqCst) {
            return Err(TokenStoreError::Unavailable("isolated activation read failure".into()));
        }
        if self.pause_load.swap(false, Ordering::SeqCst) {
            self.entered.notify_one();
            self.resume.notified().await;
        }
        self.inner.observe_status(key).await
    }
    fn backend_name(&self) -> &'static str { "isolated-activation-fixture" }
}

struct Fixture { auth: DesktopProviderAuth, store: Arc<ControlledStore> }

impl Fixture {
    fn new() -> Self {
        let store = Arc::new(ControlledStore::default());
        Self {
            auth: DesktopProviderAuth {
                auth_scope: Ok(None),
                global_config_path: default_global_config_path(),
                copilot_accounts: Default::default(), account_mutations: Default::default(),
                auth_http: auth_http_client(),
                persistence: Ok(ProviderAuthPersistence::new(store.clone(), Arc::new(InMemoryCoordinator::new()))),
                authority: meerkat_runtime::MeerkatMachine::ephemeral().provider_auth_runtime_authority(),
            }, store,
        }
    }
    async fn configure(&self, method: &str) -> Value {
        self.auth.configure(Some(&json!({"methodId":method}))).await.unwrap()["connection"].clone()
    }
    async fn config(&self) -> Config { self.auth.global_runtime().unwrap().get().await.unwrap().config }
    async fn target(&self, row: &Value) -> ResolvedConnectionTarget {
        resolve_target(&self.config().await, row.as_object().unwrap()).unwrap()
    }
    async fn publish(&self, row: &Value) -> ResolvedConnectionTarget {
        self.publish_until(row, Utc::now() + chrono::Duration::hours(1)).await
    }
    async fn publish_until(&self, row: &Value, expires_at: chrono::DateTime<Utc>) -> ResolvedConnectionTarget {
        let target = self.target(row).await;
        let mode = meerkat_providers::NormalizedAuthMethod::from_auth_profile(&target.auth_profile)
            .and_then(meerkat_providers::NormalizedAuthMethod::persisted_auth_mode).unwrap();
        meerkat_providers::browser_login::save_tokens_and_publish_lifecycle(
            self.auth.persistence().unwrap(), self.auth.authority.generated_auth_lease_handle(),
            target.credential_identity.clone(), PersistedTokens {
                auth_mode:mode, primary_secret:Some("isolated-fixture-token".into()),
                refresh_token:Some("isolated-fixture-refresh".into()), id_token:None,
                expires_at:Some(expires_at),
                last_refresh:Some(Utc::now()), scopes:vec![], account_id:None, metadata:Value::Null,
            },
        ).await.unwrap();
        target
    }
    async fn selected(&self, provider: Provider) -> BindingId {
        resolve_realm_binding_target_for_provider(&self.config().await, provider,
            None, None, None, Some(&RealmId::global()), true).unwrap().auth_binding.binding
    }
}

impl Drop for Fixture {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(self.auth.global_config_path.parent().unwrap()); }
}

#[tokio::test]
async fn completed_chatgpt_activates_over_disconnected_copilot_and_survives_reload() {
    let f = Fixture::new();
    let old = f.configure("github-copilot").await;
    let new = f.configure("openai-chatgpt").await;
    let old_id = old["bindingId"].as_str().unwrap();
    let runtime = f.auth.global_runtime().unwrap();
    let snapshot = runtime.get().await.unwrap();
    let workspace = snapshot.config.realm["global"].clone();
    runtime.patch(ConfigDelta(json!({"realm":{
        "global":{"default_binding":old_id}, "workspace-fixture":workspace,
    }})), Some(snapshot.generation)).await.unwrap();
    let before = f.config().await;
    let target = f.publish(&new).await;
    let result = f.auth.activate_connected_account(&target).await;
    assert_eq!(result, json!({"status":"updated","providers":["openai"]}));
    let after = f.config().await;
    assert_eq!(after.realm["workspace-fixture"], before.realm["workspace-fixture"]);
    assert_eq!(after.realm["global"].default_binding.as_deref(), new["bindingId"].as_str());
    assert_eq!(f.selected(Provider::OpenAI).await, target.auth_binding.binding);
    assert_eq!(f.selected(Provider::Anthropic).await.as_str(), format!("{old_id}_anthropic"));
    assert_eq!(f.selected(Provider::Gemini).await.as_str(), format!("{old_id}_gemini"));
    let status = f.auth.status(Some(&json!({}))).await.unwrap();
    let row = status["connections"].as_array().unwrap().iter()
        .find(|row| row["bindingId"] == new["bindingId"]).unwrap();
    assert_eq!(row["isDefault"], true);
    assert_eq!(row["state"], "connected");
    assert!(!row["models"].as_array().unwrap().is_empty());
    assert_eq!(f.auth.activate_connected_account(&target).await["status"], "unchanged");
}

#[tokio::test]
async fn abandoned_login_does_not_change_default_and_secret_completion_does() {
    let f = Fixture::new();
    let old = f.configure("openai-chatgpt").await;
    let pending = f.configure("openai-chatgpt").await;
    let target = f.target(&pending).await;
    assert_eq!(f.auth.activate_connected_account(&target).await["status"], "unchanged");
    assert_eq!(f.selected(Provider::OpenAI).await.as_str(), old["bindingId"].as_str().unwrap());
    let result = f.auth.configure(Some(&json!({"methodId":"openai-api-key","secret":"isolated-direct-key"}))).await.unwrap();
    assert_eq!(result["defaultActivation"], json!({"status":"updated","providers":["openai"]}));
    assert_eq!(result["connection"]["isDefault"], true);
    assert_eq!(result["connection"]["state"], "connected");
}

#[tokio::test]
async fn connected_and_host_managed_defaults_are_preserved() {
    let f = Fixture::new();
    let first = f.auth.configure(Some(&json!({"methodId":"openai-api-key","secret":"isolated-existing-key"}))).await.unwrap()["connection"].clone();
    let new = f.configure("openai-chatgpt").await;
    let target = f.publish(&new).await;
    assert_eq!(f.auth.activate_connected_account(&target).await["status"], "unchanged");
    assert_eq!(f.selected(Provider::OpenAI).await.as_str(), first["bindingId"].as_str().unwrap());
    let runtime = f.auth.global_runtime().unwrap();
    let snapshot = runtime.get().await.unwrap();
    let mut config = snapshot.config;
    config.realm.get_mut("global").unwrap().auth.get_mut(first["profileId"].as_str().unwrap()).unwrap().source =
        CredentialSourceSpec::ExternalResolver { handle: meerkat_core::ExternalResolverId::new("isolated-external") };
    runtime.patch(ConfigDelta(json!({"realm":{"global":config.realm["global"]}})), Some(snapshot.generation)).await.unwrap();
    assert_eq!(f.auth.activate_connected_account(&target).await["status"], "unchanged");
    assert_eq!(f.selected(Provider::OpenAI).await.as_str(), first["bindingId"].as_str().unwrap());
}

#[tokio::test]
async fn copilot_shared_credential_activates_only_unavailable_families() {
    let f = Fixture::new();
    let old = f.configure("github-copilot").await;
    let live_anthropic = f.auth.configure(Some(&json!({"methodId":"anthropic-api-key","secret":"isolated-anthropic-key"}))).await.unwrap()["connection"].clone();
    let new = f.configure("github-copilot").await;
    let target = f.publish(&new).await;
    assert_eq!(f.auth.activate_connected_account(&target).await,
        json!({"status":"updated","providers":["openai","gemini"]}));
    assert_eq!(f.selected(Provider::OpenAI).await, target.auth_binding.binding);
    assert_eq!(f.selected(Provider::Anthropic).await.as_str(), live_anthropic["bindingId"].as_str().unwrap());
    assert_ne!(f.selected(Provider::Gemini).await.as_str(), format!("{}_gemini", old["bindingId"].as_str().unwrap()));
}

#[tokio::test]
async fn read_failure_and_stale_identity_preserve_defaults_without_undoing_credentials() {
    let f = Fixture::new();
    let old = f.configure("openai-chatgpt").await;
    let new = f.configure("openai-chatgpt").await;
    let target = f.publish(&new).await;
    f.store.fail_load.store(true, Ordering::SeqCst);
    assert_eq!(f.auth.activate_connected_account(&target).await["status"], "needs_selection");
    f.store.fail_load.store(false, Ordering::SeqCst);
    assert_eq!(f.selected(Provider::OpenAI).await.as_str(), old["bindingId"].as_str().unwrap());
    assert!(f.store.inner.load(&TokenKey::from_credential_identity(&target.credential_identity)).await.unwrap().is_some());
    let mut stale = target.clone();
    stale.auth_profile.id = "obsolete-profile".into();
    assert_eq!(f.auth.activate_connected_account(&stale).await["status"], "needs_selection");
    assert_eq!(f.selected(Provider::OpenAI).await.as_str(), old["bindingId"].as_str().unwrap());
}

#[tokio::test]
async fn concurrent_config_choice_wins_activation_cas_and_keeps_committed_credential() {
    let f = Fixture::new();
    f.configure("openai-chatgpt").await;
    let new = f.configure("openai-chatgpt").await;
    let chosen = f.configure("openai-chatgpt").await;
    let target = f.publish(&new).await;
    let chosen_target = f.target(&chosen).await;
    f.store.pause_load.store(true, Ordering::SeqCst);
    let activate = f.auth.activate_connected_account(&target);
    let concurrent = async {
        f.store.entered.notified().await;
        let runtime = f.auth.global_runtime().unwrap();
        let snapshot = runtime.get().await.unwrap();
        runtime.patch(default_selection_delta(&snapshot.config.realm["global"],
            &[(Provider::OpenAI, chosen_target.auth_binding.binding.clone())]), Some(snapshot.generation)).await.unwrap();
        f.store.resume.notify_one();
    };
    let (result, ()) = tokio::join!(activate, concurrent);
    assert_eq!(result, json!({"status":"needs_selection","providers":[]}));
    assert_eq!(f.selected(Provider::OpenAI).await, chosen_target.auth_binding.binding);
    assert!(f.store.inner.load(&TokenKey::from_credential_identity(&target.credential_identity)).await.unwrap().is_some());
}

#[tokio::test]
async fn native_refreshing_default_is_preserved_and_reauth_required_default_is_replaced() {
    let f = Fixture::new();
    let old = f.configure("openai-chatgpt").await;
    let new = f.configure("openai-chatgpt").await;
    let original = f.publish(&old).await;
    let target = f.publish(&new).await;
    let key = meerkat_core::handles::LeaseKey::from_credential_identity(&original.credential_identity);
    f.auth.authority.generated_auth_lease_handle().begin_refresh(&key).unwrap();
    // Native authority permits the still-valid credential during a background
    // refresh. It remains a usable default and must not be replaced.
    assert_eq!(f.auth.account_credential_status(&f.config().await, &original).await.unwrap()["state"], "connected");
    assert_eq!(f.auth.activate_connected_account(&target).await["status"], "unchanged");
    assert_eq!(f.selected(Provider::OpenAI).await, original.auth_binding.binding);

    f.publish_until(&old, Utc::now() - chrono::Duration::minutes(5)).await;
    let runtime = f.auth.global_runtime().unwrap();
    let snapshot = runtime.get().await.unwrap();
    let mut config = snapshot.config;
    config.realm.get_mut("global").unwrap().auth.get_mut(old["profileId"].as_str().unwrap()).unwrap()
        .constraints.allow_refresh = false;
    runtime.patch(ConfigDelta(json!({"realm":{"global":config.realm["global"]}})), Some(snapshot.generation)).await.unwrap();
    assert_eq!(f.auth.account_credential_status(&f.config().await, &f.target(&old).await).await.unwrap()["state"], "reauth_required");
    assert_eq!(f.auth.activate_connected_account(&target).await,
        json!({"status":"updated","providers":["openai"]}));
}

#[tokio::test]
async fn successful_public_key_save_keeps_receipt_when_post_commit_reads_fail() {
    let f = Fixture::new();
    f.configure("openai-chatgpt").await;
    f.store.fail_after_save.store(true, Ordering::SeqCst);
    let receipt = f.auth.configure(Some(&json!({
        "methodId":"openai-api-key", "secret":"isolated-committed-key",
    }))).await.expect("saved credentials must not be reported as a failed save");
    assert_eq!(receipt["credentialsSaved"], true);
    assert_eq!(receipt["connection"]["state"], "unknown");
    assert_eq!(receipt["connection"]["models"], json!([]));
    assert!(receipt["connection"].get("isDefault").is_none());
    assert_eq!(receipt["defaultActivation"], json!({"status":"needs_selection","providers":[]}));
    f.store.fail_load.store(false, Ordering::SeqCst);
    let target = f.target(&receipt["connection"]).await;
    assert!(f.store.inner.load(&TokenKey::from_credential_identity(&target.credential_identity)).await.unwrap().is_some());
    assert_eq!(f.auth.account_credential_status(&f.config().await, &target).await.unwrap()["state"], "connected");
}


#[tokio::test]
async fn activated_chatgpt_rehydrates_with_a_fresh_auth_authority() {
    let f = Fixture::new();
    f.configure("github-copilot").await;
    let account = f.configure("openai-chatgpt").await;
    let target = f.publish(&account).await;
    assert_eq!(f.auth.activate_connected_account(&target).await["status"], "updated");

    let fresh = DesktopProviderAuth {
        authority: meerkat_runtime::MeerkatMachine::ephemeral().provider_auth_runtime_authority(),
        copilot_accounts: Default::default(),
        account_mutations: Default::default(),
        ..f.auth.clone()
    };
    let key = meerkat_core::handles::LeaseKey::from_credential_identity(&target.credential_identity);
    assert!(fresh.authority.generated_auth_lease_handle().snapshot(&key).phase.is_none());
    let config = fresh.global_runtime().unwrap().get().await.unwrap().config;
    let status = fresh.host_service().unwrap()
        .status(&config, &oauth_target(&target).unwrap()).await.unwrap();
    assert_eq!(status.phase, meerkat_core::auth::AuthStatusPhase::Valid);
    assert_eq!(status.auth_binding, target.auth_binding);
    assert_eq!(status.profile_id, target.auth_profile.id.as_str());
    assert!(fresh.authority.generated_auth_lease_handle().snapshot(&key).phase.is_some());

    let overview = fresh.status(Some(&json!({}))).await.unwrap();
    let row = overview["connections"].as_array().unwrap().iter()
        .find(|row| row["bindingId"] == account["bindingId"]).unwrap();
    assert_eq!(row["state"], "connected");
    assert_eq!(row["isDefault"], true);
    let models = row["models"].as_array().unwrap();
    assert!(!models.is_empty());
    let catalog = fresh.account_models_catalog(&Map::new()).await.unwrap();
    let listed = catalog["providers"].as_array().unwrap().iter()
        .find(|provider| provider["provider"] == "openai").unwrap()["models"]
        .as_array().unwrap();
    assert!(!listed.is_empty());
    for model in models {
        assert!(listed.iter().any(|entry| entry["id"] == model["id"]));
    }
    let selected = resolve_realm_binding_target_for_provider(&config, Provider::OpenAI,
        None, None, None, Some(&RealmId::global()), true).unwrap();
    assert_eq!(selected.auth_binding.binding, target.auth_binding.binding);
}
