use std::future::Future;

use chrono::Utc;
use meerkat_core::{
    resolve_auth_binding_candidates_for_provider, resolve_realm_binding_target_for_provider,
    AuthCredentialIdentity, CredentialSourceSpec, OAuthProviderIdentity, Provider,
    ResolvedConnectionTarget,
};
use meerkat_providers::auth_oauth::{exchange_authorization_code_with_state, OAuthError, PkcePair};
use meerkat_providers::auth_store::{
    credential_source_uses_persisted_store, persisted_auth_mode_is_oauth_login, PersistedTokens,
    ProviderAuthPersistence, TokenKey, TokenStore, TokenStoreBackend,
};
use meerkat_providers::browser_login::{
    save_oauth_tokens_and_consume_browser_flow, BrowserOAuthFlowCommit,
};
use meerkat_providers::oauth_flow::{
    resolve_oauth_provider, validate_oauth_login_connection_target,
};
use serde_json::{json, Value};

use crate::mobkit_registry::load_effective_realm_config;
use crate::{
    derive_project_locator, object_params, optional_string, required_string, GatewayError,
};

#[derive(Clone)]
pub struct DesktopProviderAuth {
    persistence: Result<ProviderAuthPersistence, String>,
    authority: meerkat_runtime::ProviderAuthRuntimeAuthority,
}

impl DesktopProviderAuth {
    pub fn new() -> Self {
        let persistence = TokenStoreBackend::default_keyring_auto()
            .and_then(TokenStoreBackend::open_with_refresh_authority)
            .map_err(|error| error.to_string());
        Self {
            persistence,
            authority: meerkat_runtime::MeerkatMachine::ephemeral()
                .provider_auth_runtime_authority(),
        }
    }

    pub async fn status(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let project_path = required_string(params, "projectPath")?;
        let state_root = optional_string(params, "stateRoot")
            .or_else(|| optional_string(params, "configStateRoot"));
        let locator = derive_project_locator(&project_path, state_root.as_deref())?;
        let realm_config = load_effective_realm_config(&locator.project_path, &locator.state_root)
            .await
            .map_err(auth_policy_error)?;
        let persistence = self.persistence()?;
        let store = persistence.token_store();
        let mut connections = Vec::new();

        for provider in [Provider::OpenAI, Provider::Anthropic, Provider::Gemini] {
            let candidates = match resolve_auth_binding_candidates_for_provider(
                &realm_config.effective,
                provider,
                None,
                Some(&realm_config.realm_id),
                true,
            ) {
                Ok(candidates) => candidates,
                Err(_) => continue,
            };
            let mut statuses = Vec::with_capacity(candidates.len());
            for target in candidates {
                statuses.push(self.connection_status(store.as_ref(), &target).await?);
            }
            if let Some(status) = select_effective_connection_status(statuses) {
                connections.push(status);
            }
        }

        Ok(json!({
            "contractVersion": "desktop-provider-auth.v1",
            "projectPath": locator.project_path,
            "stateRoot": locator.state_root,
            "realmId": realm_config.realm_id,
            "connections": connections,
        }))
    }

