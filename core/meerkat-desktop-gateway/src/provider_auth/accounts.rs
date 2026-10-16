//! Desktop account configuration is a UI over native realm bindings and tokens.
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::Arc,
};

use meerkat_core::{
    AuthBindingRef, BindingId, BindingOrigin, Config, ConfigDelta, ConfigRuntime, ConfigStore,
    ProfileId, RealmId,
};
use serde_json::Map;

use super::*;
use crate::mobkit_registry::PresencePreservingFileConfigStore;

pub(super) fn default_global_config_path() -> PathBuf {
    #[cfg(not(test))]
    {
        Config::global_config_path().unwrap_or_else(|| {
            // Failure is explicit when an account operation tries to use this path.
            PathBuf::from("/__missing_user_home__/config.toml")
        })
    }
    #[cfg(test)]
    {
        std::env::temp_dir()
            .join(format!("desktop-auth-{}", uuid::Uuid::new_v4()))
            .join("config.toml")
    }
}

struct AuthConfig {
    config: Config,
    realm: RealmId,
}

fn default_selection_delta(
    section: &meerkat_core::RealmConfigSection,
    selections: &[(Provider, BindingId)],
) -> ConfigDelta {
    let mut changes = Map::new();
    for (id, binding) in &section.binding {
        if let Some((_, selected)) = selections.iter().find(|(provider, _)| {
            section.backend.get(&binding.backend_profile)
                .is_some_and(|backend| backend.provider == provider.as_str())
        }) {
            changes.insert(id.clone(), json!({"provider_default":id == selected.as_str()}));
        }
    }
    let mut global = json!({"binding":changes});
    // A realm-wide default outranks provider_default for its own provider.
    if let Some((_, selected)) = section.default_binding.as_ref()
        .and_then(|id| section.binding.get(id))
        .and_then(|binding| section.backend.get(&binding.backend_profile))
        .and_then(|backend| selections.iter().find(|(provider, _)| backend.provider == provider.as_str()))
    {
        global["default_binding"] = json!(selected);
    }
    ConfigDelta(json!({"realm":{"global":global}}))
}

#[derive(Default)]
pub(super) struct CopilotAccounts {
    runtime: meerkat_copilot::CopilotRuntime,
    // Keep the native account state alive between status requests. Native
    // lifecycle invalidation and discovery refresh remain owned by CopilotRuntime.
    resolved:
        tokio::sync::Mutex<BTreeMap<AuthCredentialIdentity, meerkat_copilot::CopilotResolvedAuth>>,
}

fn copilot_models(
    snapshot: &meerkat_copilot::CopilotModelSnapshot,
    provider: Provider,
    catalog: &Value,
    selectable_providers: &[Provider],
) -> Vec<Value> {
    snapshot.available_model_ids(provider).filter_map(|id| {
        let offering = snapshot.model(id)?;
        if copilot_model_provider(id, offering, catalog, selectable_providers) != Some(provider) { return None; }
        let model = catalog["providers"].as_array().into_iter().flatten()
            .filter(|entry| entry["provider"] == provider.as_str())
            .flat_map(|entry| entry["models"].as_array().into_iter().flatten())
            .find(|entry| entry["id"] == id);
        let recommended = model.is_some_and(|model| model["tier"] == "recommended");
        Some(json!({"id":id, "displayName":offering.name.as_deref().unwrap_or(id), "tier":if recommended {"recommended"} else {"supported"}, "recommended":recommended}))
    }).collect()
}

/// Copilot advertises wire protocols, which can overlap for one model. Choose
/// one supported adapter per offering instead of presenting those adapters as
/// different models or mistaking a compatible adapter for the model's maker.
fn copilot_model_provider(
    id: &str,
    offering: &meerkat_copilot::CopilotModelOffering,
    catalog: &Value,
    selectable_providers: &[Provider],
) -> Option<Provider> {
    if offering.model_picker_enabled == Some(false)
        || offering.capabilities.supports.streaming == Some(false)
    {
        return None;
    }
    let vendor = offering
        .vendor
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase);
    let vendor_provider = match vendor.as_deref() {
        Some("openai") => Some(Provider::OpenAI),
        Some("anthropic") => Some(Provider::Anthropic),
        Some("google" | "gemini") => Some(Provider::Gemini),
        _ => None,
    };
    let usable = |provider: Provider| {
        selectable_providers.contains(&provider) && offering.route_for(provider).is_some()
    };
    if let Some(provider) = vendor_provider.filter(|provider| usable(*provider)) {
        return Some(provider);
    }
    for entry in catalog["providers"].as_array().into_iter().flatten() {
        let Some(provider) = entry["provider"].as_str().and_then(Provider::parse_strict) else {
            continue;
        };
        if usable(provider)
            && entry["models"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|model| model["id"] == id)
        {
            return Some(provider);
        }
    }
    // Unknown vendor/model IDs still have authoritative protocol evidence.
    // Prefer a Messages route, then Responses/ChatCompletions. Gemini's
    // ChatCompletions adapter adds no distinct model when OpenAI also fits.
    [Provider::Anthropic, Provider::OpenAI, Provider::Gemini]
        .into_iter()
        .find(|provider| usable(*provider))
}

fn copilot_default_providers(
    context: &AuthConfig,
    identity: &AuthCredentialIdentity,
) -> Vec<Provider> {
    [Provider::OpenAI, Provider::Anthropic, Provider::Gemini]
        .into_iter()
        .filter(|provider| {
            resolve_realm_binding_target_for_provider(
                &context.config,
                *provider,
                None,
                None,
                None,
                Some(&context.realm),
                true,
            )
            .is_ok_and(|selected| {
                selected.auth_profile.auth_method == "github_copilot_oauth"
                    && &selected.credential_identity == identity
            })
        })
        .collect()
}

fn append_copilot_catalog(
    catalog: &mut Value,
    snapshot: &meerkat_copilot::CopilotModelSnapshot,
    provider: Provider,
    selectable_providers: &[Provider],
) {
    let selected = snapshot
        .available_model_ids(provider)
        .filter(|id| {
            snapshot.model(id).is_some_and(|offering| {
                copilot_model_provider(id, offering, catalog, selectable_providers)
                    == Some(provider)
            })
        })
        .map(str::to_string)
        .collect::<Vec<_>>();
    let Some(entry) = catalog["providers"].as_array_mut().and_then(|providers| {
        providers
            .iter_mut()
            .find(|entry| entry["provider"] == provider.as_str())
    }) else {
        return;
    };
    let Some(models) = entry["models"].as_array_mut() else {
        return;
    };
    for id in selected {
        let Some(offering) = snapshot.model(&id) else {
            continue;
        };
        if let Some(model) = models.iter_mut().find(|model| model["id"] == id) {
            // Account discovery can tighten a known model's limits without
            // replacing its profile or recommendations. Missing account limits
            // do not erase static evidence or imply an unrestricted model.
            let limits = &offering.capabilities.limits;
            for (field, account_limit) in [
                ("context_window", limits.max_context_window_tokens),
                ("max_input_tokens", limits.max_prompt_tokens),
                ("max_output_tokens", limits.max_output_tokens),
            ] {
                if let Some(account_limit) = account_limit {
                    let account_limit = u64::from(account_limit);
                    let effective_limit = model[field]
                        .as_u64()
                        .map_or(account_limit, |static_limit| static_limit.min(account_limit));
                    model[field] = json!(effective_limit);
                }
            }
            continue;
        }
        // The native account discovery owns route and limit evidence. Unknown
        // account models do not inherit capabilities from similarly named models.
        models.push(json!({
            "id":id, "display_name":offering.name.as_deref().unwrap_or(&id), "tier":"supported",
            "context_window":offering.capabilities.limits.max_context_window_tokens,
            "max_input_tokens":offering.capabilities.limits.max_prompt_tokens,
            "max_output_tokens":offering.capabilities.limits.max_output_tokens,
            "profile":{
                "model_family":id, "supports_temperature":false,
                "supports_thinking":false, "supports_reasoning":false,
                "vision":offering.capabilities.supports.vision == Some(true),
                "image_input":offering.capabilities.supports.vision == Some(true),
                "params_schema":{"type":"object", "properties":{}, "additionalProperties":false}
            }
        }));
    }
}

