use meerkat_providers::auth_store::{EphemeralTokenStore, InMemoryCoordinator};

use super::*;

fn fixture() -> DesktopProviderAuth {
    DesktopProviderAuth {
        global_config_path: default_global_config_path(),
        copilot_accounts: Default::default(),
        account_mutations: Default::default(),
        auth_http: auth_http_client(),
        persistence: Ok(ProviderAuthPersistence::new(
            Arc::new(EphemeralTokenStore::new()),
            Arc::new(InMemoryCoordinator::new()),
        )),
        authority: meerkat_runtime::MeerkatMachine::ephemeral().provider_auth_runtime_authority(),
    }
}

fn target(connection: &Value) -> Value {
    json!({"provider":connection["provider"], "realmId":connection["realmId"], "bindingId":connection["bindingId"], "profileId":connection["profileId"]})
}

struct ObservationOnlyStore(meerkat_providers::auth_store::TokenStoreObservation);

#[async_trait::async_trait]
impl TokenStore for ObservationOnlyStore {
    async fn load(&self, _: &TokenKey) -> Result<Option<PersistedTokens>, meerkat_providers::auth_store::TokenStoreError> {
        panic!("account status must not start a credential read")
    }

    async fn save(&self, _: &TokenKey, _: &PersistedTokens) -> Result<(), meerkat_providers::auth_store::TokenStoreError> {
        panic!("account status must not change credentials")
    }

    async fn clear(&self, _: &TokenKey) -> Result<(), meerkat_providers::auth_store::TokenStoreError> {
        panic!("account status must not clear credentials")
    }

    async fn list(&self) -> Result<Vec<TokenKey>, meerkat_providers::auth_store::TokenStoreError> {
        panic!("account status must use its configured credential identity")
    }

    async fn observe_status(&self, _: &TokenKey) -> Result<meerkat_providers::auth_store::TokenStoreObservation, meerkat_providers::auth_store::TokenStoreError> {
        Ok(self.0.clone())
    }

    fn backend_name(&self) -> &'static str { "observation-only-fixture" }
}

#[tokio::test]
async fn unanswered_credential_observations_never_become_missing_accounts() {
    use meerkat_providers::auth_store::TokenStoreObservation;

    for method in ["openai-api-key", "openai-chatgpt"] {
        let mut auth = fixture();
        let mut input = json!({"methodId":method});
        if method == "openai-api-key" {
            input["secret"] = json!("isolated-observation-test-key");
        }
        let row = auth.configure(Some(&input)).await.unwrap()["connection"].clone();
        auth.authority = meerkat_runtime::MeerkatMachine::ephemeral().provider_auth_runtime_authority();
        let context = auth.account_config(&Map::new()).await.unwrap();
        let account = resolve_target(&context.config, target(&row).as_object().unwrap()).unwrap();
        for (observation, expected) in [
            (TokenStoreObservation::NotObserved, "not_observed"),
            (TokenStoreObservation::Pending, "pending"),
            (TokenStoreObservation::Unavailable, "unavailable"),
            (TokenStoreObservation::Denied, "denied"),
            (TokenStoreObservation::InteractionRequired, "interaction_required"),
        ] {
            auth.persistence = Ok(ProviderAuthPersistence::new(
                Arc::new(ObservationOnlyStore(observation)),
                Arc::new(InMemoryCoordinator::new()),
            ));
            let status = auth.account_status(&context, &account).await.unwrap();
            assert_eq!(status["state"], "unknown", "{method}: {expected}");
            assert_eq!(status["credentialObservation"], expected);
            assert!(status["models"].as_array().unwrap().is_empty());
        }
        auth.persistence = Ok(ProviderAuthPersistence::new(
            Arc::new(ObservationOnlyStore(TokenStoreObservation::Missing)),
            Arc::new(InMemoryCoordinator::new()),
        ));
        let missing = auth.account_status(&context, &account).await.unwrap();
        assert_eq!(missing["state"], "needs_auth");
        assert!(missing["credentialObservation"].is_null());
        std::fs::remove_dir_all(auth.global_config_path.parent().unwrap()).unwrap();
    }
}

#[tokio::test]
async fn copilot_status_does_not_start_model_discovery_or_read_credentials() {
    let mut auth = fixture();
    let row = auth.configure(Some(&json!({"methodId":"github-copilot"})))
        .await.unwrap()["connection"].clone();
    let context = auth.account_config(&Map::new()).await.unwrap();
    let account = resolve_target(&context.config, target(&row).as_object().unwrap()).unwrap();
    meerkat_providers::browser_login::save_tokens_and_publish_lifecycle(
        auth.persistence().unwrap(), auth.authority.generated_auth_lease_handle(),
        account.credential_identity.clone(), PersistedTokens {
            auth_mode: meerkat_core::auth::PersistedAuthMode::GithubCopilotOauth,
            primary_secret: Some("isolated-passive-copilot-token".into()),
            refresh_token: None, id_token: None, expires_at: None,
            last_refresh: Some(Utc::now()), scopes: vec![], account_id: None, metadata: Value::Null,
        },
    ).await.unwrap();
    auth.persistence = Ok(ProviderAuthPersistence::new(
        Arc::new(ObservationOnlyStore(meerkat_providers::auth_store::TokenStoreObservation::NotObserved)),
        Arc::new(InMemoryCoordinator::new()),
    ));
    let status = auth.account_status(&context, &account).await.unwrap();
    assert_eq!(status["state"], "connected");
    assert_eq!(status["credentialObservation"], "not_observed");
    assert_eq!(status["modelsVerified"], false);
    assert!(status["models"].as_array().unwrap().is_empty());
    std::fs::remove_dir_all(auth.global_config_path.parent().unwrap()).unwrap();
}