    pub async fn login_start(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let project_path = required_string(params, "projectPath")?;
        let provider_name = required_string(params, "provider")?;
        let redirect_uri = required_string(params, "redirectUri")?;
        require_loopback_redirect(&redirect_uri)?;
        let state_root = optional_string(params, "stateRoot")
            .or_else(|| optional_string(params, "configStateRoot"));
        let locator = derive_project_locator(&project_path, state_root.as_deref())?;
        let realm_config = load_effective_realm_config(&locator.project_path, &locator.state_root)
            .await
            .map_err(auth_policy_error)?;
        let provider = parse_provider(&provider_name)?;
        let target = resolve_realm_binding_target_for_provider(
            &realm_config.effective,
            provider,
            None,
            None,
            None,
            Some(&realm_config.realm_id),
            false,
        )
        .map_err(|error| {
            GatewayError::policy(
                "This provider has no configured sign-in profile",
                Some(json!({"provider": provider_name, "error": error.to_string()})),
            )
        })?;
        let resolved =
            resolve_oauth_provider(&provider_name, redirect_uri.clone()).map_err(|error| {
                GatewayError::invalid(error.to_string(), Some(json!({"provider": provider_name})))
            })?;
        validate_oauth_login_connection_target(&target, resolved.identity).map_err(|error| {
            GatewayError::policy(
                "This provider profile does not support browser sign-in",
                Some(json!({"provider": provider_name, "error": error.to_string()})),
            )
        })?;
        let pkce = PkcePair::generate_s256();
        let state = self
            .authority
            .oauth_flow_authority()
            .start(
                target.credential_identity.clone(),
                resolved.identity.into(),
                redirect_uri.clone(),
                pkce.verifier.secret().clone(),
            )
            .map_err(|error| {
                GatewayError::policy(
                    "Could not start provider sign-in",
                    Some(json!({"error": error.to_string()})),
                )
            })?;
        let authorize_url = resolved
            .endpoints
            .authorize_url_with_pkce(&pkce.challenge, &state);
        Ok(json!({
            "provider": provider.as_str(),
            "authorizeUrl": authorize_url,
            "state": state,
            "redirectUri": redirect_uri,
            "realmId": target.auth_binding.realm,
            "bindingId": target.auth_binding.binding,
            "profileId": target.auth_profile.id,
        }))
    }

    pub async fn login_complete(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let project_path = required_string(params, "projectPath")?;
        let provider_name = required_string(params, "provider")?;
        let redirect_uri = required_string(params, "redirectUri")?;
        let state = required_string(params, "state")?;
        let code = required_string(params, "code")?;
        require_loopback_redirect(&redirect_uri)?;
        let state_root = optional_string(params, "stateRoot")
            .or_else(|| optional_string(params, "configStateRoot"));
        let locator = derive_project_locator(&project_path, state_root.as_deref())?;
        let realm_config = load_effective_realm_config(&locator.project_path, &locator.state_root)
            .await
            .map_err(auth_policy_error)?;
        let provider = parse_provider(&provider_name)?;
        let target = resolve_realm_binding_target_for_provider(
            &realm_config.effective,
            provider,
            None,
            None,
            None,
            Some(&realm_config.realm_id),
            false,
        )
        .map_err(|error| auth_target_error(&provider_name, error.to_string()))?;
        let resolved =
            resolve_oauth_provider(&provider_name, redirect_uri.clone()).map_err(|error| {
                GatewayError::invalid(error.to_string(), Some(json!({"provider": provider_name})))
            })?;
        validate_oauth_login_connection_target(&target, resolved.identity)
            .map_err(|error| auth_target_error(&provider_name, error.to_string()))?;
        let exchange_state = state.clone();
        let tokens = self
            .complete_browser_flow(
                target.credential_identity.clone(),
                state,
                resolved.identity,
                redirect_uri,
                |pkce_verifier| async move {
                    let result = exchange_authorization_code_with_state(
                        &reqwest::Client::new(),
                        &resolved.endpoints,
                        &code,
                        &pkce_verifier,
                        resolved.client_secret,
                        Some(&exchange_state),
                    )
                    .await
                    .map_err(map_oauth_exchange_error)?;
                    let now = Utc::now();
                    let expires_at = result.expires_at_from(now).map_err(|error| {
                        GatewayError::policy(
                            "The provider returned an invalid credential expiry",
                            Some(json!({"error": error.to_string()})),
                        )
                    })?;
                    Ok(PersistedTokens {
                        auth_mode: resolved.auth_mode,
                        primary_secret: Some(result.access_token),
                        refresh_token: result.refresh_token,
                        id_token: result.id_token,
                        expires_at,
                        last_refresh: Some(now),
                        scopes: result
                            .scope
                            .as_deref()
                            .map(|scope| scope.split_whitespace().map(String::from).collect())
                            .unwrap_or_default(),
                        account_id: None,
                        metadata: Value::Null,
                    })
                },
            )
            .await?;
        Ok(json!({
            "provider": provider.as_str(),
            "state": "connected",
            "realmId": target.auth_binding.realm,
            "bindingId": target.auth_binding.binding,
            "profileId": target.auth_profile.id,
            "expiresAt": tokens.expires_at.as_ref().map(|value| value.to_rfc3339()),
            "hasRefreshToken": tokens.refresh_token.is_some(),
        }))
    }