#[derive(Clone, Copy)]
struct Method {
    id: &'static str,
    provider: Provider,
    name: &'static str,
    backend: &'static str,
    auth: &'static str,
    flow: &'static str,
    description: &'static str,
    endpoint: Option<&'static str>,
}

// These are product forms, not a second compatibility table. Every configured
// form is parsed and validated through ProviderRuntimeCatalog before a write.
const METHODS: &[Method] = &[
    Method {
        id: "openai-chatgpt",
        provider: Provider::OpenAI,
        name: "ChatGPT",
        backend: "chatgpt_backend",
        auth: "managed_chatgpt_oauth",
        flow: "browser",
        description: "Sign in with your ChatGPT account.",
        endpoint: Some(
            meerkat_core::provider_matrix::openai_backend::CHATGPT_CODEX_DEFAULT_BASE_URL,
        ),
    },
    Method {
        id: "anthropic-claude",
        provider: Provider::Anthropic,
        name: "Claude",
        backend: "anthropic_api",
        auth: "claude_ai_oauth",
        flow: "browser",
        description: "Sign in with your Claude account.",
        endpoint: None,
    },
    Method {
        id: "google-account",
        provider: Provider::Gemini,
        name: "Google account",
        backend: "google_code_assist",
        auth: "google_oauth",
        flow: "browser",
        description: "Sign in for Gemini Code Assist.",
        endpoint: Some(
            meerkat_core::provider_matrix::google_backend::GOOGLE_CODE_ASSIST_DEFAULT_BASE_URL,
        ),
    },
    Method {
        id: "github-copilot",
        provider: Provider::OpenAI,
        name: "GitHub Copilot",
        backend: "copilot",
        auth: "github_copilot_oauth",
        flow: "device",
        description: "Connect the models included in your GitHub Copilot account.",
        endpoint: None,
    },
    Method {
        id: "openai-api-key",
        provider: Provider::OpenAI,
        name: "OpenAI API key",
        backend: "openai_api",
        auth: "api_key",
        flow: "secret",
        description: "Use an API key from OpenAI Platform.",
        endpoint: None,
    },
    Method {
        id: "anthropic-api-key",
        provider: Provider::Anthropic,
        name: "Anthropic API key",
        backend: "anthropic_api",
        auth: "api_key",
        flow: "secret",
        description: "Use an API key from Anthropic Console.",
        endpoint: None,
    },
    Method {
        id: "google-api-key",
        provider: Provider::Gemini,
        name: "Google API key",
        backend: "google_genai",
        auth: "api_key",
        flow: "secret",
        description: "Use a Gemini API key from Google AI Studio.",
        endpoint: None,
    },
    Method {
        id: "azure-openai-api-key",
        provider: Provider::OpenAI,
        name: "Azure OpenAI",
        backend: "azure_openai",
        auth: "azure_api_key",
        flow: "secret",
        description: "Connect an Azure OpenAI endpoint with its API key.",
        endpoint: None,
    },
    Method {
        id: "bedrock-bearer",
        provider: Provider::Anthropic,
        name: "Amazon Bedrock",
        backend: "bedrock",
        auth: "bedrock_bearer",
        flow: "secret",
        description: "Connect an Amazon Bedrock model with a bearer token.",
        endpoint: None,
    },
    Method {
        id: "foundry-api-key",
        provider: Provider::Anthropic,
        name: "Microsoft Foundry",
        backend: "foundry",
        auth: "foundry_api_key",
        flow: "secret",
        description: "Connect a Claude deployment in Microsoft Foundry with an API key.",
        endpoint: None,
    },
];

fn deployed_backend(backend: &str) -> bool {
    matches!(backend, "azure_openai" | "bedrock" | "foundry")
}

fn callback_policy(method: &Method) -> Option<Value> {
    // Mirror Meerkat CLI OAuthLoginProvider's callback policy. The released
    // auth runtime exposes OAuth exchange primitives but no listener policy.
    match method.auth {
        "managed_chatgpt_oauth" => Some(json!({
            "redirectHost":"localhost", "path":"/auth/callback", "ports":[1455,1457]
        })),
        "claude_ai_oauth" => Some(json!({
            "redirectHost":"localhost", "path":"/callback", "ports":[0]
        })),
        "google_oauth" => Some(json!({
            "redirectHost":"127.0.0.1", "path":"/callback", "ports":[0]
        })),
        _ => None,
    }
}

fn methods() -> Vec<Value> {
    METHODS.iter().map(|method| {
        let mut fields = vec![json!({"key":"name", "label":"Account name", "required":false, "secret":false})];
        if deployed_backend(method.backend) {
            fields.push(json!({"key":"endpoint", "label":"Endpoint URL", "required":true, "secret":false}));
            fields.push(json!({"key":"model", "label":if method.backend == "bedrock" {"Model or inference profile"} else {"Deployment name"}, "required":true, "secret":false}));
        }
        let mut view = json!({
        "id": method.id,
        "provider": if method.flow == "device" { "copilot" } else { method.provider.as_str() },
        "displayName": method.name,
        "authMethod": method.auth,
        "backendKind": method.backend,
        "flow": method.flow,
        "secretLabel":if method.backend == "bedrock" {"Bearer token"} else {"API key"},
        "description": method.description,
        "fields": fields,
    });
        if let Some(callback) = callback_policy(method) {
            view["callback"] = callback;
        }
        view
    }).collect()
}

fn native_error(_error: impl std::fmt::Display) -> GatewayError {
    GatewayError::policy("The account operation could not be completed", None)
}

fn auth_http_client_builder(timeout: std::time::Duration) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .connect_timeout(timeout.min(std::time::Duration::from_secs(10)))
}

pub(super) fn auth_http_client() -> Result<reqwest::Client, String> {
    auth_http_client_builder(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())
}

fn identity_params(params: &Map<String, Value>) -> Result<AuthBindingRef, GatewayError> {
    Ok(AuthBindingRef {
        realm: RealmId::parse(required_string(params, "realmId")?).map_err(native_error)?,
        binding: BindingId::parse(required_string(params, "bindingId")?).map_err(native_error)?,
        profile: optional_string(params, "profileId")
            .map(ProfileId::parse)
            .transpose()
            .map_err(native_error)?,
        origin: BindingOrigin::Configured,
    })
}

fn resolve_target(
    config: &Config,
    params: &Map<String, Value>,
) -> Result<ResolvedConnectionTarget, GatewayError> {
    let mut identity = identity_params(params)?;
    // The UI profileId is a fence for the binding's configured auth profile,
    // not a request for a native profile override (which has a different
    // credential identity). Resolve the same binding used by runtime defaults.
    let expected_profile = identity.profile.take();
    let target = meerkat_core::resolve_explicit_auth_binding_target(config, &identity)
        .map_err(native_error)?;
    if identity.realm != target.auth_binding.realm {
        return Err(GatewayError::policy(
            "Edit this account in the configuration where it is defined",
            None,
        ));
    }
    if expected_profile
        .as_ref()
        .is_some_and(|profile| profile.as_str() != target.auth_profile.id)
    {
        return Err(GatewayError::policy(
            "The account profile changed. Refresh provider settings and try again",
            None,
        ));
    }
    if let Some(provider) = optional_string(params, "provider") {
        let copilot =
            target.auth_profile.auth_method == "github_copilot_oauth" && provider == "copilot";
        if !copilot && provider != target.auth_profile.provider.as_str() {
            return Err(GatewayError::invalid(
                "The selected account belongs to another provider",
                None,
            ));
        }
    }
    Ok(target)
}

