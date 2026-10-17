use std::sync::atomic::{AtomicBool, Ordering};

use meerkat_providers::auth_store::{EphemeralTokenStore, InMemoryCoordinator, TokenStoreError};
use tokio::sync::Notify;

use super::*;

#[derive(Default)]
struct ControlledStore {
    inner: EphemeralTokenStore,
    fail_clear: AtomicBool,
    pause_clear: AtomicBool,
    entered: Notify,
    resume: Notify,
}

#[async_trait::async_trait]
impl TokenStore for ControlledStore {
    async fn load(&self, key: &TokenKey) -> Result<Option<PersistedTokens>, TokenStoreError> {
        self.inner.load(key).await
    }

    async fn save(&self, key: &TokenKey, tokens: &PersistedTokens) -> Result<(), TokenStoreError> {
        self.inner.save(key, tokens).await
    }

    async fn clear(&self, key: &TokenKey) -> Result<(), TokenStoreError> {
        if self.fail_clear.load(Ordering::SeqCst) {
            return Err(TokenStoreError::Unavailable("fixture clear failure".into()));
        }
        if self.pause_clear.swap(false, Ordering::SeqCst) {
            self.entered.notify_one();
            self.resume.notified().await;
        }
        self.inner.clear(key).await
    }

    async fn list(&self) -> Result<Vec<TokenKey>, TokenStoreError> {
        self.inner.list().await
    }

    async fn observe_status(&self, key: &TokenKey) -> Result<meerkat_providers::auth_store::TokenStoreObservation, TokenStoreError> {
        self.inner.observe_status(key).await
    }

    fn backend_name(&self) -> &'static str {
        "isolated-removal-fixture"
    }
}

struct Fixture {
    auth: DesktopProviderAuth,
    store: Arc<ControlledStore>,
}

impl Fixture {
    fn new() -> Self {
        let store = Arc::new(ControlledStore::default());
        Self {
            auth: DesktopProviderAuth {
                auth_scope: Ok(None),
                global_config_path: default_global_config_path(),
                copilot_accounts: Default::default(),
                account_mutations: Default::default(),
                auth_http: auth_http_client(),
                persistence: Ok(ProviderAuthPersistence::new(
                    store.clone(),
                    Arc::new(InMemoryCoordinator::new()),
                )),
                authority: meerkat_runtime::MeerkatMachine::ephemeral()
                    .provider_auth_runtime_authority(),
            },
            store,
        }
    }

    async fn configure(&self, method: &str, name: &str) -> Value {
        let mut input = json!({"methodId":method,"fields":{"name":name}});
        if method.ends_with("api-key") {
            input["secret"] = json!("isolated-fixture-credential");
        }
        self.auth.configure(Some(&input)).await.unwrap()["connection"].clone()
    }

    async fn config(&self) -> Config {
        self.auth.global_runtime().unwrap().get().await.unwrap().config
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.auth.global_config_path.parent().unwrap());
    }
}

fn target(connection: &Value) -> Value {
    json!({"provider":connection["provider"],"realmId":connection["realmId"],"bindingId":connection["bindingId"],"profileId":connection["profileId"]})
}

#[test]
fn browser_callbacks_match_native_cli_listener_policy() {
    let catalog = methods();
    for (id, expected) in [
        (
            "openai-chatgpt",
            json!({"redirectHost":"localhost","path":"/auth/callback","ports":[1455,1457]}),
        ),
        (
            "anthropic-claude",
            json!({"redirectHost":"localhost","path":"/callback","ports":[0]}),
        ),
        (
            "google-account",
            json!({"redirectHost":"127.0.0.1","path":"/callback","ports":[0]}),
        ),
    ] {
        assert_eq!(
            catalog.iter().find(|method| method["id"] == id).unwrap()["callback"],
            expected
        );
    }
    assert!(
        catalog
            .iter()
            .filter(|method| method["flow"] != "browser")
            .all(|method| method.get("callback").is_none())
    );
}