struct InteractiveOnlyStore {
    inner: Arc<dyn TokenStore>,
    calls: std::sync::atomic::AtomicUsize,
    pending: bool,
}

#[async_trait::async_trait]
impl TokenStore for InteractiveOnlyStore {
    async fn load(&self, _: &TokenKey) -> Result<Option<PersistedTokens>, meerkat_providers::auth_store::TokenStoreError> {
        panic!("checking an account must explicitly request interactive access")
    }

    async fn load_for(&self, key: &TokenKey, access: meerkat_providers::auth_store::TokenStoreAccess) -> Result<Option<PersistedTokens>, meerkat_providers::auth_store::TokenStoreError> {
        assert_eq!(access, meerkat_providers::auth_store::TokenStoreAccess::Interactive);
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if self.pending {
            return std::future::pending().await;
        }
        self.inner.load(key).await
    }

    async fn save(&self, _: &TokenKey, _: &PersistedTokens) -> Result<(), meerkat_providers::auth_store::TokenStoreError> {
        panic!("checking an account must not replace credentials")
    }

    async fn clear(&self, _: &TokenKey) -> Result<(), meerkat_providers::auth_store::TokenStoreError> {
        panic!("checking an account must not clear credentials")
    }

    async fn list(&self) -> Result<Vec<TokenKey>, meerkat_providers::auth_store::TokenStoreError> {
        panic!("checking an account must use its configured identity")
    }

    async fn observe_status(&self, _: &TokenKey) -> Result<meerkat_providers::auth_store::TokenStoreObservation, meerkat_providers::auth_store::TokenStoreError> {
        // Mirrors Keychain: passive observation never returns secret material.
        Ok(meerkat_providers::auth_store::TokenStoreObservation::NotObserved)
    }

    fn backend_name(&self) -> &'static str { "interactive-only-fixture" }
}