fn oauth_target(
    target: &ResolvedConnectionTarget,
) -> Result<meerkat::HostAuthTarget, GatewayError> {
    let provider = match target.auth_profile.auth_method.as_str() {
        "managed_chatgpt_oauth" => OAuthProviderIdentity::OpenAiChatGpt,
        "claude_ai_oauth" => OAuthProviderIdentity::AnthropicClaudeAi,
        "google_oauth" => OAuthProviderIdentity::GoogleCodeAssist,
        "github_copilot_oauth" => OAuthProviderIdentity::GitHubCopilot,
        _ => {
            return Err(GatewayError::policy(
                "This account does not use interactive sign-in",
                None,
            ))
        }
    };
    Ok(meerkat::HostAuthTarget {
        provider,
        realm_id: target.auth_binding.realm.clone(),
        binding_id: target.auth_binding.binding.clone(),
        profile_id: target.auth_binding.profile.clone(),
    })
}

struct AccountRemoval {
    delta: ConfigDelta,
    bindings: Vec<AuthBindingRef>,
}

fn account_removal(
    config: &Config,
    target: &ResolvedConnectionTarget,
) -> Result<AccountRemoval, GatewayError> {
    if target.auth_binding.realm != RealmId::global()
        || !target.auth_binding.origin.is_configured()
        || !credential_source_uses_persisted_store(&target.auth_profile.source)
    {
        return Err(GatewayError::policy(
            "This account is managed outside global provider settings",
            None,
        ));
    }
    meerkat_core::connection::resolve_write_owner(
        config,
        &target.auth_binding.realm,
        &target.auth_binding.binding,
    )
    .map_err(native_error)?;
    let section = config
        .realm
        .get("global")
        .ok_or_else(|| GatewayError::not_found("Account configuration not found", None))?;
    let mut bindings = Vec::new();
    for id in section.binding.keys() {
        let identity = AuthBindingRef {
            realm: RealmId::global(),
            binding: BindingId::parse(id).map_err(native_error)?,
            profile: None,
            origin: BindingOrigin::Configured,
        };
        let candidate = meerkat_core::resolve_explicit_auth_binding_target(config, &identity)
            .map_err(native_error)?;
        if candidate.credential_identity == target.credential_identity {
            bindings.push(identity);
        }
    }
    let removed = bindings
        .iter()
        .map(|binding| binding.binding.as_str())
        .collect::<BTreeSet<_>>();
    if !removed.contains(target.auth_binding.binding.as_str()) {
        return Err(GatewayError::not_found("Account binding not found", None));
    }
    let mut binding_patch = Map::new();
    let mut auth_patch = Map::new();
    let mut backend_patch = Map::new();
    for id in &removed {
        let binding = &section.binding[*id];
        binding_patch.insert((*id).to_string(), Value::Null);
        // Only profiles reached through removed bindings are candidates for
        // cleanup. Keep profiles referenced by any remaining configured route.
        let removed = &removed;
        let remaining = || {
            config.realm.iter().flat_map(|(realm, section)| {
                section.binding.iter().filter(move |(id, _)| {
                    realm != "global" || !removed.contains(id.as_str())
                })
            })
        };
        if !remaining().any(|(_, other)| other.auth_profile == binding.auth_profile) {
            auth_patch.insert(binding.auth_profile.clone(), Value::Null);
        }
        if !remaining().any(|(_, other)| other.backend_profile == binding.backend_profile) {
            backend_patch.insert(binding.backend_profile.clone(), Value::Null);
        }
    }
    let mut global = json!({"binding":binding_patch,"auth":auth_patch,"backend":backend_patch});
    if section
        .default_binding
        .as_deref()
        .is_some_and(|id| removed.contains(id))
    {
        global["default_binding"] = Value::Null;
    }
    let delta = ConfigDelta(json!({"realm":{"global":global}}));
    // Use native merge and validation before revoking credentials. A malformed
    // or externally owned reference must not cause a destructive half-write.
    meerkat_core::apply_config_patch_preview(config, delta.0.clone())
        .map_err(native_error)?
        .validate(meerkat_models::canonical())
        .map_err(native_error)?;
    Ok(AccountRemoval { delta, bindings })
}

impl DesktopProviderAuth {
    fn global_runtime(&self) -> ConfigRuntime {
        ConfigRuntime::new(
            Arc::new(PresencePreservingFileConfigStore::new(
                self.global_config_path.clone(),
                meerkat_models::canonical(),
            )),
            self.global_config_path
                .with_file_name("desktop-auth-config-state.json"),
        )
    }

    fn host_service(&self) -> Result<meerkat::HostAuthService, GatewayError> {
        Ok(meerkat::HostAuthService::new(self.persistence()?, self.authority.clone())
            .with_http_client(self.auth_http.clone().map_err(native_error)?))
    }

    async fn account_config(
        &self,
        params: &Map<String, Value>,
    ) -> Result<AuthConfig, GatewayError> {
        if let Some(project) = optional_string(params, "projectPath") {
            let root = optional_string(params, "stateRoot")
                .or_else(|| optional_string(params, "configStateRoot"));
            let locator = derive_project_locator(&project, root.as_deref())?;
            let realm = load_effective_realm_config(&locator.project_path, &locator.state_root)
                .await
                .map_err(auth_policy_error)?;
            return Ok(AuthConfig {
                config: realm.effective,
                realm: realm.realm_id,
            });
        }
        let store = PresencePreservingFileConfigStore::new(
            self.global_config_path.clone(),
            meerkat_models::canonical(),
        );
        let mut config = store.get().await.map_err(native_error)?;
        config.apply_env_overrides().map_err(native_error)?;
        Ok(AuthConfig {
            config,
            realm: RealmId::global(),
        })
    }

    pub(crate) async fn global_models_catalog(&self) -> Result<Value, GatewayError> {
        Ok(json!({"realmId":"global", "catalog": self.account_models_catalog(&Map::new()).await?}))
    }

    pub(crate) async fn selection_catalog(
        &self,
        project_path: &std::path::Path,
        config_state_root: &std::path::Path,
    ) -> Result<Vec<crate::EffectiveCatalogModel>, GatewayError> {
        let params = json!({"projectPath":project_path, "stateRoot":config_state_root});
        crate::catalog_models(
            &self
                .account_models_catalog(params.as_object().expect("object"))
                .await?,
        )
    }

    pub(crate) async fn account_models_catalog(
        &self,
        params: &Map<String, Value>,
    ) -> Result<Value, GatewayError> {
        let context = self.account_config(params).await?;
        let mut catalog = crate::effective_models_catalog(&context.config)?;
        let overview = self.accounts_status(params).await?;
        for connection in overview["connections"].as_array().into_iter().flatten() {
            if connection["isDefault"] != true || connection["state"] != "connected" {
                continue;
            }
            let provider =
                Provider::parse_strict(connection["provider"].as_str().unwrap_or_default())
                    .ok_or_else(|| GatewayError::invalid("Invalid account provider", None))?;
            let target = resolve_realm_binding_target_for_provider(
                &context.config,
                provider,
                None,
                None,
                None,
                Some(&context.realm),
                true,
            )
            .map_err(native_error)?;
            if deployed_backend(&target.backend.backend_kind) {
                if let Some(model) = target.binding.default_model.as_deref() {
                    if let Some(models) = catalog["providers"]
                        .as_array_mut()
                        .and_then(|providers| {
                            providers
                                .iter_mut()
                                .find(|entry| entry["provider"] == provider.as_str())
                        })
                        .and_then(|entry| entry["models"].as_array_mut())
                    {
                        if !models.iter().any(|entry| entry["id"] == model) {
                            models.push(
                                json!({"id":model, "display_name":model, "tier":"supported"}),
                            );
                        }
                    }
                }
                continue;
            }
            if connection["modelsVerified"] != true {
                continue;
            }
            let cache = self.copilot_accounts.resolved.lock().await;
            let Some(snapshot) = cache
                .get(&target.credential_identity)
                .and_then(|resolved| resolved.model_snapshot())
            else {
                continue;
            };
            append_copilot_catalog(
                &mut catalog,
                &snapshot,
                provider,
                &copilot_default_providers(&context, &target.credential_identity),
            );
        }
        Ok(catalog)
    }