#[tokio::test]
async fn removing_copilot_deletes_all_routes_defaults_and_only_its_profiles_after_reload() {
    let fixture = Fixture::new();
    let account = fixture.configure("github-copilot", "King").await;
    let other = fixture.configure("github-copilot", "Other").await;
    let direct = fixture.configure("openai-api-key", "Direct").await;
    assert_eq!(account["supportsRemoval"], true);
    let runtime = fixture.auth.global_runtime().unwrap();
    runtime
        .patch(
            ConfigDelta(json!({
                "realm":{"global":{"default_binding":account["bindingId"]}},
                "max_tokens":4567
            })),
            None,
        )
        .await
        .unwrap();
    let before = fixture.config().await;
    let resolved = resolve_target(&before, target(&account).as_object().unwrap()).unwrap();
    let removed = account_removal(&before, &resolved).unwrap();
    assert_eq!(removed.bindings.len(), 3);
    let mut expected = before.clone();
    let section = expected.realm.get_mut("global").unwrap();
    for binding in &removed.bindings {
        let route = section.binding.remove(binding.binding.as_str()).unwrap();
        section.auth.remove(&route.auth_profile);
        section.backend.remove(&route.backend_profile);
    }
    section.default_binding = None;
    let history = fixture
        .auth
        .global_config_path
        .with_file_name("saved-history.jsonl");
    std::fs::write(&history, "saved session with original binding\n").unwrap();
    let result = fixture
        .auth
        .delete_account(Some(&target(&account)))
        .await
        .unwrap();
    assert_eq!(result["deleted"], true);
    assert_eq!(result["cleared"], true);
    assert_eq!(result["removedBindings"].as_array().unwrap().len(), 3);
    assert_eq!(
        serde_json::to_value(fixture.config().await).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
    assert_eq!(
        std::fs::read_to_string(&history).unwrap(),
        "saved session with original binding\n"
    );
    let fresh = DesktopProviderAuth {
        authority: meerkat_runtime::MeerkatMachine::ephemeral().provider_auth_runtime_authority(),
        copilot_accounts: Default::default(),
        account_mutations: Default::default(),
        ..fixture.auth.clone()
    };
    let overview = fresh.status(Some(&json!({}))).await.unwrap();
    let rows = overview["connections"].as_array().unwrap();
    assert!(
        !rows
            .iter()
            .any(|row| row["credentialAccount"] == account["credentialAccount"])
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row["credentialAccount"] == other["credentialAccount"])
            .count(),
        3
    );
    assert!(
        rows.iter()
            .any(|row| row["bindingId"] == direct["bindingId"] && row["state"] == "connected")
    );
    assert!(
        meerkat_core::resolve_explicit_auth_binding_target(
            &fixture.config().await,
            &resolved.auth_binding
        )
        .is_err(),
        "saved binding must remain unavailable rather than silently selecting another account"
    );
}

