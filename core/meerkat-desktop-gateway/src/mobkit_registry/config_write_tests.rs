use super::*;

struct Fixture {
    _directory: tempfile::TempDir,
    project: PathBuf,
    state: PathBuf,
    head: PathBuf,
    realm: String,
}

impl Fixture {
    fn new(global: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        let state = directory.path().join("state");
        std::fs::create_dir_all(&project).unwrap();
        let realm = derive_workspace_realm_id(&project);
        let head = state.join(&realm).join("config.toml");
        let global_path = realm_global_config_path(&state).unwrap();
        std::fs::create_dir_all(head.parent().unwrap()).unwrap();
        std::fs::create_dir_all(global_path.parent().unwrap()).unwrap();
        std::fs::write(global_path, global).unwrap();
        std::fs::write(&head, format!("[realm.{realm}]\nparent = \"global\"\n")).unwrap();
        Self {
            _directory: directory,
            project,
            state,
            head,
            realm,
        }
    }

    async fn config(&self) -> EffectiveRealmConfig {
        load_effective_realm_config(&self.project, &self.state)
            .await
            .unwrap()
    }

    fn parent(&self, document: &str) {
        let parent = self.state.join("org").join("config.toml");
        std::fs::create_dir_all(parent.parent().unwrap()).unwrap();
        std::fs::write(parent, format!("[realm.org]\n{document}")).unwrap();
        std::fs::write(
            &self.head,
            format!("[realm.{}]\nparent = \"org\"\n", self.realm),
        )
        .unwrap();
    }
}

#[tokio::test]
async fn native_patch_preserves_missing_keys_and_inherited_values() {
    let fixture = Fixture::new("max_tokens = 777\n[realm.global]\n");
    let realm = fixture.config().await;
    let updated = realm
        .head_store
        .patch(ConfigDelta(json!({"agent": {"model": "gpt-5.5"}})))
        .await
        .unwrap();
    let effective = compose_effective_realm_config(&realm, updated)
        .await
        .unwrap();
    assert_eq!(effective.max_tokens, Some(777));
    let persisted: toml::Value =
        toml::from_str(&std::fs::read_to_string(&fixture.head).unwrap()).unwrap();
    assert_eq!(persisted["agent"]["model"].as_str(), Some("gpt-5.5"));
    assert!(persisted.get("max_tokens").is_none());
    assert!(persisted.get("tools").is_none());
    assert!(persisted.get("confinement").is_none());
    assert!(persisted.get("governance").is_none());
}

#[tokio::test]
async fn workspace_patch_cannot_add_or_rewrite_host_credential_commands() {
    let fixture = Fixture::new("[realm.global]\n");
    let realm = fixture.config().await;
    let original = std::fs::read_to_string(&fixture.head).unwrap();
    let error = realm
        .head_store
        .patch(ConfigDelta(
            json!({"realm": {&fixture.realm: {"auth": {"helper": {
                "provider": "openai", "auth_method": "api_key",
                "source": {"kind": "command", "program": "/bin/echo", "args": ["fixture-only"]}
            }}}}}),
        ))
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        ConfigError::CredentialCommandAdministration { .. }
    ));
    assert_eq!(std::fs::read_to_string(&fixture.head).unwrap(), original);

    // A host-administered descriptor may already exist. Ordinary settings
    // updates preserve it but cannot change what the host would execute.
    let administered = format!(
        "{original}\n[realm.{}.auth.helper]\nprovider = \"openai\"\nauth_method = \"api_key\"\nsource = {{ kind = \"command\", program = \"/bin/echo\", args = [\"fixture-only\"] }}\n",
        fixture.realm,
    );
    std::fs::write(&fixture.head, &administered).unwrap();
    let error = realm
        .head_store
        .patch(ConfigDelta(
            json!({"realm": {&fixture.realm: {"auth": {"helper": {
                "source": {"args": ["changed"]}
            }}}}}),
        ))
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        ConfigError::CredentialCommandAdministration { .. }
    ));
    assert_eq!(
        std::fs::read_to_string(&fixture.head).unwrap(),
        administered
    );
    realm
        .head_store
        .patch(ConfigDelta(json!({"max_tokens": 2048})))
        .await
        .expect("an ordinary model setting does not rewrite the command");
}

#[tokio::test]
async fn workspace_writes_cannot_remove_inherited_governance() {
    let fixture = Fixture::new("[realm.global]\n");
    fixture.parent("[[governance.review.rules]]\ntarget = { kind = \"mcp_server\", server = \"mail\" }\ntier = \"r2\"\n");
    let realm = fixture.config().await;
    let original = std::fs::read_to_string(&fixture.head).unwrap();
    for delta in [
        json!({"realm": {&fixture.realm: {"parent": null}}}),
        json!({"realm": {&fixture.realm: null}}),
        json!({"realm": null}),
    ] {
        let error = realm
            .head_store
            .patch(ConfigDelta(delta))
            .await
            .unwrap_err();
        assert!(
            matches!(
                error,
                ConfigError::CompositionAdministration {
                    administered: meerkat_core::config::AdministeredSection::Governance,
                    ..
                }
            ),
            "{error}"
        );
        assert_eq!(std::fs::read_to_string(&fixture.head).unwrap(), original);
    }
    let error = realm.head_store.set(Config::default()).await.unwrap_err();
    assert!(matches!(
        error,
        ConfigError::CompositionAdministration { .. }
    ));
    let error = realm
        .head_store
        .patch(ConfigDelta(json!({"governance": {}})))
        .await
        .unwrap_err();
    assert!(matches!(error, ConfigError::GovernanceAdministration));
    assert_eq!(std::fs::read_to_string(&fixture.head).unwrap(), original);
}

#[tokio::test]
async fn workspace_patch_cannot_remove_inherited_confinement() {
    let fixture = Fixture::new("[realm.global]\n");
    fixture.parent("[confinement.shell]\nmode = \"workspace\"\n");
    let realm = fixture.config().await;
    let original = std::fs::read_to_string(&fixture.head).unwrap();
    let error = realm
        .head_store
        .patch(ConfigDelta(
            json!({"realm": {&fixture.realm: {"parent": null}}}),
        ))
        .await
        .unwrap_err();
    assert!(
        matches!(
            error,
            ConfigError::CompositionAdministration {
                administered: meerkat_core::config::AdministeredSection::Confinement,
                ..
            }
        ),
        "{error}"
    );
    assert_eq!(std::fs::read_to_string(&fixture.head).unwrap(), original);
}