    pub(super) async fn accounts_status(
        &self,
        params: &Map<String, Value>,
    ) -> Result<Value, GatewayError> {
        let context = self.account_config(params).await?;
        let mut connections = Vec::new();
        let mut seen = BTreeSet::new();
        // Candidate resolution is selection policy, not a list API: it returns
        // only each realm's selected route. Enumerate bindings on the native
        // realm chain so secondary accounts remain visible and addressable.
        let chain = meerkat_core::connection::RealmChain::resolve(&context.config, &context.realm)
            .map_err(native_error)?;
        for realm in chain.realms() {
            if let Some(section) = context.config.realm.get(realm.as_str()) {
                for id in section.binding.keys() {
                    let target = meerkat_core::resolve_explicit_auth_binding_target(
                        &context.config,
                        &AuthBindingRef {
                            realm: realm.clone(),
                            binding: BindingId::parse(id).map_err(native_error)?,
                            profile: None,
                            origin: BindingOrigin::Configured,
                        },
                    )
                    .map_err(native_error)?;
                    let key = (
                        target.auth_profile.provider.as_str().to_string(),
                        target.auth_binding.realm.to_string(),
                        target.auth_binding.binding.to_string(),
                        target.auth_profile.id.clone(),
                    );
                    if seen.insert(key) {
                        connections.push(self.account_status(&context, &target).await?);
                    }
                }
            }
        }
        for provider in [Provider::OpenAI, Provider::Anthropic, Provider::Gemini] {
            let candidates = resolve_auth_binding_candidates_for_provider(
                &context.config,
                provider,
                None,
                Some(&context.realm),
                true,
            )
            .map_err(native_error)?;
            for target in candidates {
                let key = (
                    target.auth_profile.provider.as_str().to_string(),
                    target.auth_binding.realm.to_string(),
                    target.auth_binding.binding.to_string(),
                    target.auth_profile.id.clone(),
                );
                if seen.insert(key) {
                    let status = self.account_status(&context, &target).await?;
                    // Native env defaults are fallback candidates, not saved
                    // accounts. Only expose one when its credential is present.
                    if !target.auth_binding.realm.is_env_default() || status["state"] == "connected"
                    {
                        connections.push(status);
                    }
                }
            }
        }
        Ok(json!({
            "contractVersion":"desktop-provider-auth.v2",
            "realmId":context.realm,
            "methods":methods(),
            "connections":connections,
        }))
    }

    /// Explicit account access may ask the operating system to unlock saved
    /// credentials. Passive status and model discovery never take this path.
    pub async fn check(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        self.check_with_timeout(params, meerkat_providers::auth_store::CREDENTIAL_ADMISSION_WAIT)
            .await
    }

    async fn check_with_timeout(
        &self,
        params: Option<&Value>,
        timeout: std::time::Duration,
    ) -> Result<Value, GatewayError> {
        let deadline = tokio::time::Instant::now() + timeout;
        let pending = || GatewayError::policy(
            "The credential check is still pending. Complete any system prompt, then check the account again.",
            Some(json!({"credentialObservation":"pending"})),
        );
        let _mutation = tokio::time::timeout_at(deadline, self.account_mutations.lock())
            .await.map_err(|_| pending())?;
        let params = object_params(params)?;
        let context = self.account_config(params).await?;
        let target = resolve_target(&context.config, params)?;
        if !credential_source_uses_persisted_store(&target.auth_profile.source) {
            return Err(GatewayError::policy("This account's credentials are managed by its host", None));
        }
        let mode = meerkat_providers::NormalizedAuthMethod::from_auth_profile(&target.auth_profile)
            .and_then(meerkat_providers::NormalizedAuthMethod::persisted_auth_mode)
            .ok_or_else(|| GatewayError::policy("This account does not use saved credentials", None))?;
        let persistence = self.persistence()?;
        let lease = self.authority.generated_auth_lease_handle();
        let lease_key = meerkat_core::handles::LeaseKey::from_credential_identity(&target.credential_identity);
        let checked = tokio::time::timeout_at(deadline, async {
            let guard = meerkat_core::acquire_auth_login_lifecycle_guard(&lease_key).await;
            let tokens = persistence.token_store()
                .load_for(
                    &TokenKey::from_credential_identity(&target.credential_identity),
                    meerkat_providers::auth_store::TokenStoreAccess::Interactive,
                )
                .await
                .map_err(|error| GatewayError::policy(
                    "The saved credentials could not be checked. Check the account's system access and try again.",
                    error.credential_access().map(|(reason, _)| json!({"credentialObservation":reason.as_str()})),
                ))?;
            meerkat_core::rehydrate_loaded_marked_tokens_with_guard(
                tokens, &lease, &target.credential_identity, mode, Utc::now(), &guard,
            ).map_err(native_error)
        }).await.map_err(|_| pending())??;
        if checked.is_some() {
            let _ = tokio::time::timeout_at(deadline, self.refresh_copilot_account(&target)).await;
        }
        let mut connection = self.account_status(&context, &target).await?;
        if checked.is_none() {
            connection["state"] = json!("needs_auth");
            connection["credentialObservation"] = Value::Null;
            connection["models"] = json!([]);
        }
        Ok(json!({"checked":true,"connection":connection}))
    }