#[tokio::test]
async fn explicit_check_restores_saved_accounts_without_another_login() {
    for method in ["openai-api-key", "openai-chatgpt"] {
        let mut auth = fixture();
        let mut input = json!({"methodId":method});
        if method == "openai-api-key" {
            input["secret"] = json!("isolated-check-test-key");
        }
        let row = auth.configure(Some(&input)).await.unwrap()["connection"].clone();
        let context = auth.account_config(&Map::new()).await.unwrap();
        let account = resolve_target(&context.config, target(&row).as_object().unwrap()).unwrap();
        if method == "openai-chatgpt" {
            meerkat_providers::browser_login::save_tokens_and_publish_lifecycle(
                auth.persistence().unwrap(), auth.authority.generated_auth_lease_handle(),
                account.credential_identity.clone(), PersistedTokens {
                    auth_mode: meerkat_core::auth::PersistedAuthMode::ChatgptOauth,
                    primary_secret: Some("isolated-check-test-token".into()),
                    refresh_token: Some("isolated-check-test-refresh".into()),
                    id_token: None, expires_at: Some(Utc::now() + chrono::Duration::hours(1)),
                    last_refresh: Some(Utc::now()), scopes: vec![], account_id: None, metadata: Value::Null,
                },
            ).await.unwrap();
        }
        let store = Arc::new(InteractiveOnlyStore {
            inner: auth.persistence().unwrap().token_store(),
            calls: std::sync::atomic::AtomicUsize::new(0), pending: false,
        });
        auth.persistence = Ok(ProviderAuthPersistence::new(store.clone(), Arc::new(InMemoryCoordinator::new())));
        auth.authority = meerkat_runtime::MeerkatMachine::ephemeral().provider_auth_runtime_authority();
        assert_eq!(auth.account_status(&context, &account).await.unwrap()["state"], "unknown");
        assert_eq!(store.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        let checked = auth.check(Some(&target(&row))).await.unwrap();
        assert_eq!(checked["checked"], true);
        assert_eq!(checked["connection"]["state"], "connected");
        let later = auth.account_status(&context, &account).await.unwrap();
        assert_eq!(later["state"], "connected");
        assert!(!later["models"].as_array().unwrap().is_empty());
        assert_eq!(store.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(!checked.to_string().contains("isolated-check-test"));
        std::fs::remove_dir_all(auth.global_config_path.parent().unwrap()).unwrap();
    }
}

#[tokio::test]
async fn explicit_check_stays_bounded_when_credential_access_does_not_complete() {
    let mut auth = fixture();
    let row = auth.configure(Some(&json!({"methodId":"openai-chatgpt"}))).await.unwrap()["connection"].clone();
    let store = Arc::new(InteractiveOnlyStore {
        inner: auth.persistence().unwrap().token_store(),
        calls: std::sync::atomic::AtomicUsize::new(0), pending: true,
    });
    auth.persistence = Ok(ProviderAuthPersistence::new(store.clone(), Arc::new(InMemoryCoordinator::new())));
    let result = auth.check_with_timeout(Some(&target(&row)), std::time::Duration::ZERO).await;
    assert!(result.is_err());
    assert_eq!(store.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    let overview = auth.status(Some(&json!({}))).await.unwrap();
    let account = overview["connections"].as_array().unwrap().iter()
        .find(|account| account["bindingId"] == row["bindingId"]).unwrap();
    assert_eq!(account["state"], "unknown");
    std::fs::remove_dir_all(auth.global_config_path.parent().unwrap()).unwrap();
}

#[tokio::test]
async fn accounts_work_before_a_project_exists_without_writing_status() {
    let auth = fixture();
    let overview = auth
        .status(Some(&json!({})))
        .await
        .expect("global overview");
    assert_eq!(overview["realmId"], "global");
    assert_eq!(overview["methods"].as_array().unwrap().len(), 10);
    assert!(!auth.global_config_path.exists());
    let env_accounts: Vec<_> = overview["connections"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["realmId"] == "env_default")
        .collect();
    assert!(env_accounts.iter().all(|row| row["state"] == "connected"));
}

#[tokio::test]
async fn saving_a_key_uses_native_store_and_keeps_secondary_accounts_addressable() {
    let auth = fixture();
    let first = auth
        .configure(Some(
            &json!({"methodId":"openai-api-key", "secret":"fixture-secret-one"}),
        ))
        .await
        .expect("first account")["connection"]
        .clone();
    let second = auth
        .configure(Some(
            &json!({"methodId":"openai-api-key", "secret":"fixture-secret-two"}),
        ))
        .await
        .expect("second account")["connection"]
        .clone();
    assert_ne!(first["bindingId"], second["bindingId"]);
    assert_eq!(first["accountLabel"], "OpenAI API key");
    assert_eq!(second["accountLabel"], "OpenAI API key 2");
    assert_eq!(first["state"], "connected");
    assert_eq!(first["isDefault"], true);
    assert_eq!(second["isDefault"], false);
    let raw = std::fs::read_to_string(&auth.global_config_path).unwrap();
    assert!(!raw.contains("fixture-secret"));
    let overview = auth.status(Some(&json!({}))).await.unwrap();
    let saved: Vec<_> = overview["connections"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["realmId"] == "global")
        .collect();
    assert_eq!(saved.len(), 2);
    assert!(saved.iter().all(|row| row["models"]
        .as_array()
        .is_some_and(|models| !models.is_empty())));
    assert!(saved.iter().all(|row| row["modelsVerified"] == false));

    auth.set_default(Some(&target(&second)))
        .await
        .expect("choose second account");
    let overview = auth.status(Some(&json!({}))).await.unwrap();
    let selected = overview["connections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["bindingId"] == second["bindingId"])
        .unwrap();
    assert_eq!(selected["isDefault"], true);
    auth.logout(Some(&target(&second)))
        .await
        .expect("clear exact second credentials");
    let overview = auth.status(Some(&json!({}))).await.unwrap();
    let rows = overview["connections"].as_array().unwrap();
    assert_eq!(
        rows.iter()
            .find(|row| row["bindingId"] == first["bindingId"])
            .unwrap()["state"],
        "connected"
    );
    assert_eq!(
        rows.iter()
            .find(|row| row["bindingId"] == second["bindingId"])
            .unwrap()["state"],
        "needs_auth"
    );

    let mut update = target(&second);
    update["methodId"] = json!("openai-api-key");
    update["secret"] = json!("fixture-secret-updated");
    let updated = auth
        .configure(Some(&update))
        .await
        .expect("update same binding");
    assert_eq!(updated["connection"]["bindingId"], second["bindingId"]);
    assert_eq!(updated["connection"]["state"], "connected");
    std::fs::remove_dir_all(auth.global_config_path.parent().unwrap()).unwrap();
}

#[tokio::test]
async fn browser_profiles_are_provisioned_before_native_sign_in_without_network() {
    let auth = fixture();
    for method in ["openai-chatgpt", "anthropic-claude", "google-account"] {
        let connection = auth
            .configure(Some(&json!({"methodId":method})))
            .await
            .expect("configure browser account")["connection"]
            .clone();
        assert_eq!(connection["state"], "needs_auth");
        assert_eq!(connection["loginFlow"], "browser");
        let mut input = target(&connection);
        input["redirectUri"] = json!("http://localhost:1455/auth/callback");
        let start = auth
            .login_start(Some(&input))
            .await
            .expect("native PKCE start");
        assert_eq!(start["bindingId"], connection["bindingId"]);
        assert!(start["authorizeUrl"]
            .as_str()
            .unwrap()
            .starts_with("https://"));
        assert!(!start["state"].as_str().unwrap().is_empty());
    }
    std::fs::remove_dir_all(auth.global_config_path.parent().unwrap()).unwrap();
}

#[tokio::test]
async fn retained_session_auth_follows_its_saved_binding_after_default_changes() {
    let auth = fixture();
    let mut accounts = Vec::new();
    for name in ["Retained account", "New default"] {
        accounts.push(auth.configure(Some(&json!({
            "methodId":"azure-openai-api-key", "secret":"fixture-only-key",
            "fields":{"name":name,"endpoint":"https://fixture.example.invalid","model":name.replace(' ', "-")}
        }))).await.unwrap()["connection"].clone());
    }
    auth.set_default(Some(&target(&accounts[1]))).await.unwrap();
    let context = auth.account_config(&Map::new()).await.unwrap();
    let saved = resolve_target(&context.config, target(&accounts[0]).as_object().unwrap()).unwrap();
    let mut identity = meerkat_core::SessionLlmIdentity {
        model: "Retained-account".into(),
        provider: Provider::OpenAI,
        self_hosted_server_id: None,
        provider_params: None,
        auth_binding: Some(saved.auth_binding),
    };
    let pinned = auth
        .model_auth_status(&context.config, &context.realm, &identity)
        .await;
    assert_eq!(pinned["state"], "connected");
    assert_eq!(pinned["source"], "pinned");
    assert_eq!(pinned["bindingId"], accounts[0]["bindingId"]);
    assert_eq!(pinned["accountLabel"], "Retained account");
    let catalog = auth.account_models_catalog(&Map::new()).await.unwrap();
    let selected_models = catalog["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|provider| provider["provider"] == "openai")
        .unwrap()["models"]
        .as_array()
        .unwrap();
    assert!(!selected_models
        .iter()
        .any(|model| model["id"] == identity.model));

    auth.logout(Some(&target(&accounts[1]))).await.unwrap();
    assert_eq!(
        auth.model_auth_status(&context.config, &context.realm, &identity)
            .await["state"],
        "connected"
    );
    let saved_binding = identity.auth_binding.take();
    let default_auth = auth
        .model_auth_status(&context.config, &context.realm, &identity)
        .await;
    assert_eq!(default_auth["source"], "default");
    assert_eq!(default_auth["state"], "needs_auth");
    assert_eq!(default_auth["bindingId"], accounts[1]["bindingId"]);
    identity.auth_binding = saved_binding;

    auth.logout(Some(&target(&accounts[0]))).await.unwrap();
    assert_eq!(
        auth.model_auth_status(&context.config, &context.realm, &identity)
            .await["state"],
        "needs_auth"
    );
    identity.auth_binding.as_mut().unwrap().binding = BindingId::parse("removed-binding").unwrap();
    let unknown = auth
        .model_auth_status(&context.config, &context.realm, &identity)
        .await;
    assert_eq!(unknown["state"], "unknown");
    assert_eq!(unknown["source"], "pinned");
    assert!(unknown.get("bindingId").is_none());
    std::fs::remove_dir_all(auth.global_config_path.parent().unwrap()).unwrap();
}

#[tokio::test]
async fn copilot_configures_three_routes_to_one_native_credential_account() {
    let auth = fixture();
    let result = auth
        .configure(Some(&json!({"methodId":"github-copilot"})))
        .await
        .expect("configure Copilot");
    assert_eq!(result["connection"]["loginFlow"], "device");
    let context = auth.account_config(&Map::new()).await.unwrap();
    let section = &context.config.realm["global"];
    assert_eq!(section.binding.len(), 3);
    let accounts: BTreeSet<_> = section
        .binding
        .values()
        .map(|binding| binding.credential_account.clone().unwrap())
        .collect();
    assert_eq!(accounts.len(), 1);
    let overview = auth.status(Some(&json!({}))).await.unwrap();
    assert_eq!(
        overview["connections"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["realmId"] == "global")
            .count(),
        3
    );
    std::fs::remove_dir_all(auth.global_config_path.parent().unwrap()).unwrap();
}

#[tokio::test]
async fn oauth_expiry_keeps_native_refresh_admission_distinct_from_reauthorization() {
    let auth = fixture();
    let account = auth
        .configure(Some(&json!({"methodId":"openai-chatgpt"})))
        .await
        .unwrap()["connection"]
        .clone();
    let mut context = auth.account_config(&Map::new()).await.unwrap();
    let resolved = resolve_target(&context.config, target(&account).as_object().unwrap()).unwrap();
    meerkat_providers::browser_login::save_tokens_and_publish_lifecycle(
        auth.persistence().unwrap(),
        auth.authority.generated_auth_lease_handle(),
        resolved.credential_identity.clone(),
        PersistedTokens {
            auth_mode: meerkat_providers::auth_store::PersistedAuthMode::ChatgptOauth,
            primary_secret: Some("fixture-expired-token".into()),
            refresh_token: Some("fixture-refresh-token".into()),
            id_token: None,
            expires_at: Some(Utc::now() - chrono::Duration::minutes(5)),
            last_refresh: None,
            scopes: vec![],
            account_id: None,
            metadata: Value::Null,
        },
    )
    .await
    .unwrap();
    let identity = meerkat_core::SessionLlmIdentity {
        model: "gpt-5.6-sol".into(),
        provider: Provider::OpenAI,
        self_hosted_server_id: None,
        provider_params: None,
        auth_binding: Some(resolved.auth_binding),
    };
    assert_eq!(
        auth.model_auth_status(&context.config, &context.realm, &identity)
            .await["state"],
        "connected"
    );
    context
        .config
        .realm
        .get_mut("global")
        .unwrap()
        .auth
        .get_mut(account["profileId"].as_str().unwrap())
        .unwrap()
        .constraints
        .allow_refresh = false;
    assert_eq!(
        auth.model_auth_status(&context.config, &context.realm, &identity)
            .await["state"],
        "reauth_required"
    );
    auth.logout(Some(&target(&account))).await.unwrap();
    assert_eq!(
        auth.model_auth_status(&context.config, &context.realm, &identity)
            .await["state"],
        "needs_auth"
    );
    std::fs::remove_dir_all(auth.global_config_path.parent().unwrap()).unwrap();
}

#[tokio::test]
async fn invalid_forms_and_mismatched_targets_cannot_write_credentials() {
    let auth = fixture();
    for input in [
        json!({"methodId":"openai-api-key"}),
        json!({"methodId":"openai-api-key", "secret":"fixture", "projectPath":"/project"}),
        json!({"methodId":"azure-openai-api-key", "secret":"fixture", "fields":{"endpoint":"http://unsafe.example"}}),
        json!({"methodId":"openai-chatgpt", "secret":"fixture"}),
        json!({"methodId":"openai-api-key", "secret":"fixture", "fields":{"environment":"ignored"}}),
    ] {
        assert!(auth.configure(Some(&input)).await.is_err());
    }
    assert!(!auth.global_config_path.exists());
    let connection = auth
        .configure(Some(
            &json!({"methodId":"openai-api-key", "secret":"fixture"}),
        ))
        .await
        .unwrap()["connection"]
        .clone();
    let mut wrong = target(&connection);
    wrong["provider"] = json!("anthropic");
    assert!(auth.logout(Some(&wrong)).await.is_err());
    assert_eq!(
        auth.status(Some(&json!({}))).await.unwrap()["connections"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["bindingId"] == connection["bindingId"])
            .unwrap()["state"],
        "connected"
    );
    std::fs::remove_dir_all(auth.global_config_path.parent().unwrap()).unwrap();
}

#[tokio::test]
async fn named_azure_account_preserves_and_updates_its_native_endpoint() {
    let auth = fixture();
    let configured = auth
        .configure(Some(&json!({
            "methodId":"azure-openai-api-key", "secret":"fixture-first",
            "fields":{"name":"Work Azure", "endpoint":"https://work.example", "model":"work-gpt-deployment"}
        })))
        .await
        .unwrap()["connection"]
        .clone();
    assert_eq!(configured["accountLabel"], "Work Azure");
    assert_eq!(configured["profileId"], "Work-Azure");
    assert_eq!(configured["models"][0]["id"], "work-gpt-deployment");
    let context = auth.account_config(&Map::new()).await.unwrap();
    let resolved = meerkat::resolve_create_session_model(
        &context.config,
        meerkat::CreateSessionModelResolutionRequest {
            model: None,
            provider: None,
            auth_binding: Some(identity_params(target(&configured).as_object().unwrap()).unwrap()),
        },
    )
    .expect("native binding selects the explicit Azure deployment");
    assert_eq!(resolved.model, "work-gpt-deployment");
    let catalog = auth.global_models_catalog().await.unwrap();
    assert!(catalog["catalog"]["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|provider| provider["provider"] == "openai")
        .unwrap()["models"]
        .as_array()
        .unwrap()
        .iter()
        .any(|model| model["id"] == "work-gpt-deployment"));
    let mut replacement = target(&configured);
    replacement["methodId"] = json!("azure-openai-api-key");
    replacement["secret"] = json!("fixture-second");
    let preserved = auth.configure(Some(&replacement)).await.unwrap()["connection"].clone();
    assert_eq!(preserved["fields"]["endpoint"], "https://work.example");
    assert_eq!(preserved["profileId"], configured["profileId"]);
    replacement["fields"] = json!({"endpoint":"https://other.example"});
    let updated = auth.configure(Some(&replacement)).await.unwrap()["connection"].clone();
    assert_eq!(updated["fields"]["endpoint"], "https://other.example");
    assert_eq!(updated["accountLabel"], "Work Azure");
    std::fs::remove_dir_all(auth.global_config_path.parent().unwrap()).unwrap();
}

#[test]
fn inherited_binding_cannot_be_mutated_through_a_child_identity() {
    let mut config = Config::default();
    config.realm.insert(
        "global".into(),
        meerkat_core::RealmConfigSection::from_inline_api_keys(&[("openai", "fixture")]),
    );
    config.realm.insert("child".into(), Default::default());
    let request = json!({"realmId":"child", "bindingId":"default_openai", "provider":"openai"});
    assert!(resolve_target(&config, request.as_object().unwrap()).is_err());
    let direct = json!({"realmId":"global", "bindingId":"default_openai", "provider":"openai"});
    assert!(resolve_target(&config, direct.as_object().unwrap()).is_ok());
}

#[test]
fn copilot_discovery_projects_only_native_allowed_routes_and_preserves_recommendations() {
    use meerkat_copilot::{
        CopilotEndpoint, CopilotModel, CopilotModelPolicy, CopilotModelPolicyState,
        CopilotModelSnapshot,
    };
    let model = |id: &str, allowed: bool, endpoint: CopilotEndpoint| CopilotModel {
        id: id.into(),
        name: Some(format!("Display {id}")),
        vendor: None,
        version: None,
        model_picker_enabled: Some(true),
        capabilities: Default::default(),
        policy: Some(CopilotModelPolicy {
            state: if allowed {
                CopilotModelPolicyState::Enabled
            } else {
                CopilotModelPolicyState::Disabled
            },
        }),
        supported_endpoints: vec![endpoint],
    };
    let mut non_streaming = model("non-streaming", true, CopilotEndpoint::Responses);
    non_streaming.capabilities.supports.streaming = Some(false);
    let snapshot = CopilotModelSnapshot::from_models(vec![
        model("native-recommended", true, CopilotEndpoint::Responses),
        model("account-only", true, CopilotEndpoint::Responses),
        model("disabled", false, CopilotEndpoint::Responses),
        model("claude-only", true, CopilotEndpoint::Messages),
        non_streaming,
    ])
    .unwrap();
    let mut catalog = json!({"providers":[{"provider":"openai", "default_model_id":"native-recommended", "models":[{"id":"native-recommended", "display_name":"Recommended", "tier":"recommended"}]}]});
    let projected = copilot_models(&snapshot, Provider::OpenAI, &catalog, &[Provider::OpenAI]);
    assert_eq!(projected.len(), 2);
    assert!(!projected.iter().any(|model| model["id"] == "non-streaming"));
    assert_eq!(
        projected
            .iter()
            .find(|model| model["id"] == "native-recommended")
            .unwrap()["recommended"],
        true
    );
    assert_eq!(
        projected
            .iter()
            .find(|model| model["id"] == "account-only")
            .unwrap()["recommended"],
        false
    );
    append_copilot_catalog(
        &mut catalog,
        &snapshot,
        Provider::OpenAI,
        &[Provider::OpenAI],
    );
    let entries = catalog["providers"][0]["models"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().any(|entry| entry["id"] == "account-only"));
    assert!(entries
        .iter()
        .any(|entry| entry["id"] == "native-recommended" && entry["tier"] == "recommended"));
}

#[test]
fn copilot_offerings_have_one_supported_route_instead_of_one_row_per_wire_adapter() {
    use meerkat_copilot::{CopilotEndpoint, CopilotModel, CopilotModelSnapshot};
    let model = |id: &str, vendor: Option<&str>, endpoints: Vec<CopilotEndpoint>| CopilotModel {
        id: id.into(),
        name: Some(id.into()),
        vendor: vendor.map(str::to_string),
        version: None,
        model_picker_enabled: Some(true),
        capabilities: Default::default(),
        policy: None,
        supported_endpoints: endpoints,
    };
    let snapshot = CopilotModelSnapshot::from_models(vec![
        model(
            "claude-account-only",
            Some("Anthropic"),
            vec![CopilotEndpoint::Messages, CopilotEndpoint::ChatCompletions],
        ),
        model(
            "google-account-only",
            Some("Google"),
            vec![CopilotEndpoint::ChatCompletions],
        ),
        model(
            "openai-account-only",
            Some("OpenAI"),
            vec![CopilotEndpoint::Responses, CopilotEndpoint::ChatCompletions],
        ),
        model(
            "known-google-id",
            None,
            vec![CopilotEndpoint::ChatCompletions],
        ),
        model(
            "unknown-vendor-model",
            Some("Another vendor"),
            vec![CopilotEndpoint::ChatCompletions],
        ),
        model(
            "vendor-without-own-protocol",
            Some("Anthropic"),
            vec![CopilotEndpoint::ChatCompletions],
        ),
    ])
    .unwrap();
    let mut catalog = json!({"providers":[
        {"provider":"openai", "models":[]},
        {"provider":"anthropic", "models":[]},
        {"provider":"gemini", "models":[{"id":"known-google-id", "tier":"recommended"}]}
    ]});
    let expected = [
        ("claude-account-only", Provider::Anthropic),
        ("google-account-only", Provider::Gemini),
        ("openai-account-only", Provider::OpenAI),
        ("known-google-id", Provider::Gemini),
        ("unknown-vendor-model", Provider::OpenAI),
        ("vendor-without-own-protocol", Provider::OpenAI),
    ];
    for provider in [Provider::OpenAI, Provider::Anthropic, Provider::Gemini] {
        let projected = copilot_models(
            &snapshot,
            provider,
            &catalog,
            &[Provider::OpenAI, Provider::Anthropic, Provider::Gemini],
        );
        for model in &projected {
            assert!(expected
                .iter()
                .any(|(id, route)| model["id"] == *id && *route == provider));
        }
        append_copilot_catalog(
            &mut catalog,
            &snapshot,
            provider,
            &[Provider::OpenAI, Provider::Anthropic, Provider::Gemini],
        );
    }
    for (id, provider) in expected {
        let rows = catalog["providers"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|entry| {
                entry["models"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(move |model| (entry, model))
            })
            .filter(|(_, model)| model["id"] == id)
            .collect::<Vec<_>>();
        assert_eq!(
            rows.len(),
            1,
            "one Copilot offering must remain one selectable model: {id}"
        );
        assert_eq!(rows[0].0["provider"], provider.as_str());
        assert!(snapshot.model(id).unwrap().route_for(provider).is_some());
        let input = json!({"model":id, "provider":provider.as_str(), "providerParams":null});
        let selected = crate::member_turn_options_with_catalog(
            input.as_object().unwrap(),
            &Config::default(),
            None,
            None,
            &crate::catalog_models(&catalog).unwrap(),
        )
        .expect("a native-discovered model shown by the picker must be selectable");
        assert_eq!(selected.model.unwrap().as_str(), id);
        assert_eq!(selected.provider, Some(provider));
    }
    let invalid = json!({"model":"undiscovered-model", "provider":"openai", "providerParams":null});
    assert!(
        crate::member_turn_options_with_catalog(
            invalid.as_object().unwrap(),
            &Config::default(),
            None,
            None,
            &crate::catalog_models(&catalog).unwrap(),
        )
        .is_err(),
        "native account discovery must not admit arbitrary model IDs"
    );
}

fn copilot_limit_snapshot(limits: Value) -> meerkat_copilot::CopilotModelSnapshot {
    meerkat_copilot::CopilotModelSnapshot::from_models(vec![
        serde_json::from_value(json!({
            "id":"claude-fable-5", "vendor":"Anthropic",
            "model_picker_enabled":true, "supported_endpoints":["/v1/messages"],
            "capabilities":{"limits":limits}
        }))
        .unwrap(),
    ])
    .unwrap()
}

#[test]
fn copilot_account_limits_tighten_known_models_without_replacing_static_metadata() {
    let mut catalog = crate::effective_models_catalog(&Config::default()).unwrap();
    let before = catalog.clone();
    let snapshot = copilot_limit_snapshot(json!({
        "max_context_window_tokens":200_000,
        "max_prompt_tokens":180_000,
        "max_output_tokens":64_000
    }));
    append_copilot_catalog(
        &mut catalog,
        &snapshot,
        Provider::Anthropic,
        &[Provider::Anthropic],
    );
    let mut expected = before;
    let model = expected["providers"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["provider"] == "anthropic")
        .unwrap()["models"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|model| model["id"] == "claude-fable-5")
        .unwrap();
    assert_eq!(model["max_output_tokens"], 128_000);
    model["context_window"] = json!(200_000);
    model["max_input_tokens"] = json!(180_000);
    model["max_output_tokens"] = json!(64_000);
    assert_eq!(catalog, expected, "only the selected model's limits change");
}

#[test]
fn copilot_missing_or_larger_account_limits_preserve_static_limits() {
    let baseline = crate::effective_models_catalog(&Config::default()).unwrap();
    for limits in [
        json!({}),
        json!({"max_context_window_tokens":2_000_000, "max_output_tokens":256_000}),
    ] {
        let mut catalog = baseline.clone();
        append_copilot_catalog(
            &mut catalog,
            &copilot_limit_snapshot(limits),
            Provider::Anthropic,
            &[Provider::Anthropic],
        );
        assert_eq!(catalog, baseline);
    }
    // Each refresh starts from native static evidence, not the last account's
    // overlay, so an absent limit cannot leave a stale account restriction.
    let mut refreshed = baseline.clone();
    append_copilot_catalog(
        &mut refreshed,
        &copilot_limit_snapshot(json!({"max_output_tokens":32_000})),
        Provider::Anthropic,
        &[Provider::Anthropic],
    );
    assert_ne!(refreshed, baseline);
    refreshed = crate::effective_models_catalog(&Config::default()).unwrap();
    append_copilot_catalog(
        &mut refreshed,
        &copilot_limit_snapshot(json!({})),
        Provider::Anthropic,
        &[Provider::Anthropic],
    );
    assert_eq!(refreshed, baseline);
}

#[tokio::test]
async fn copilot_offline_and_nondefault_accounts_do_not_change_catalog_limits() {
    let auth = fixture();
    let first = auth
        .configure(Some(&json!({"methodId":"github-copilot", "fields":{"name":"First"}})))
        .await
        .unwrap()["connection"]
        .clone();
    let second = auth
        .configure(Some(&json!({"methodId":"github-copilot", "fields":{"name":"Second"}})))
        .await
        .unwrap()["connection"]
        .clone();
    let context = auth.account_config(&Map::new()).await.unwrap();
    let baseline = crate::effective_models_catalog(&context.config).unwrap();
    assert_eq!(first["state"], "needs_auth");
    assert_eq!(second["isDefault"], false);
    assert_eq!(auth.account_models_catalog(&Map::new()).await.unwrap(), baseline);

    let second_target =
        resolve_target(&context.config, target(&second).as_object().unwrap()).unwrap();
    let inactive_routes = copilot_default_providers(&context, &second_target.credential_identity);
    assert!(inactive_routes.is_empty());
    let snapshot = copilot_limit_snapshot(json!({"max_output_tokens":1}));
    let mut catalog = baseline.clone();
    for provider in [Provider::OpenAI, Provider::Anthropic, Provider::Gemini] {
        append_copilot_catalog(&mut catalog, &snapshot, provider, &inactive_routes);
    }
    assert_eq!(catalog, baseline, "another account cannot constrain the active route");
    std::fs::remove_dir_all(auth.global_config_path.parent().unwrap()).unwrap();
}

#[tokio::test]
async fn copilot_routes_use_active_defaults_and_model_selection_retains_shared_account_identity() {
    use meerkat_copilot::{CopilotEndpoint, CopilotModel, CopilotModelSnapshot};
    let auth = fixture();
    auth.configure(Some(
        &json!({"methodId":"anthropic-api-key", "secret":"fixture-direct-key"}),
    ))
    .await
    .unwrap();
    let account = auth
        .configure(Some(
            &json!({"methodId":"github-copilot", "fields":{"name":"Work"}}),
        ))
        .await
        .unwrap()["connection"]
        .clone();
    let context = auth.account_config(&Map::new()).await.unwrap();
    let target = resolve_target(&context.config, target(&account).as_object().unwrap()).unwrap();
    assert!(matches!(
        target.credential_identity,
        AuthCredentialIdentity::Account { .. }
    ));
    assert_eq!(account["credentialAccount"]["realm"], "global");
    assert!(account["credentialAccount"]["account"]
        .as_str()
        .unwrap()
        .starts_with("github_copilot_"));
    let defaults = copilot_default_providers(&context, &target.credential_identity);
    assert_eq!(defaults, vec![Provider::OpenAI, Provider::Gemini]);
    let snapshot = CopilotModelSnapshot::from_models(vec![CopilotModel {
        id: "claude-account-only".into(),
        name: Some("Account Claude".into()),
        vendor: Some("Anthropic".into()),
        version: None,
        model_picker_enabled: Some(true),
        capabilities: Default::default(),
        policy: None,
        supported_endpoints: vec![CopilotEndpoint::Messages, CopilotEndpoint::ChatCompletions],
    }])
    .unwrap();
    let mut catalog = crate::effective_models_catalog(&context.config).unwrap();
    assert_eq!(
        copilot_model_provider(
            "claude-account-only",
            snapshot.model("claude-account-only").unwrap(),
            &catalog,
            &defaults
        ),
        Some(Provider::OpenAI)
    );
    append_copilot_catalog(&mut catalog, &snapshot, Provider::OpenAI, &defaults);
    let projected = copilot_models(&snapshot, Provider::OpenAI, &catalog, &defaults);
    assert_eq!(projected.len(), 1);
    let input = json!({"model":"claude-account-only", "provider":"openai", "providerParams":null});
    let options = crate::member_turn_options_with_catalog(
        input.as_object().unwrap(),
        &context.config,
        None,
        Some(&context.realm),
        &crate::catalog_models(&catalog).unwrap(),
    )
    .unwrap();
    let Some(meerkat_core::lifecycle::run_primitive::TurnMetadataOverride::Set(binding)) =
        options.auth_binding
    else {
        panic!("explicit model selection must carry the native account binding");
    };
    let selected =
        meerkat_core::resolve_explicit_auth_binding_target(&context.config, &binding).unwrap();
    assert_eq!(selected.credential_identity, target.credential_identity);
    assert_eq!(selected.auth_binding, target.auth_binding);
    std::fs::remove_dir_all(auth.global_config_path.parent().unwrap()).unwrap();
}

#[test]
fn provider_error_details_do_not_return_secrets_or_endpoint_credentials() {
    let error = native_error(
        "bad token fixture-secret at https://user:pass@example.test?key=fixture-secret",
    );
    let output = format!("{error:?}");
    assert!(!output.contains("fixture-secret"));
    assert!(!output.contains("user:pass"));
}

#[tokio::test]
async fn compiled_cloud_secret_methods_create_native_bindings_without_iam_features() {
    let auth = fixture();
    for (method, backend, auth_method) in [
        ("bedrock-bearer", "bedrock", "bedrock_bearer"),
        ("foundry-api-key", "foundry", "foundry_api_key"),
    ] {
        let configured = auth
            .configure(Some(&json!({
                "methodId":method, "secret":"fixture-cloud-secret",
                "fields":{"endpoint":"https://cloud.example", "model":"configured-model"}
            })))
            .await
            .expect("native validates the direct secret method")["connection"]
            .clone();
        assert_eq!(configured["backendKind"], backend);
        assert_eq!(configured["authMethod"], auth_method);
        assert_eq!(configured["state"], "connected");
        assert_eq!(configured["models"][0]["id"], "configured-model");
    }
    std::fs::remove_dir_all(auth.global_config_path.parent().unwrap()).unwrap();
}