    pub async fn logout(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let project_path = required_string(params, "projectPath")?;
        let provider_name = required_string(params, "provider")?;
        let state_root = optional_string(params, "stateRoot")
            .or_else(|| optional_string(params, "configStateRoot"));
        let locator = derive_project_locator(&project_path, state_root.as_deref())?;
        let realm_config = load_effective_realm_config(&locator.project_path, &locator.state_root)
            .await
            .map_err(auth_policy_error)?;
        let provider = parse_provider(&provider_name)?;
        let target = resolve_realm_binding_target_for_provider(
            &realm_config.effective,
            provider,
            None,
            None,
            None,
            Some(&realm_config.realm_id),
            false,
        )
        .map_err(|error| auth_target_error(&provider_name, error.to_string()))?;
        self.clear_tokens(target.credential_identity.clone(), &provider_name)
            .await?;
        Ok(json!({
            "provider": provider.as_str(),
            "state": "needs_auth",
            "cleared": true,
        }))
    }

    fn persistence(&self) -> Result<ProviderAuthPersistence, GatewayError> {
        self.persistence.clone().map_err(|error| {
            GatewayError::policy(
                "The desktop credential store is unavailable",
                Some(json!({"error": error})),
            )
        })
    }

    async fn connection_status(
        &self,
        store: &dyn TokenStore,
        target: &ResolvedConnectionTarget,
    ) -> Result<Value, GatewayError> {
        let source_kind = target.auth_profile.source.kind_label();
        let interactive = credential_source_uses_persisted_store(&target.auth_profile.source)
            && meerkat_providers::NormalizedAuthMethod::parse_for_provider(
                target.auth_profile.provider,
                &target.auth_profile.auth_method,
            )
            .and_then(|method| method.persisted_auth_mode())
            .is_some_and(persisted_auth_mode_is_oauth_login)
            && target.auth_profile.constraints.allow_interactive_login;
        let (state, expires_at, account_id, has_refresh_token) = match &target.auth_profile.source {
            CredentialSourceSpec::ManagedStore | CredentialSourceSpec::PlatformDefault => {
                let key = TokenKey::from_credential_identity(&target.credential_identity);
                match store.load(&key).await {
                    Ok(Some(tokens))
                        if meerkat_core::tokens_lifecycle_published(&tokens)
                            && tokens.primary_secret.is_some() =>
                    {
                        (
                            "connected",
                            tokens.expires_at.map(|value| value.to_rfc3339()),
                            tokens.account_id,
                            tokens.refresh_token.is_some(),
                        )
                    }
                    Ok(Some(_)) => ("reauth_required", None, None, false),
                    Ok(None) => ("needs_auth", None, None, false),
                    Err(error) => {
                        return Err(GatewayError::policy(
                            "Could not read provider credentials",
                            Some(json!({
                                "provider": target.auth_profile.provider.as_str(),
                                "error": error.to_string(),
                            })),
                        ));
                    }
                }
            }
            CredentialSourceSpec::Env { env, fallback } => {
                let available = env_secret_present(env, fallback, &|name| std::env::var(name).ok());
                (
                    if available { "connected" } else { "needs_auth" },
                    None,
                    None,
                    false,
                )
            }
            CredentialSourceSpec::InlineSecret { secret } => (
                if secret.trim().is_empty() {
                    "needs_auth"
                } else {
                    "connected"
                },
                None,
                None,
                false,
            ),
            _ => ("host_managed", None, None, false),
        };
        Ok(json!({
            "provider": target.auth_profile.provider.as_str(),
            "displayName": provider_display_name(target.auth_profile.provider),
            "realmId": target.auth_binding.realm,
            "bindingId": target.auth_binding.binding,
            "profileId": target.auth_profile.id,
            "authMethod": target.auth_profile.auth_method,
            "source": source_kind,
            "state": state,
            "supportsInteractiveLogin": interactive,
            "expiresAt": expires_at,
            "accountId": account_id,
            "hasRefreshToken": has_refresh_token,
        }))
    }