    async fn account_credential_status(
        &self,
        config: &Config,
        target: &ResolvedConnectionTarget,
    ) -> Result<Value, GatewayError> {
        let store = self.persistence()?.token_store();
        let mut status = self.connection_status(store.as_ref(), target).await?;
        let method =
            meerkat_providers::NormalizedAuthMethod::from_auth_profile(&target.auth_profile);
        let persisted =
            method.and_then(meerkat_providers::NormalizedAuthMethod::persisted_auth_mode);
        let editable = credential_source_uses_persisted_store(&target.auth_profile.source);
        let interactive = editable
            && persisted.is_some_and(persisted_auth_mode_is_oauth_login)
            && target.auth_profile.constraints.allow_interactive_login
            && oauth_target(target).is_ok();
        if persisted.is_none() {
            status["state"] = json!("host_managed");
        }
        if editable && persisted.is_some_and(persisted_auth_mode_is_oauth_login) {
            let host_target = oauth_target(target)?;
            let native = self
                .host_service()?
                .status(config, &host_target)
                .await
                .map_err(native_error)?;
            if native.credential_observation.is_some() {
                status["credentialObservation"] = json!(native.credential_observation);
            }
            if native.phase.is_no_live_lease()
                && (native.credential_observation.is_some() || !status["credentialObservation"].is_null())
            {
                // An absent live lease is not evidence that the OS store has
                // no saved credential. Keep an unanswered observation unknown.
                status["state"] = json!("unknown");
                status["expiresAt"] = json!(native.expires_at.map(|value| value.to_rfc3339()));
                status["accountId"] = json!(native.account_id);
                status["supportsInteractiveLogin"] = json!(interactive);
                return Ok(status);
            }
            use meerkat_core::handles::{
                CredentialUseDisposition, LeaseKey, OAuthLoginCredentialFacts,
            };
            // Expired OAuth credentials can still refresh automatically. Ask
            // the same native classifier used by provider execution instead
            // of treating an expiry timestamp as a need to sign in again.
            let disposition = self
                .authority
                .generated_auth_lease_handle()
                .resolve_oauth_login_credential_disposition(
                    &LeaseKey::from_credential_identity(&target.credential_identity),
                    OAuthLoginCredentialFacts {
                        credential_present: status["state"] == "connected"
                            || !native.phase.is_no_live_lease(),
                        force_refresh: false,
                        refresh_allowed: target.auth_profile.constraints.allow_refresh,
                    },
                )
                .map_err(native_error)?;
            status["state"] = json!(match disposition {
                CredentialUseDisposition::Authorized
                | CredentialUseDisposition::RefreshRequired => "connected",
                CredentialUseDisposition::ReauthRequired
                | CredentialUseDisposition::RefreshDisallowed => "reauth_required",
                CredentialUseDisposition::LeaseAbsent => "needs_auth",
                CredentialUseDisposition::AlreadyRefreshing => "unknown",
            });
            if native.phase.is_no_live_lease() {
                status["state"] = json!("needs_auth");
            }
            status["expiresAt"] = json!(native.expires_at.map(|value| value.to_rfc3339()));
            status["accountId"] = json!(native.account_id);
        }
        status["supportsInteractiveLogin"] = json!(interactive);
        Ok(status)
    }

    pub(crate) async fn model_auth_status(
        &self,
        config: &Config,
        preferred_realm: &RealmId,
        identity: &meerkat_core::SessionLlmIdentity,
    ) -> Value {
        let mut status = Self::unknown_model_auth(identity);
        // This is the same native selector used by execution. A saved binding
        // is authoritative even when another account is now the default.
        let Ok(target) = meerkat_core::resolve_auth_binding_or_default_for_provider(
            config,
            identity.provider,
            identity.auth_binding.as_ref(),
            Some(preferred_realm),
            true,
        ) else {
            return status;
        };
        status["realmId"] = json!(target.auth_binding.realm);
        status["bindingId"] = json!(target.auth_binding.binding);
        status["profileId"] = json!(target.auth_profile.id);
        status["accountLabel"] = json!(target.auth_profile.id.replace(['-', '_'], " "));
        status["authMethod"] = json!(target.auth_profile.auth_method);
        status["backendKind"] = json!(target.backend.backend_kind);
        if let Ok(credentials) = self.account_credential_status(config, &target).await {
            status["state"] = credentials["state"].clone();
            status["credentialObservation"] = credentials["credentialObservation"].clone();
        }
        status
    }

    pub(crate) fn unknown_model_auth(identity: &meerkat_core::SessionLlmIdentity) -> Value {
        json!({
            "state":"unknown", "provider":identity.provider.as_str(),
            "source": if identity.auth_binding.is_some() {"pinned"} else {"default"}
        })
    }

    async fn account_status(
        &self,
        context: &AuthConfig,
        target: &ResolvedConnectionTarget,
    ) -> Result<Value, GatewayError> {
        let mut status = self
            .account_credential_status(&context.config, target)
            .await?;
        let persisted =
            meerkat_providers::NormalizedAuthMethod::from_auth_profile(&target.auth_profile)
                .and_then(meerkat_providers::NormalizedAuthMethod::persisted_auth_mode);
        let editable = credential_source_uses_persisted_store(&target.auth_profile.source);
        let interactive = status["supportsInteractiveLogin"] == true;
        let native_default = resolve_realm_binding_target_for_provider(
            &context.config,
            target.auth_profile.provider,
            None,
            None,
            None,
            Some(&context.realm),
            true,
        )
        .ok();
        let is_default = native_default.as_ref().is_some_and(|selected| {
            selected.auth_binding.realm == target.auth_binding.realm
                && selected.auth_binding.binding == target.auth_binding.binding
        });
        let copilot = target.auth_profile.auth_method == "github_copilot_oauth";
        if let AuthCredentialIdentity::Account(account) = &target.credential_identity {
            status["credentialAccount"] = json!({"realm":account.realm, "account":account.account});
        }
        status["backendKind"] = json!(target.backend.backend_kind);
        status["accountLabel"] = json!(target.auth_profile.id.replace(['-', '_'], " "));
        status["editable"] = json!(editable);
        status["isDefault"] = json!(is_default);
        status["loginFlow"] = json!(if interactive {
            Some(if copilot { "device" } else { "browser" })
        } else {
            None
        });
        status["supportsInteractiveLogin"] = json!(interactive);
        status["supportsSecretUpdate"] = json!(
            editable
                && persisted.is_some_and(meerkat_core::persisted_auth_mode_is_directly_creatable)
        );
        status["supportsDefault"] = json!(target.auth_binding.realm == RealmId::global());
        status["supportsRemoval"] = json!(
            context.realm == RealmId::global()
                && account_removal(&context.config, target).is_ok()
        );
        let public_endpoint = target.backend.base_url.as_deref().filter(|endpoint| {
            reqwest::Url::parse(endpoint).is_ok_and(|url| {
                url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
            })
        });
        status["fields"] = json!({"name":target.auth_profile.id.replace(['-', '_'], " ")});
        if deployed_backend(&target.backend.backend_kind) && public_endpoint.is_some() {
            status["fields"]["endpoint"] = json!(public_endpoint);
            status["fields"]["model"] = json!(target.binding.default_model);
        }
        status["displayName"] = json!(if copilot {
            format!(
                "GitHub Copilot ({})",
                provider_display_name(target.auth_profile.provider)
            )
        } else {
            provider_display_name(target.auth_profile.provider).to_string()
        });
        status["modelsVerified"] = json!(false);
        let standard_catalog = matches!(
            target.backend.backend_kind.as_str(),
            "openai_api"
                | "chatgpt_backend"
                | "anthropic_api"
                | "google_genai"
                | "google_code_assist"
        );
        status["models"] = if status["state"] == "connected" && standard_catalog {
            let catalog = crate::effective_models_catalog(&context.config)?;
            let provider = catalog["providers"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|entry| entry["provider"] == target.auth_profile.provider.as_str());
            json!(provider.and_then(|entry| entry["models"].as_array()).into_iter().flatten().map(|model| json!({
                "id":model["id"], "displayName":model["display_name"], "tier":model["tier"], "recommended":model["tier"] == "recommended"
            })).collect::<Vec<_>>())
        } else {
            json!([])
        };
        if deployed_backend(&target.backend.backend_kind) && status["state"] == "connected" {
            if let Some(model) = target.binding.default_model.as_deref() {
                status["models"] = json!([{"id":model, "displayName":model, "tier":"supported", "recommended":false}]);
            }
        }
        if copilot && status["state"] == "connected" {
            // Resolving Copilot auth can read the OS credential store. Passive
            // status only projects the native snapshot obtained by sign-in or
            // an explicit account check.
            let snapshot = self.copilot_accounts.resolved.lock().await
                .get(&target.credential_identity)
                .and_then(meerkat_copilot::CopilotResolvedAuth::model_snapshot);
            if let Some(snapshot) = snapshot {
                let defaults = copilot_default_providers(context, &target.credential_identity);
                let routes = if defaults.is_empty() {
                    vec![Provider::OpenAI, Provider::Anthropic, Provider::Gemini]
                } else {
                    defaults
                };
                status["models"] = json!(copilot_models(
                    &snapshot,
                    target.auth_profile.provider,
                    &crate::effective_models_catalog(&context.config)?,
                    &routes,
                ));
                status["modelsVerified"] = json!(true);
            }
        }
        Ok(status)
    }

