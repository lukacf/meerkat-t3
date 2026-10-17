use super::*;
use crate::desktop_auth_scope::DesktopAuthScope;

fn scoped_auth(scope: &DesktopAuthScope) -> DesktopProviderAuth {
    let TokenStoreBackend::Auto { root, .. } = scope.token_backend() else {
        panic!("shared hosts must select the native Auto backend");
    };
    DesktopProviderAuth {
        auth_scope: Ok(Some(scope.clone())),
        global_config_path: scope.global_config_path(),
        copilot_accounts: Default::default(),
        account_mutations: Default::default(),
        auth_http: auth_http_client(),
        // Exercise native persistent identities and refresh locking, while
        // preventing these tests from addressing the OS credential store.
        persistence: TokenStoreBackend::File { root }
            .open_with_refresh_authority()
            .map_err(|error| error.to_string()),
        authority: meerkat_runtime::MeerkatMachine::ephemeral().provider_auth_runtime_authority(),
    }
}

fn includes_model(catalog: &Value, model: &str) -> bool {
    catalog["providers"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|provider| provider["models"].as_array().unwrap())
        .any(|entry| entry["id"] == model)
}

#[tokio::test]
async fn shared_auth_scope_accounts_catalog_and_execution_use_the_same_config() {
    let directory = tempfile::tempdir().unwrap();
    let first_scope = DesktopAuthScope::new(directory.path().join("first")).unwrap();
    let second_scope = DesktopAuthScope::new(directory.path().join("second")).unwrap();
    let first = scoped_auth(&first_scope);
    let second = scoped_auth(&second_scope);
    let model = "isolated-shared-host-deployment";
    let result = first
        .configure(Some(&json!({
            "methodId":"foundry-api-key", "secret":"isolated-shared-host-test-key",
            "fields":{"endpoint":"https://cloud.example", "model":model}
        })))
        .await
        .unwrap();
    let connection = &result["connection"];
    assert_eq!(result["credentialsSaved"], true);
    assert_eq!(connection["state"], "connected");
    let id = connection["bindingId"].as_str().unwrap();
    let provider = Provider::parse_strict(connection["provider"].as_str().unwrap()).unwrap();

    let first_config = first.account_config(&Map::new()).await.unwrap();
    let second_config = second.account_config(&Map::new()).await.unwrap();
    assert!(first_config.config.realm["global"].binding.contains_key(id));
    assert!(
        !second_config
            .config
            .realm
            .values()
            .any(|realm| realm.binding.contains_key(id))
    );
    assert!(includes_model(
        &first.account_models_catalog(&Map::new()).await.unwrap(),
        model
    ));
    assert!(!includes_model(
        &second.account_models_catalog(&Map::new()).await.unwrap(),
        model
    ));

    let project = directory.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let state = first_scope.state_root();
    let params = json!({"projectPath":project, "stateRoot":state});
    let selection = first
        .account_config(params.as_object().unwrap())
        .await
        .unwrap();
    let runtime = crate::mobkit_registry::load_effective_realm_config_with_global(
        &project,
        &state,
        &first_scope.global_config_path(),
    )
    .await
    .unwrap();
    let selected = resolve_realm_binding_target_for_provider(
        &selection.config,
        provider,
        None,
        None,
        None,
        Some(&selection.realm),
        false,
    )
    .unwrap();
    let executed = resolve_realm_binding_target_for_provider(
        &runtime.effective,
        provider,
        None,
        None,
        None,
        Some(&runtime.realm_id),
        false,
    )
    .unwrap();
    assert_eq!(selected.auth_binding.binding.as_str(), id);
    assert_eq!(selected.auth_binding, executed.auth_binding);
    assert_eq!(selected.credential_identity, executed.credential_identity);
    assert_eq!(executed.backend.backend_kind, "foundry");
    assert_eq!(executed.binding.default_model.as_deref(), Some(model));
    assert!(includes_model(
        &first
            .account_models_catalog(params.as_object().unwrap())
            .await
            .unwrap(),
        model
    ));

    let other_runtime = crate::mobkit_registry::load_effective_realm_config_with_global(
        &project,
        &second_scope.state_root(),
        &second_scope.global_config_path(),
    )
    .await
    .unwrap();
    assert!(
        !other_runtime
            .effective
            .realm
            .values()
            .any(|realm| realm.binding.contains_key(id))
    );
}

#[tokio::test]
async fn shared_auth_scope_keeps_same_identity_credentials_in_separate_native_stores() {
    let directory = tempfile::tempdir().unwrap();
    let first_scope = DesktopAuthScope::new(directory.path().join("first")).unwrap();
    let second_scope = DesktopAuthScope::new(directory.path().join("second")).unwrap();
    let first = scoped_auth(&first_scope);
    let second = scoped_auth(&second_scope);
    let connection = first
        .configure(Some(&json!({
            "methodId":"openai-api-key", "secret":"isolated-host-custody-test-key",
        })))
        .await
        .unwrap()["connection"]
        .clone();
    let params = json!({"provider":connection["provider"], "realmId":connection["realmId"],
        "bindingId":connection["bindingId"], "profileId":connection["profileId"]});
    let configured = first.account_config(&Map::new()).await.unwrap();
    let target = resolve_target(&configured.config, params.as_object().unwrap()).unwrap();
    let key = TokenKey::from_credential_identity(&target.credential_identity);
    assert!(
        first
            .persistence()
            .unwrap()
            .token_store()
            .load(&key)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        second
            .persistence()
            .unwrap()
            .token_store()
            .load(&key)
            .await
            .unwrap()
            .is_none()
    );

    // Even identical native config/identity cannot make another host's saved
    // credentials available. A fresh authority also rules out cached leases.
    std::fs::create_dir_all(second.global_config_path.parent().unwrap()).unwrap();
    std::fs::copy(&first.global_config_path, &second.global_config_path).unwrap();
    let other_config = second.account_config(&Map::new()).await.unwrap();
    let other_target = resolve_target(&other_config.config, params.as_object().unwrap()).unwrap();
    assert_eq!(target.credential_identity, other_target.credential_identity);
    let status = second
        .account_status(&other_config, &other_target)
        .await
        .unwrap();
    assert_eq!(status["state"], "needs_auth");
    assert!(status["models"].as_array().unwrap().is_empty());
    assert!(
        first
            .persistence()
            .unwrap()
            .token_store()
            .load(&key)
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn shared_auth_scope_invalid_bootstrap_refuses_account_and_catalog_access() {
    let directory = tempfile::tempdir().unwrap();
    let scope = DesktopAuthScope::new(directory.path().join("invalid")).unwrap();
    let mut auth = scoped_auth(&scope);
    auth.auth_scope = Err("The desktop auth root must be a normalized absolute path".into());
    assert!(
        auth.configure(Some(&json!({
            "methodId":"openai-api-key", "secret":"must-not-be-written",
        })))
        .await
        .is_err()
    );
    assert!(auth.status(None).await.is_err());
    assert!(auth.global_models_catalog().await.is_err());
    let params = json!({"projectPath":directory.path(), "stateRoot":scope.state_root()});
    assert!(
        auth.account_config(params.as_object().unwrap())
            .await
            .is_err()
    );
    assert!(!scope.global_config_path().exists());
    assert!(
        auth.persistence()
            .unwrap()
            .token_store()
            .list()
            .await
            .unwrap()
            .is_empty()
    );
}