    async fn complete_browser_flow<F, Fut>(
        &self,
        credential_identity: AuthCredentialIdentity,
        state: String,
        provider: OAuthProviderIdentity,
        redirect_uri: String,
        exchange: F,
    ) -> Result<PersistedTokens, GatewayError>
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = Result<PersistedTokens, GatewayError>>,
    {
        let authority = self.authority.oauth_flow_authority();
        let flow = authority
            .verify(&state, &credential_identity, provider.into(), &redirect_uri)
            .map_err(|error| {
                GatewayError::policy(
                    "Provider sign-in expired or did not match this request",
                    Some(json!({"error": error.to_string()})),
                )
            })?;
        let tokens = exchange(flow.pkce_verifier).await?;
        // The native transaction rechecks and consumes the flow under the same
        // credential mutation authority as logout, before publishing tokens.
        save_oauth_tokens_and_consume_browser_flow(
            self.persistence()?,
            self.authority.generated_auth_lease_handle(),
            credential_identity,
            tokens,
            BrowserOAuthFlowCommit {
                authority,
                state,
                completion: provider.into(),
                redirect_uri,
            },
        )
        .await
        .map_err(|error| {
            GatewayError::policy(
                "Provider sign-in could not be committed. Start a new sign-in.",
                Some(json!({"error": error.to_string()})),
            )
        })
    }

    async fn clear_tokens(
        &self,
        credential_identity: AuthCredentialIdentity,
        provider_name: &str,
    ) -> Result<(), GatewayError> {
        meerkat_core::clear_tokens_and_publish_lifecycle_released_coordinated_for_identity(
            self.persistence()?,
            self.authority.generated_auth_lease_handle(),
            credential_identity,
        )
        .await
        .map_err(|error| {
            GatewayError::policy(
                "Could not disconnect this provider",
                Some(json!({"provider": provider_name, "error": error.to_string()})),
            )
        })
    }
}

fn select_effective_connection_status(statuses: Vec<Value>) -> Option<Value> {
    let first = statuses.first().cloned();
    statuses
        .into_iter()
        .find(|status| status.get("state").and_then(Value::as_str) == Some("connected"))
        .or(first)
}

fn env_secret_present(
    env: &str,
    fallback: &[String],
    lookup: &(dyn Fn(&str) -> Option<String> + Sync),
) -> bool {
    std::iter::once(env)
        .chain(fallback.iter().map(String::as_str))
        .any(|candidate| {
            let rkat_override = if candidate.starts_with("RKAT_") {
                None
            } else {
                lookup(&format!("RKAT_{candidate}"))
            };
            rkat_override
                .or_else(|| lookup(candidate))
                .is_some_and(|value| !value.trim().is_empty())
        })
}

fn parse_provider(value: &str) -> Result<Provider, GatewayError> {
    Provider::parse_strict(value).ok_or_else(|| {
        GatewayError::invalid(
            "Unsupported provider",
            Some(json!({"provider": value, "supported": ["openai", "anthropic", "gemini"]})),
        )
    })
}

