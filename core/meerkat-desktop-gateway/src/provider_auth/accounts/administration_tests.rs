use super::*;

fn isolated_auth(
    directory: &std::path::Path,
) -> (
    DesktopProviderAuth,
    Arc<meerkat_providers::auth_store::EphemeralTokenStore>,
) {
    let store = Arc::new(meerkat_providers::auth_store::EphemeralTokenStore::new());
    let auth = DesktopProviderAuth {
        auth_scope: Ok(None),
        global_config_path: directory.join("config.toml"),
        copilot_accounts: Default::default(),
        account_mutations: Default::default(),
        auth_http: auth_http_client(),
        persistence: Ok(ProviderAuthPersistence::new(
            store.clone(),
            Arc::new(meerkat_providers::auth_store::InMemoryCoordinator::new()),
        )),
        authority: meerkat_runtime::MeerkatMachine::ephemeral().provider_auth_runtime_authority(),
    };
    (auth, store)
}

#[tokio::test]
async fn account_creation_cannot_activate_legacy_global_governance() {
    let policy = "[[governance.review.rules]]\ntarget = { kind = \"mcp_server\", server = \"mail\" }\ntier = \"r2\"\n";
    let directory = tempfile::tempdir().unwrap();
    let (auth, store) = isolated_auth(directory.path());
    std::fs::write(&auth.global_config_path, policy).unwrap();
    let input = json!({"methodId":"openai-api-key", "secret":"isolated-administration-test-key"});

    // Signing in provisions realm.global, which would activate this legacy
    // document's governance on other realms. Only its host may do that.
    let before_config = auth.global_runtime().unwrap().get().await.unwrap().config;
    assert!(before_config.realm.is_empty());
    assert!(before_config.governance.is_some());
    let error = auth.configure(Some(&input)).await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("add [realm.global] to the user configuration by hand"),
        "{error}"
    );
    assert!(!error
        .to_string()
        .contains("isolated-administration-test-key"));
    assert_eq!(
        std::fs::read_to_string(&auth.global_config_path).unwrap(),
        policy
    );
    assert!(store.list().await.unwrap().is_empty());

    // The documented native remedy is a host-authored global section.
    // Account configuration may then add credentials without changing it.
    let administered = format!("[realm.global]\n\n{policy}");
    std::fs::write(&auth.global_config_path, &administered).unwrap();
    let result = auth.configure(Some(&input)).await.unwrap();
    assert_eq!(result["credentialsSaved"], true);
    assert_eq!(store.list().await.unwrap().len(), 1);
    let before: toml::Value = toml::from_str(&administered).unwrap();
    let after: toml::Value =
        toml::from_str(&std::fs::read_to_string(&auth.global_config_path).unwrap()).unwrap();
    assert_eq!(after.get("governance"), before.get("governance"));
}

#[tokio::test]
async fn account_creation_preserves_already_global_confinement() {
    let policy = "[confinement.shell]\nmode = \"workspace\"\n";
    let directory = tempfile::tempdir().unwrap();
    let (auth, store) = isolated_auth(directory.path());
    std::fs::write(&auth.global_config_path, policy).unwrap();
    let reader = meerkat_core::config_store::EffectiveConfigReader::new(Arc::new(
        meerkat_store::FilesystemRealmConfigSource::new(
            directory.path().join("state"),
            auth.global_config_path.clone(),
            meerkat_models::canonical(),
        ),
    ));
    let unrelated = RealmId::parse("unrelated-workspace").unwrap();
    let before = reader.effective_config(&unrelated).await.unwrap();
    assert!(before.confinement.shell.is_some());
    assert!(auth
        .global_runtime().unwrap()
        .get()
        .await
        .unwrap()
        .config
        .realm
        .is_empty());

    // Native confinement always folds the user document, even without an
    // explicit realm.global. Adding an account must preserve that authority.
    let result = auth
        .configure(Some(&json!({
            "methodId": "openai-api-key",
            "secret": "isolated-confinement-test-key",
        })))
        .await
        .unwrap();
    assert_eq!(result["credentialsSaved"], true);
    assert_eq!(store.list().await.unwrap().len(), 1);
    let after = reader.effective_config(&unrelated).await.unwrap();
    assert_eq!(before.confinement, after.confinement);
    let persisted: toml::Value =
        toml::from_str(&std::fs::read_to_string(&auth.global_config_path).unwrap()).unwrap();
    let original: toml::Value = toml::from_str(policy).unwrap();
    assert_eq!(persisted.get("confinement"), original.get("confinement"));
}

#[test]
fn config_refusal_projection_does_not_echo_native_details() {
    let private = "PRIVATE-NATIVE-CONTENT";
    let errors = [
        meerkat_core::ConfigError::CompositionAdministration {
            administered: meerkat_core::config::AdministeredSection::Governance,
            change: format!("adding [realm.global] {private}"),
            composer: private.to_string(),
        },
        meerkat_core::ConfigError::CompositionAdministration {
            administered: meerkat_core::config::AdministeredSection::Confinement,
            change: private.to_string(),
            composer: private.to_string(),
        },
        meerkat_core::ConfigError::Validation(private.to_string()),
    ];
    for error in errors {
        let projected = config_write_error(meerkat_core::ConfigRuntimeError::Config(error));
        assert!(!format!("{projected:?}").contains(private));
    }
}
