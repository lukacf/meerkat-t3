use crate::mobkit_registry::{
    load_effective_realm_config, ConsoleExpectedTarget, MobkitMobRuntime,
};
use crate::{member_turn_options_from_params, GatewayError};
use meerkat_runtime::{SessionLlmReconfigureRequest, SessionServiceRuntimeExt};
use serde_json::{json, Map, Value};

#[derive(Clone)]
pub(crate) struct InitialAgentLlm {
    pub(crate) provider: meerkat_core::Provider,
    pub(crate) self_hosted_server_id: Option<String>,
    pub(crate) provider_params:
        Option<meerkat_core::lifecycle::run_primitive::ProviderParamsOverride>,
}

pub(crate) fn initial_selection(
    params: &Map<String, Value>,
    config: &meerkat::Config,
) -> Result<InitialAgentLlm, GatewayError> {
    let mut params = params.clone();
    // There is no previous session identity at creation. Default means the
    // selected backend's defaults, never an inherited provider's parameters.
    params
        .entry("providerParams".to_string())
        .or_insert(Value::Null);
    let options = member_turn_options_from_params(&params, config, None)?;
    let provider = options.provider.ok_or_else(|| {
        GatewayError::invalid(
            "Initial agent parameters require an exact model selection",
            None,
        )
    })?;
    let provider_params = match options.provider_params {
        Some(meerkat_core::lifecycle::run_primitive::TurnMetadataOverride::Set(value)) => {
            Some(value)
        }
        _ => None,
    };
    Ok(InitialAgentLlm {
        provider,
        self_hosted_server_id: options.self_hosted_server_id,
        provider_params,
    })
}

#[cfg(test)]
mod initial_selection_tests {
    use super::*;

    #[test]
    fn creation_validates_the_exact_model_and_reasoning_before_bootstrap() {
        let config = meerkat::Config::default();
        let value = json!({"model":"gpt-5.6-sol", "provider":"openai",
            "providerParams":{"reasoning_effort":"high"}});
        let selected = initial_selection(value.as_object().unwrap(), &config).unwrap();
        assert_eq!(selected.provider, meerkat_core::Provider::OpenAI);
        let params = selected.provider_params.unwrap();
        let Some(meerkat_core::lifecycle::run_primitive::ProviderTag::OpenAi(tag)) =
            params.provider_tag
        else {
            panic!("expected typed OpenAI reasoning parameters");
        };
        assert_eq!(
            tag.reasoning_effort,
            Some(meerkat_core::lifecycle::run_primitive::ReasoningEffort::High)
        );
        for value in [
            json!({"model":"gpt-5.6-sol", "provider":"anthropic", "providerParams":null}),
            json!({"model":"not-in-catalog", "provider":"openai", "providerParams":null}),
            json!({"model":"gpt-5.6-sol", "provider":"openai", "providerParams":{"reasoning_effort":"impossible"}}),
            json!({"model":"gpt-5.6-sol", "provider":"openai", "providerParams":{"credential":"invalid"}}),
            json!({"model":"gpt-5.6-sol", "providerParams":"high"}),
            json!({"provider":"openai", "providerParams":null}),
        ] {
            assert!(
                initial_selection(value.as_object().unwrap(), &config).is_err(),
                "{value}"
            );
        }
    }

    #[test]
    fn creation_default_leaves_cache_and_reasoning_to_the_native_backend() {
        for value in [
            json!({"model":"gpt-5.6-sol", "provider":"openai"}),
            json!({"model":"gpt-5.6-sol", "provider":"openai", "providerParams":null}),
        ] {
            let selected =
                initial_selection(value.as_object().unwrap(), &meerkat::Config::default()).unwrap();
            assert!(selected.provider_params.is_none());
        }
    }
}

pub(crate) async fn apply(
    mob: &MobkitMobRuntime,
    expected: &ConsoleExpectedTarget,
    params: &Map<String, Value>,
) -> Result<(), GatewayError> {
    if params.get("handlingMode").and_then(Value::as_str) != Some("queue") {
        return Err(GatewayError::invalid(
            "Model changes apply to the next queued turn, not steering",
            None,
        ));
    }
    // Reconfigure is itself a native idle-only transition. Never stop ongoing
    // work or mutate a saved project charter to implement a model choice.
    if mob
        .console_target_busy(expected)
        .await
        .map_err(|error| GatewayError::conflict(error, None))?
    {
        return Err(GatewayError::conflict(
            "The agent is working. Keep this message in the local queue until it is idle",
            None,
        ));
    }
    let record = mob
        .validate_console_target(expected)
        .await
        .map_err(|error| GatewayError::conflict(error, None))?;
    let session_id: meerkat_core::SessionId = serde_json::from_value(json!(record
        .session_id
        .ok_or_else(|| GatewayError::invalid("Agent has no session", None))?))
    .map_err(|error| GatewayError::invalid(error.to_string(), None))?;
    let runtime = mob
        .session_runtime
        .as_ref()
        .ok_or_else(|| GatewayError::policy("Native model controls are unavailable", None))?;
    let project_path = params
        .get("projectPath")
        .and_then(Value::as_str)
        .ok_or_else(|| GatewayError::invalid("projectPath is required", None))?;
    let config =
        load_effective_realm_config(std::path::Path::new(project_path), &mob.config_state_root)
            .await
            .map_err(|error| GatewayError::policy(error, None))?;
    if config.realm_id.as_str() != mob.realm_id {
        return Err(GatewayError::conflict(
            "Agent model configuration changed",
            None,
        ));
    }
    // Explicit parameters also clear a previous same-provider effort setting
    // when the user chooses Default in the next-message picker.
    let mut params = params.clone();
    params
        .entry("providerParams".to_string())
        .or_insert(Value::Null);
    let options = member_turn_options_from_params(&params, &config.effective, None)?;
    runtime
        .reconfigure_session_llm_identity(
            &session_id,
            SessionLlmReconfigureRequest {
                model: options.model.map(|model| model.to_string()),
                provider: options
                    .provider
                    .map(|provider| provider.as_str().to_string()),
                self_hosted_server_id: options.self_hosted_server_id,
                provider_params: options.provider_params,
                auth_binding: options.auth_binding,
            },
        )
        .await
        .map_err(|error| {
            GatewayError::conflict(
                "The native runtime could not apply this model",
                Some(json!({"error":error.to_string()})),
            )
        })?;
    mob.validate_console_target(expected)
        .await
        .map_err(|error| GatewayError::conflict(error, None))?;
    Ok(())
}