    async fn refresh_copilot_account(&self, target: &ResolvedConnectionTarget) {
        if target.auth_profile.auth_method != "github_copilot_oauth" {
            return;
        }
        let Ok(validated) = meerkat_providers::ProviderRuntimeCatalog::validate_binding_with_credential_identity(
            &target.auth_binding, target.credential_identity.clone(), &target.backend,
            &target.auth_profile, &target.binding.policy,
        ) else { return };
        let Ok(persistence) = self.persistence() else { return };
        let environment = meerkat_providers::ResolverEnvironment::with_process_env()
            .with_provider_auth_persistence(persistence)
            .with_auth_lease_handle(self.authority.generated_auth_lease_handle());
        if let Ok(Ok(resolved)) = tokio::time::timeout(
            meerkat_providers::auth_store::CREDENTIAL_ADMISSION_WAIT,
            self.copilot_accounts.runtime.resolve(&validated, &environment),
        ).await {
            self.copilot_accounts.resolved.lock().await
                .insert(target.credential_identity.clone(), resolved);
        }
    }

    pub async fn configure(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let _mutation = self.account_mutations.lock().await;
        let params = object_params(params)?;
        let method_id = required_string(params, "methodId")?;
        let method = METHODS
            .iter()
            .find(|entry| entry.id == method_id)
            .ok_or_else(|| GatewayError::invalid("Unknown account method", None))?;
        let secret = optional_string(params, "secret");
        if method.flow == "secret" && secret.as_ref().is_none_or(|value| value.trim().is_empty()) {
            return Err(GatewayError::invalid("Enter a credential", None));
        }
        if method.flow != "secret" && secret.is_some() {
            return Err(GatewayError::invalid(
                "This account uses interactive sign-in",
                None,
            ));
        }
        let fields = params.get("fields").and_then(Value::as_object);
        if fields.is_some_and(|fields| {
            fields.keys().any(|key| {
                key != "name"
                    && !((key == "endpoint" || key == "model") && deployed_backend(method.backend))
            })
        }) {
            return Err(GatewayError::invalid(
                "Unknown account configuration field",
                None,
            ));
        }
        if params.contains_key("projectPath") {
            // Contextual repair updates only the exact native credential owner.
            // Creating and editing account configuration remains a global form.
            if !params.contains_key("bindingId") || method.flow != "secret" {
                return Err(GatewayError::policy(
                    "Add accounts in global provider settings",
                    None,
                ));
            }
            let context = self.account_config(params).await?;
            let target = resolve_target(&context.config, params)?;
            if target.auth_profile.provider != method.provider
                || target.auth_profile.auth_method != method.auth
                || target.backend.backend_kind != method.backend
                || !credential_source_uses_persisted_store(&target.auth_profile.source)
            {
                return Err(GatewayError::policy(
                    "This account cannot be updated with the selected method",
                    None,
                ));
            }
            if fields
                .and_then(|fields| fields.get("endpoint"))
                .and_then(Value::as_str)
                .is_some_and(|endpoint| Some(endpoint) != target.backend.base_url.as_deref())
            {
                return Err(GatewayError::policy(
                    "Edit the endpoint in global provider settings",
                    None,
                ));
            }
            if fields
                .and_then(|fields| fields.get("model"))
                .and_then(Value::as_str)
                .is_some_and(|model| Some(model) != target.binding.default_model.as_deref())
            {
                return Err(GatewayError::policy(
                    "Edit the deployment in global provider settings",
                    None,
                ));
            }
            self.save_direct_secret(
                &target,
                secret.ok_or_else(|| GatewayError::invalid("Enter a credential", None))?,
            )
            .await?;
            return Ok(json!({"connection":self.account_status(&context, &target).await?}));
        }
        let endpoint = if deployed_backend(method.backend)
            && (!params.contains_key("bindingId")
                || fields.is_some_and(|fields| fields.contains_key("endpoint")))
        {
            let value = fields
                .and_then(|fields| fields.get("endpoint"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| GatewayError::invalid("Enter the endpoint URL", None))?;
            let parsed = reqwest::Url::parse(value)
                .map_err(|_| GatewayError::invalid("Enter a valid HTTPS endpoint URL", None))?;
            if parsed.scheme() != "https"
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.query().is_some()
                || parsed.fragment().is_some()
            {
                return Err(GatewayError::invalid(
                    "Enter a valid HTTPS endpoint URL without credentials or query parameters",
                    None,
                ));
            }
            Some(value.to_string())
        } else {
            method.endpoint.map(str::to_string)
        };
        let runtime = self.global_runtime();
        let snapshot = runtime.get().await.map_err(native_error)?;
        let mut config = snapshot.config.clone();
        let existing = params
            .contains_key("bindingId")
            .then(|| resolve_target(&config, params))
            .transpose()?;
        let deployment = if deployed_backend(method.backend) {
            fields
                .and_then(|fields| fields.get("model"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|model| !model.is_empty())
                .map(str::to_string)
                .or_else(|| {
                    existing
                        .as_ref()
                        .and_then(|target| target.binding.default_model.clone())
                })
        } else {
            None
        };
        if deployed_backend(method.backend) && existing.is_none() && deployment.is_none() {
            return Err(GatewayError::invalid("Enter the deployed model name", None));
        }
        if deployment
            .as_ref()
            .is_some_and(|model| model.len() > 256 || model.chars().any(char::is_control))
        {
            return Err(GatewayError::invalid("Enter a valid deployment name", None));
        }
        if let Some(target) = &existing {
            if target.auth_binding.realm != RealmId::global()
                || target.auth_profile.provider != method.provider
                || target.auth_profile.auth_method != method.auth
                || target.backend.backend_kind != method.backend
                || !credential_source_uses_persisted_store(&target.auth_profile.source)
            {
                return Err(GatewayError::policy(
                    "This account cannot be updated with the selected method",
                    None,
                ));
            }
            if let Some(endpoint) = &endpoint {
                if deployed_backend(method.backend) {
                    let section = config.realm.get_mut("global").ok_or_else(|| {
                        GatewayError::not_found("Account configuration not found", None)
                    })?;
                    let backend_id = &section
                        .binding
                        .get(target.auth_binding.binding.as_str())
                        .ok_or_else(|| GatewayError::not_found("Account binding not found", None))?
                        .backend_profile;
                    section
                        .backend
                        .get_mut(backend_id)
                        .ok_or_else(|| GatewayError::not_found("Account endpoint not found", None))?
                        .base_url = Some(endpoint.clone());
                }
            }
            if deployed_backend(method.backend) {
                config
                    .realm
                    .get_mut("global")
                    .and_then(|section| {
                        section
                            .binding
                            .get_mut(target.auth_binding.binding.as_str())
                    })
                    .ok_or_else(|| GatewayError::not_found("Account binding not found", None))?
                    .default_model = deployment.clone();
            }
        }
        let suffix = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        let primary_id = existing
            .as_ref()
            .map(|target| target.auth_binding.binding.to_string())
            .unwrap_or_else(|| format!("{}_{}", method.id.replace('-', "_"), suffix));
        if existing.is_none() {
            let name = fields
                .and_then(|fields| fields.get("name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(method.name);
            let name = name.split_whitespace().collect::<Vec<_>>().join("-");
            ProfileId::parse(&name).map_err(|_| GatewayError::invalid("Use letters, numbers, spaces, hyphens, underscores or dots in the account name", None))?;
            if name.len() > 80 {
                return Err(GatewayError::invalid(
                    "Keep the account name under 80 characters",
                    None,
                ));
            }
            let routes = if method.flow == "device" {
                vec![Provider::OpenAI, Provider::Anthropic, Provider::Gemini]
            } else {
                vec![method.provider]
            };
            let account = (method.flow == "device").then(|| format!("github_copilot_{suffix}"));
            for (index, provider) in routes.into_iter().enumerate() {
                let id = if index == 0 {
                    primary_id.clone()
                } else {
                    format!("{primary_id}_{}", provider.as_str())
                };
                let section = config.realm.entry("global".into()).or_default();
                let profile_base = if index == 0 {
                    name.clone()
                } else {
                    format!("{}-{}", name, provider.as_str())
                };
                let mut profile_id = profile_base.clone();
                let mut profile_number = 2;
                while section.auth.contains_key(&profile_id) {
                    profile_id = format!("{profile_base}-{profile_number}");
                    profile_number += 1;
                }
                let already_default = section.binding.values().any(|binding| {
                    binding.provider_default
                        && section
                            .backend
                            .get(&binding.backend_profile)
                            .is_some_and(|backend| backend.provider == provider.as_str())
                });
                section.backend.insert(
                    id.clone(),
                    meerkat_core::BackendProfileConfig {
                        provider: provider.as_str().into(),
                        backend_kind: method.backend.into(),
                        base_url: endpoint.clone(),
                        options: Value::Null,
                        server: None,
                    },
                );
                section.auth.insert(
                    profile_id.clone(),
                    meerkat_core::AuthProfileConfig {
                        provider: provider.as_str().into(),
                        auth_method: method.auth.into(),
                        source: CredentialSourceSpec::ManagedStore,
                        constraints: meerkat_core::AuthConstraints {
                            allow_interactive_login: method.flow != "secret",
                            ..Default::default()
                        },
                        metadata_defaults: Default::default(),
                    },
                );
                section.binding.insert(
                    id.clone(),
                    meerkat_core::ProviderBindingConfig {
                        backend_profile: id.clone(),
                        auth_profile: profile_id,
                        credential_account: account
                            .as_deref()
                            .map(meerkat_core::CredentialAccountId::parse)
                            .transpose()
                            .map_err(native_error)?,
                        default_model: deployment.clone(),
                        policy: Default::default(),
                        provider_default: !already_default,
                    },
                );
            }
            config
                .validate(meerkat_models::canonical())
                .map_err(native_error)?;
        }
        let target = meerkat_core::resolve_explicit_auth_binding_target(
            &config,
            &AuthBindingRef {
                realm: RealmId::global(),
                binding: BindingId::parse(&primary_id).map_err(native_error)?,
                profile: None,
                origin: BindingOrigin::Configured,
            },
        )
        .map_err(native_error)?;
        meerkat_providers::ProviderRuntimeCatalog::validate_binding_with_credential_identity(
            &target.auth_binding,
            target.credential_identity.clone(),
            &target.backend,
            &target.auth_profile,
            &target.binding.policy,
        )
        .map_err(native_error)?;
        if existing.is_none() || deployed_backend(method.backend) {
            let delta = json!({"realm":{"global":config.realm.get("global")}});
            runtime
                .patch(ConfigDelta(delta), Some(snapshot.generation))
                .await
                .map_err(native_error)?;
        }
        let activation = if let Some(secret) = secret {
            self.save_direct_secret(&target, secret).await?;
            Some(self.activate_connected_account_unlocked(&target).await)
        } else {
            None
        };
        // Activation may have changed the default. Report the committed view.
        let projection = async {
            let context = self.account_config(&Map::new()).await?;
            self.account_status(&context, &target).await
        }.await;
        let connection = match projection {
            Ok(connection) => connection,
            Err(_) if activation.is_some() => json!({
                "provider":target.auth_profile.provider.as_str(),
                "displayName":provider_display_name(target.auth_profile.provider),
                "realmId":target.auth_binding.realm, "bindingId":target.auth_binding.binding,
                "profileId":target.auth_profile.id, "source":target.auth_profile.source.kind_label(),
                "authMethod":target.auth_profile.auth_method, "backendKind":target.backend.backend_kind,
                "accountLabel":target.auth_profile.id.replace(['-', '_'], " "),
                "state":"unknown", "supportsInteractiveLogin":false,
                "models":[], "modelsVerified":false,
            }),
            Err(error) => return Err(error),
        };
        let mut result = json!({"connection":connection});
        if let Some(activation) = activation {
            result["defaultActivation"] = activation;
            result["credentialsSaved"] = json!(true);
        }
        Ok(result)
    }

    async fn save_direct_secret(
        &self,
        target: &ResolvedConnectionTarget,
        secret: String,
    ) -> Result<(), GatewayError> {
        let auth_mode =
            meerkat_providers::NormalizedAuthMethod::from_auth_profile(&target.auth_profile)
                .and_then(meerkat_providers::NormalizedAuthMethod::persisted_auth_mode)
                .filter(|mode| meerkat_core::persisted_auth_mode_is_directly_creatable(*mode))
                .ok_or_else(|| {
                    GatewayError::invalid("The selected account cannot store a direct secret", None)
                })?;
        meerkat_providers::browser_login::save_tokens_and_publish_lifecycle(
            self.persistence()?,
            self.authority.generated_auth_lease_handle(),
            target.credential_identity.clone(),
            PersistedTokens {
                auth_mode,
                primary_secret: Some(secret),
                refresh_token: None,
                id_token: None,
                expires_at: None,
                last_refresh: Some(Utc::now()),
                scopes: vec![],
                account_id: None,
                metadata: Value::Null,
            },
        )
        .await
        .map_err(native_error)?;
        Ok(())
    }

    pub(super) async fn account_login_start(
        &self,
        params: &Map<String, Value>,
    ) -> Result<Value, GatewayError> {
        let context = self.account_config(params).await?;
        let target = resolve_target(&context.config, params)?;
        let redirect = required_string(params, "redirectUri")?;
        require_loopback_redirect(&redirect)?;
        let login = self
            .host_service()?
            .login_start(&context.config, &oauth_target(&target)?, redirect)
            .await
            .map_err(native_error)?;
        Ok(
            json!({"provider":target.auth_profile.provider.as_str(), "authorizeUrl":login.authorize_url, "state":login.state, "redirectUri":login.redirect_uri, "realmId":target.auth_binding.realm, "bindingId":target.auth_binding.binding, "profileId":target.auth_profile.id}),
        )
    }

    pub(super) async fn account_login_complete(
        &self,
        params: &Map<String, Value>,
    ) -> Result<Value, GatewayError> {
        let context = self.account_config(params).await?;
        let target = resolve_target(&context.config, params)?;
        let redirect = required_string(params, "redirectUri")?;
        require_loopback_redirect(&redirect)?;
        let result = self
            .host_service()?
            .login_complete(
                &context.config,
                &oauth_target(&target)?,
                redirect,
                required_string(params, "state")?,
                required_string(params, "code")?,
            )
            .await
            .map_err(native_error)?;
        let activation = self.activate_connected_account(&target).await;
        self.refresh_copilot_account(&target).await;
        Ok(json!({"state":"connected", "realmId":result.auth_binding.realm, "bindingId":result.auth_binding.binding, "profileId":result.profile_id, "expiresAt":result.expires_at.map(|value| value.to_rfc3339()), "defaultActivation":activation}))
    }

    pub async fn device_start(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let _mutation = self.account_mutations.lock().await;
        let params = object_params(params)?;
        let context = self.account_config(params).await?;
        let target = resolve_target(&context.config, params)?;
        let result = self
            .host_service()?
            .device_start(&context.config, &oauth_target(&target)?)
            .await
            .map_err(native_error)?;
        Ok(
            json!({"deviceCode":result.device_code, "userCode":result.user_code, "verificationUri":result.verification_uri, "verificationUriComplete":result.verification_uri_complete, "expiresIn":result.expires_in, "interval":result.interval}),
        )
    }

    pub async fn device_poll(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let context = self.account_config(params).await?;
        let target = resolve_target(&context.config, params)?;
        let result = self
            .host_service()?
            .device_poll(
                &context.config,
                &oauth_target(&target)?,
                &required_string(params, "deviceCode")?,
            )
            .await
            .map_err(native_error)?;
        Ok(match result {
            meerkat::HostAuthDevicePoll::Pending => json!({"status":"waiting"}),
            meerkat::HostAuthDevicePoll::SlowDown => {
                json!({"status":"waiting", "retryAfterSeconds":10})
            }
            meerkat::HostAuthDevicePoll::Ready(_) => {
                let activation = self.activate_connected_account(&target).await;
                self.refresh_copilot_account(&target).await;
                json!({"status":"connected", "defaultActivation":activation})
            },
            meerkat::HostAuthDevicePoll::AccessDenied => {
                json!({"status":"failed", "message":"Sign-in was declined."})
            }
            meerkat::HostAuthDevicePoll::Expired => {
                json!({"status":"failed", "message":"This sign-in code expired. Start again."})
            }
        })
    }

    async fn activate_connected_account(&self, target: &ResolvedConnectionTarget) -> Value {
        // Do not hold this lock across OAuth exchange: logout must remain able
        // to revoke an in-flight exchange through the native lifecycle fence.
        let _mutation = self.account_mutations.lock().await;
        self.activate_connected_account_unlocked(target).await
    }

    async fn activate_connected_account_unlocked(&self, target: &ResolvedConnectionTarget) -> Value {
        match self.try_activate_connected_account(target).await {
            Ok(providers) => json!({
                "status":if providers.is_empty() {"unchanged"} else {"updated"},
                "providers":providers,
            }),
            // Credential publication already succeeded. A failed read or CAS
            // must not misreport sign-in failure or overwrite a newer choice.
            Err(_) => json!({"status":"needs_selection", "providers":[]}),
        }
    }

    async fn try_activate_connected_account(
        &self,
        original: &ResolvedConnectionTarget,
    ) -> Result<Vec<String>, GatewayError> {
        let binding = &original.auth_binding;
        if binding.realm != RealmId::global() {
            return Ok(vec![]);
        }
        let runtime = self.global_runtime();
        let snapshot = runtime.get().await.map_err(native_error)?;
        let target = meerkat_core::resolve_explicit_auth_binding_target(&snapshot.config, binding)
            .map_err(native_error)?;
        if target.auth_profile != original.auth_profile || target.backend != original.backend
            || target.credential_identity != original.credential_identity
        {
            return Err(GatewayError::policy("The account changed after sign-in", None));
        }
        let section = snapshot.config.realm.get("global")
            .ok_or_else(|| GatewayError::not_found("Account configuration not found", None))?;
        let mut routes = BTreeMap::<Provider, Vec<ResolvedConnectionTarget>>::new();
        for id in section.binding.keys() {
            let route = meerkat_core::resolve_explicit_auth_binding_target(&snapshot.config, &AuthBindingRef {
                realm: RealmId::global(), binding: BindingId::parse(id).map_err(native_error)?,
                profile: None, origin: BindingOrigin::Configured,
            }).map_err(native_error)?;
            if route.credential_identity == target.credential_identity {
                routes.entry(route.auth_profile.provider).or_default().push(route);
            }
        }
        let mut selections = Vec::new();
        for (provider, routes) in routes {
            // External configuration can alias one account more than once in
            // a family. Do not invent which of those routes the user intended.
            let [route] = routes.as_slice() else { continue };
            if self.account_credential_status(&snapshot.config, route).await?["state"] != "connected" {
                continue;
            }
            let current = resolve_realm_binding_target_for_provider(
                &snapshot.config, provider, None, None, None, Some(&RealmId::global()), true,
            );
            let replace = match current {
                Ok(current) if current.credential_identity == target.credential_identity => false,
                Ok(current) => matches!(
                    self.account_credential_status(&snapshot.config, &current).await?["state"].as_str(),
                    Some("needs_auth" | "reauth_required")
                ),
                Err(meerkat_core::ConnectionTargetError::MissingRealm
                    | meerkat_core::ConnectionTargetError::MissingDefaultBinding { .. }) => true,
                Err(error) => return Err(native_error(error)),
            };
            if replace {
                selections.push((provider, route.auth_binding.binding.clone()));
            }
        }
        if !selections.is_empty() {
            runtime.patch(default_selection_delta(section, &selections), Some(snapshot.generation))
                .await.map_err(native_error)?;
        }
        Ok(selections.into_iter().map(|(provider, _)| provider.as_str().to_string()).collect())
    }

    pub(super) async fn account_clear(
        &self,
        params: &Map<String, Value>,
    ) -> Result<Value, GatewayError> {
        let context = self.account_config(params).await?;
        let target = resolve_target(&context.config, params)?;
        meerkat_core::connection::resolve_write_owner(
            &context.config,
            &target.auth_binding.realm,
            &target.auth_binding.binding,
        )
        .map_err(native_error)?;
        if !credential_source_uses_persisted_store(&target.auth_profile.source) {
            return Err(GatewayError::policy(
                "These credentials are managed outside the app",
                None,
            ));
        }
        self.clear_tokens(
            target.credential_identity.clone(),
            target.auth_profile.provider.as_str(),
        )
        .await?;
        self.copilot_accounts
            .resolved
            .lock()
            .await
            .remove(&target.credential_identity);
        Ok(json!({"cleared":true, "state":"needs_auth"}))
    }

    pub async fn delete_account(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let _mutation = self.account_mutations.lock().await;
        let params = object_params(params)?;
        if params.contains_key("projectPath") {
            return Err(GatewayError::policy(
                "Remove accounts in global provider settings",
                None,
            ));
        }
        let runtime = self.global_runtime();
        let snapshot = runtime.get().await.map_err(native_error)?;
        let target = resolve_target(&snapshot.config, params)?;
        let removal = account_removal(&snapshot.config, &target)?;
        self.clear_tokens(
            target.credential_identity.clone(),
            target.auth_profile.provider.as_str(),
        )
        .await?;
        self.copilot_accounts
            .resolved
            .lock()
            .await
            .remove(&target.credential_identity);
        runtime
            .patch(removal.delta, Some(snapshot.generation))
            .await
            .map_err(|_| GatewayError::policy(
                "Credentials were removed, but account removal could not be confirmed. Refresh settings before retrying.",
                Some(json!({"credentialsCleared":true,"deletionConfirmed":false,"requiresRefresh":true})),
            ))?;
        Ok(json!({"deleted":true,"cleared":true,"removedBindings":removal.bindings}))
    }

    pub async fn set_default(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let _mutation = self.account_mutations.lock().await;
        let params = object_params(params)?;
        let runtime = self.global_runtime();
        let snapshot = runtime.get().await.map_err(native_error)?;
        let target = resolve_target(&snapshot.config, params)?;
        if target.auth_binding.realm != RealmId::global() {
            return Err(GatewayError::policy(
                "Set the default from global provider settings",
                None,
            ));
        }
        let section = snapshot
            .config
            .realm
            .get("global")
            .ok_or_else(|| GatewayError::not_found("Account configuration not found", None))?;
        runtime
            .patch(
                default_selection_delta(section, &[(target.auth_profile.provider, target.auth_binding.binding)]),
                Some(snapshot.generation),
            )
            .await
            .map_err(native_error)?;
        Ok(json!({"updated":true}))
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod removal_tests;

#[cfg(test)]
mod activation_tests;