fn provider_display_name(provider: Provider) -> &'static str {
    match provider {
        Provider::OpenAI => "OpenAI",
        Provider::Anthropic => "Anthropic",
        Provider::Gemini => "Google",
        Provider::SelfHosted => "Self-hosted",
        Provider::Other => "Provider",
    }
}

fn require_loopback_redirect(value: &str) -> Result<(), GatewayError> {
    let valid = value
        .strip_prefix("http://127.0.0.1:")
        .or_else(|| value.strip_prefix("http://localhost:"))
        .is_some_and(|rest| rest.contains('/'));
    if valid {
        Ok(())
    } else {
        Err(GatewayError::invalid(
            "Provider sign-in requires a local loopback callback",
            Some(json!({"redirectUri": value})),
        ))
    }
}

fn auth_policy_error(error: String) -> GatewayError {
    GatewayError::policy(
        "Could not load provider authentication configuration",
        Some(json!({"error": error})),
    )
}

fn auth_target_error(provider: &str, error: String) -> GatewayError {
    GatewayError::policy(
        "This provider sign-in target is unavailable",
        Some(json!({"provider": provider, "error": error})),
    )
}

fn map_oauth_exchange_error(error: OAuthError) -> GatewayError {
    match error {
        OAuthError::TokenEndpoint { status, body } => GatewayError::policy(
            "The provider rejected this sign-in",
            Some(json!({"upstreamStatus": status, "upstreamBody": body})),
        ),
        other => GatewayError::policy(
            "Could not complete provider sign-in",
            Some(json!({"error": other.to_string()})),
        ),
    }
}