#[tokio::test]
async fn deleting_one_key_preserves_shared_profiles_and_other_account_credentials() {
    let fixture = Fixture::new();
    let first = fixture.configure("openai-api-key", "First").await;
    let second = fixture.configure("openai-api-key", "Second").await;
    let before = fixture.config().await;
    let first_target = resolve_target(&before, target(&first).as_object().unwrap()).unwrap();
    let second_target = resolve_target(&before, target(&second).as_object().unwrap()).unwrap();
    let route = &before.realm["global"].binding[first["bindingId"].as_str().unwrap()];
    fixture.auth.global_runtime().unwrap().patch(ConfigDelta(json!({"realm":{"global":{"default_binding":second["bindingId"],"binding":{
        second["bindingId"].as_str().unwrap():{"auth_profile":route.auth_profile,"backend_profile":route.backend_profile}
    }}}})), None).await.unwrap();
    let shared = fixture.config().await;
    fixture
        .auth
        .delete_account(Some(&target(&first)))
        .await
        .unwrap();
    let after = fixture.config().await;
    assert_eq!(after.realm["global"].auth, shared.realm["global"].auth);
    assert_eq!(
        after.realm["global"].backend,
        shared.realm["global"].backend
    );
    assert_eq!(after.realm["global"].binding.len(), 1);
    assert_eq!(
        after.realm["global"].default_binding.as_deref(),
        second["bindingId"].as_str()
    );
    assert!(
        fixture
            .store
            .load(&TokenKey::from_credential_identity(
                &first_target.credential_identity
            ))
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        fixture
            .store
            .load(&TokenKey::from_credential_identity(
                &second_target.credential_identity
            ))
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn disconnected_accounts_remain_removable_but_logout_preserves_config() {
    let fixture = Fixture::new();
    let account = fixture.configure("openai-api-key", "Saved").await;
    let before = std::fs::read(&fixture.auth.global_config_path).unwrap();
    fixture.auth.logout(Some(&target(&account))).await.unwrap();
    assert_eq!(
        std::fs::read(&fixture.auth.global_config_path).unwrap(),
        before
    );
    let overview = fixture.auth.status(Some(&json!({}))).await.unwrap();
    let row = overview["connections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["bindingId"] == account["bindingId"])
        .unwrap();
    assert_eq!(row["state"], "needs_auth");
    assert_eq!(row["supportsRemoval"], true);
    fixture
        .auth
        .delete_account(Some(&target(row)))
        .await
        .unwrap();
    assert!(fixture.config().await.realm.get("global").is_none_or(|realm| realm.binding.is_empty()));
}

#[tokio::test]
async fn removal_rejects_stale_profiles_project_scope_and_external_credentials_without_mutation() {
    let fixture = Fixture::new();
    let account = fixture.configure("openai-api-key", "Saved").await;
    let before = std::fs::read(&fixture.auth.global_config_path).unwrap();
    let mut stale = target(&account);
    stale["profileId"] = json!("another-profile");
    assert!(fixture.auth.delete_account(Some(&stale)).await.is_err());
    let mut scoped = target(&account);
    scoped["projectPath"] = json!("/isolated-fixture-project");
    assert!(fixture.auth.delete_account(Some(&scoped)).await.is_err());
    assert_eq!(
        std::fs::read(&fixture.auth.global_config_path).unwrap(),
        before
    );
    let mut config = fixture.config().await;
    config
        .realm
        .get_mut("global")
        .unwrap()
        .auth
        .get_mut(account["profileId"].as_str().unwrap())
        .unwrap()
        .source = CredentialSourceSpec::Env {
        env: "ISOLATED_ABSENT_KEY".into(),
        fallback: vec![],
    };
    fixture
        .auth
        .global_runtime().unwrap()
        .set(config, None)
        .await
        .unwrap();
    let external = std::fs::read(&fixture.auth.global_config_path).unwrap();
    assert!(
        fixture
            .auth
            .delete_account(Some(&target(&account)))
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read(&fixture.auth.global_config_path).unwrap(),
        external
    );
    let context = fixture.auth.account_config(&Map::new()).await.unwrap();
    let resolved = resolve_target(&context.config, target(&account).as_object().unwrap()).unwrap();
    assert_eq!(
        fixture
            .auth
            .account_status(&context, &resolved)
            .await
            .unwrap()["supportsRemoval"],
        false
    );
}

#[tokio::test]
async fn failed_credential_clear_keeps_config_and_credential() {
    let fixture = Fixture::new();
    let account = fixture.configure("openai-api-key", "Saved").await;
    let before = std::fs::read(&fixture.auth.global_config_path).unwrap();
    let target_value = target(&account);
    let resolved =
        resolve_target(&fixture.config().await, target_value.as_object().unwrap()).unwrap();
    fixture.store.fail_clear.store(true, Ordering::SeqCst);
    assert!(
        fixture
            .auth
            .delete_account(Some(&target_value))
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read(&fixture.auth.global_config_path).unwrap(),
        before
    );
    assert!(
        fixture
            .store
            .load(&TokenKey::from_credential_identity(
                &resolved.credential_identity
            ))
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn concurrent_config_write_reports_partial_removal_and_preserves_the_new_write() {
    let fixture = Fixture::new();
    let account = fixture.configure("openai-api-key", "Saved").await;
    let input = target(&account);
    fixture.store.pause_clear.store(true, Ordering::SeqCst);
    let removal = fixture.auth.delete_account(Some(&input));
    let writer = async {
        fixture.store.entered.notified().await;
        fixture
            .auth
            .global_runtime().unwrap()
            .patch(ConfigDelta(json!({"max_tokens":8765})), None)
            .await
            .unwrap();
        fixture.store.resume.notify_one();
    };
    let (result, ()) = tokio::join!(removal, writer);
    let error = result.expect_err("CAS conflict cannot report successful account removal");
    let GatewayError::Api { details, .. } = error;
    assert_eq!(
        details.unwrap(),
        json!({"credentialsCleared":true,"deletionConfirmed":false,"requiresRefresh":true})
    );
    let config = fixture.config().await;
    assert_eq!(config.max_tokens, Some(8765));
    assert!(
        config.realm["global"]
            .binding
            .contains_key(account["bindingId"].as_str().unwrap())
    );
    let resolved = resolve_target(&config, input.as_object().unwrap()).unwrap();
    assert!(
        fixture
            .store
            .load(&TokenKey::from_credential_identity(
                &resolved.credential_identity
            ))
            .await
            .unwrap()
            .is_none()
    );
    fixture.auth.delete_account(Some(&input)).await.unwrap();
    assert!(fixture.config().await.realm.get("global").is_none_or(|realm| realm.binding.is_empty()));
}

#[tokio::test]
async fn deleting_account_revokes_pending_device_flow_and_rejects_old_targets() {
    let fixture = Fixture::new();
    let account = fixture.configure("github-copilot", "Pending").await;
    let input = target(&account);
    let resolved = resolve_target(&fixture.config().await, input.as_object().unwrap()).unwrap();
    let authority = fixture.auth.authority.oauth_flow_authority();
    authority
        .admit_device_code(
            resolved.credential_identity.clone(),
            OAuthProviderIdentity::GitHubCopilot,
            "isolated-device-code".into(),
            std::time::Duration::from_secs(60),
        )
        .unwrap();
    fixture.auth.delete_account(Some(&input)).await.unwrap();
    assert!(
        authority
            .begin_device_code_poll(
                "isolated-device-code",
                &resolved.credential_identity,
                OAuthProviderIdentity::GitHubCopilot
            )
            .is_err()
    );
    let mut old_poll = input.clone();
    old_poll["deviceCode"] = json!("isolated-device-code");
    assert!(fixture.auth.device_poll(Some(&old_poll)).await.is_err());
    assert!(fixture.auth.device_start(Some(&input)).await.is_err());
    assert!(fixture.store.list().await.unwrap().is_empty());
}

#[tokio::test]
async fn credential_update_waiting_on_removal_cannot_recreate_the_removed_account() {
    let fixture = Fixture::new();
    let account = fixture.configure("openai-api-key", "Saved").await;
    let input = target(&account);
    let mut replacement = input.clone();
    replacement["methodId"] = json!("openai-api-key");
    replacement["secret"] = json!("late-isolated-fixture-credential");
    fixture.store.pause_clear.store(true, Ordering::SeqCst);
    let removal = fixture.auth.delete_account(Some(&input));
    let late_update = async {
        fixture.store.entered.notified().await;
        let update = fixture.auth.configure(Some(&replacement));
        tokio::pin!(update);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), update.as_mut())
                .await
                .is_err(),
            "credential update must wait for removal's config commit"
        );
        fixture.store.resume.notify_one();
        assert!(
            update.await.is_err(),
            "the stale binding must fail after removal"
        );
    };
    let (result, ()) = tokio::join!(removal, late_update);
    assert_eq!(result.unwrap()["deleted"], true);
    assert!(fixture.config().await.realm.get("global").is_none_or(|realm| realm.binding.is_empty()));
    assert!(fixture.store.list().await.unwrap().is_empty());
}

#[tokio::test]
async fn stalled_device_start_times_out_and_releases_account_mutations() {
    use tokio::io::AsyncReadExt;

    let mut fixture = Fixture::new();
    let account = fixture.configure("github-copilot", "Pending").await;
    let input = target(&account);
    // A local HTTP proxy accepts CONNECT and stalls. No TLS tunnel is opened
    // and no request reaches the real provider.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_address = listener.local_addr().unwrap();
    let (entered, waiting) = tokio::sync::oneshot::channel();
    let proxy = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        let count = socket.read(&mut request).await.unwrap();
        assert!(
            std::str::from_utf8(&request[..count])
                .unwrap()
                .starts_with("CONNECT github.com:443 ")
        );
        entered.send(()).unwrap();
        // Keep the fixture stalled until the timed-out client closes it.
        let _ = socket.read(&mut request).await;
    });
    fixture.auth.auth_http = auth_http_client_builder(std::time::Duration::from_millis(100))
        .proxy(reqwest::Proxy::all(format!("http://{proxy_address}")).unwrap())
        .build()
        .map_err(|error| error.to_string());
    let start = fixture.auth.device_start(Some(&input));
    let remove = async {
        waiting.await.unwrap();
        fixture.auth.delete_account(Some(&input)).await
    };
    let (start_result, remove_result) =
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::join!(start, remove)
        })
        .await
        .expect("stalled auth HTTP must release the account mutation lock");
    assert!(start_result.is_err());
    assert_eq!(remove_result.unwrap()["deleted"], true);
    proxy.await.unwrap();
    assert!(fixture.store.list().await.unwrap().is_empty());
    let next = fixture.configure("openai-api-key", "Next").await;
    assert_eq!(next["state"], "connected");
}