#[cfg(test)]
mod lifecycle_tests;

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[tokio::test]
    async fn configured_credential_identity_owns_status_save_and_logout() {
        use meerkat_core::auth::PersistedAuthMode;
        use meerkat_core::{Config, RealmId};
        use meerkat_providers::auth_store::{EphemeralTokenStore, InMemoryCoordinator};

        for account_backed in [false, true] {
            let account = if account_backed {
                "credential_account = \"desktop_shared\""
            } else {
                ""
            };
            let config: Config = toml::from_str(&format!(
                r#"
[realm.global]
default_binding = "desktop_openai"

[realm.global.backend.desktop_openai]
provider = "openai"
backend_kind = "chatgpt_backend"

[realm.global.auth.desktop_openai]
provider = "openai"
auth_method = "managed_chatgpt_oauth"
source = {{ kind = "managed_store" }}

[realm.global.binding.desktop_openai]
backend_profile = "desktop_openai"
auth_profile = "desktop_openai"
{account}
"#
            ))
            .expect("parse isolated OAuth configuration");
            let target = resolve_realm_binding_target_for_provider(
                &config,
                Provider::OpenAI,
                None,
                None,
                None,
                Some(&RealmId::global()),
                false,
            )
            .expect("resolve configured credential authority");
            assert_eq!(
                target.credential_identity.account().is_some(),
                account_backed
            );

            let store = Arc::new(EphemeralTokenStore::new());
            let auth = DesktopProviderAuth {
                persistence: Ok(ProviderAuthPersistence::new(
                    store.clone(),
                    Arc::new(InMemoryCoordinator::new()),
                )),
                authority: meerkat_runtime::MeerkatMachine::ephemeral()
                    .provider_auth_runtime_authority(),
            };
            let identity = target.credential_identity.clone();
            let key = TokenKey::from_credential_identity(&identity);
            let binding_key = TokenKey::from_auth_binding(&target.auth_binding);
            let now = Utc::now();
            let tokens = PersistedTokens {
                auth_mode: PersistedAuthMode::ChatgptOauth,
                primary_secret: Some("isolated-test-access-token".to_string()),
                refresh_token: Some("isolated-test-refresh-token".to_string()),
                id_token: None,
                expires_at: Some(now + chrono::Duration::hours(1)),
                last_refresh: Some(now),
                scopes: vec!["openid".to_string()],
                account_id: None,
                metadata: Value::Null,
            };

            assert_eq!(
                auth.connection_status(store.as_ref(), &target)
                    .await
                    .unwrap()["state"],
                "needs_auth"
            );
            let redirect_uri = "http://127.0.0.1/oauth/callback";
            let state = auth
                .authority
                .oauth_flow_authority()
                .start(
                    identity.clone(),
                    OAuthProviderIdentity::OpenAiChatGpt.into(),
                    redirect_uri.to_string(),
                    "isolated-test-verifier".to_string(),
                )
                .expect("start under the resolved credential authority");
            auth.complete_browser_flow(
                identity.clone(),
                state,
                OAuthProviderIdentity::OpenAiChatGpt,
                redirect_uri.to_string(),
                |_| async { Ok(tokens.clone()) },
            )
            .await
            .expect("save under the resolved credential authority");
            let stored = store.load(&key).await.unwrap().unwrap();
            assert!(meerkat_core::tokens_lifecycle_published(&stored));
            assert_eq!(stored.primary_secret, tokens.primary_secret);
            assert_eq!(
                auth.connection_status(store.as_ref(), &target)
                    .await
                    .unwrap()["state"],
                "connected"
            );
            if account_backed {
                assert_ne!(key, binding_key);
                assert!(store.load(&binding_key).await.unwrap().is_none());
                // An unrelated old route row must neither win status nor be
                // cleared when the configured account logs out.
                store.save(&binding_key, &tokens).await.unwrap();
            }

            auth.clear_tokens(identity, "openai")
                .await
                .expect("clear the resolved credential authority");
            assert!(store.load(&key).await.unwrap().is_none());
            assert_eq!(
                auth.connection_status(store.as_ref(), &target)
                    .await
                    .unwrap()["state"],
                "needs_auth"
            );
            if account_backed {
                assert_eq!(store.load(&binding_key).await.unwrap(), Some(tokens));
            }
        }
    }

    #[test]
    fn accepts_only_loopback_redirects() {
        assert!(require_loopback_redirect("http://127.0.0.1:4567/oauth/callback").is_ok());
        assert!(require_loopback_redirect("http://localhost:4567/oauth/callback").is_ok());
        assert!(require_loopback_redirect("https://example.com/oauth/callback").is_err());
    }

    #[test]
    fn provider_labels_are_user_facing() {
        assert_eq!(provider_display_name(Provider::OpenAI), "OpenAI");
        assert_eq!(provider_display_name(Provider::Anthropic), "Anthropic");
        assert_eq!(provider_display_name(Provider::Gemini), "Google");
    }

    #[test]
    fn environment_presence_matches_meerkat_rkat_precedence_and_fallbacks() {
        let fallback = vec!["GOOGLE_API_KEY".to_string()];
        let lookup = |name: &str| match name {
            "RKAT_GEMINI_API_KEY" => Some("rkat-gemini".to_string()),
            "GOOGLE_API_KEY" => Some("google".to_string()),
            _ => None,
        };
        assert!(env_secret_present("GEMINI_API_KEY", &fallback, &lookup));

        let blank_lookup = |name: &str| match name {
            "RKAT_OPENAI_API_KEY" => Some("  ".to_string()),
            "OPENAI_API_KEY" => Some("openai".to_string()),
            _ => None,
        };
        assert!(!env_secret_present("OPENAI_API_KEY", &[], &blank_lookup));
    }

    #[test]
    fn connected_environment_fallback_wins_over_unavailable_configured_login() {
        let configured = json!({
            "provider": "openai",
            "source": "managed_store",
            "state": "needs_auth",
        });
        let environment = json!({
            "provider": "openai",
            "source": "env",
            "state": "connected",
        });
        let selected =
            select_effective_connection_status(vec![configured, environment.clone()]).unwrap();
        assert_eq!(selected, environment);
    }
}
