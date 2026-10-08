use super::*;
use meerkat_core::lifecycle::run_primitive::{
    AnthropicEffort, AnthropicProviderTag, GeminiProviderTag, GeminiThinkingConfig,
    GeminiThinkingLevel, OpaqueProviderBody, OpenAiProviderTag, ReasoningEffort, ReasoningMode,
    StructuredProviderExtension,
};

fn identity(provider: Provider, tag: Option<ProviderTag>) -> SessionLlmIdentity {
    SessionLlmIdentity {
        model: "observed-model".into(),
        provider,
        self_hosted_server_id: None,
        provider_params: Some(ProviderParamsOverride {
            provider_tag: tag,
            ..Default::default()
        }),
        auth_binding: None,
    }
}

#[test]
fn observed_defaults_do_not_expose_cache_or_sampling_controls() {
    let mut current = identity(Provider::OpenAI, None);
    current.provider_params = None;
    assert_eq!(project(&current)["reasoning"], json!({"kind":"default"}));
    current.provider_params = Some(ProviderParamsOverride {
        temperature: Some(0.2),
        provider_tag: Some(ProviderTag::OpenAi(OpenAiProviderTag {
            prompt_cache_enabled: Some(false),
            ..Default::default()
        })),
        ..Default::default()
    });
    assert_eq!(
        Value::Object(project(&current)),
        json!({
            "model":"observed-model", "modelProvider":"openai", "reasoning":{"kind":"default"}
        })
    );
}

#[test]
fn all_explicit_openai_levels_include_none_without_becoming_default() {
    for effort in [
        ReasoningEffort::None,
        ReasoningEffort::Low,
        ReasoningEffort::Medium,
        ReasoningEffort::High,
        ReasoningEffort::XHigh,
        ReasoningEffort::Max,
    ] {
        let current = identity(
            Provider::OpenAI,
            Some(ProviderTag::OpenAi(OpenAiProviderTag {
                reasoning_effort: Some(effort),
                ..Default::default()
            })),
        );
        assert_eq!(
            project(&current)["reasoning"],
            json!({"kind":"configured", "values":[
                {"parameter":"reasoning_effort", "value":effort.as_legacy_str()}
            ]})
        );
    }
}

#[test]
fn anthropic_keeps_independent_effort_and_thinking_including_nonpreset_values() {
    for (thinking, expected) in [
        (AnthropicThinkingConfig::Adaptive, "adaptive"),
        (
            AnthropicThinkingConfig::Enabled {
                budget_tokens: 4500,
            },
            "4500",
        ),
        (AnthropicThinkingConfig::BetweenTools, "between_tools"),
    ] {
        let current = identity(
            Provider::Anthropic,
            Some(ProviderTag::Anthropic(AnthropicProviderTag {
                effort: Some(AnthropicEffort::High),
                thinking: Some(thinking),
                ..Default::default()
            })),
        );
        assert_eq!(
            project(&current)["reasoning"],
            json!({"kind":"configured", "values":[
                {"parameter":"effort", "value":"high"},
                {"parameter":"thinking", "value":expected}
            ]})
        );
    }
}

#[test]
fn gemini_preserves_zero_budget_and_does_not_guess_conflicting_backend_policy() {
    let current = identity(
        Provider::Gemini,
        Some(ProviderTag::Gemini(GeminiProviderTag {
            thinking_budget: Some(0),
            ..Default::default()
        })),
    );
    assert_eq!(
        project(&current)["reasoning"],
        json!({"kind":"configured", "values":[
            {"parameter":"thinking_budget", "value":"0"}
        ]})
    );
    let nested = GeminiThinkingConfig {
        thinking_level: Some(GeminiThinkingLevel::High),
        ..Default::default()
    };
    let current = identity(
        Provider::Gemini,
        Some(ProviderTag::Gemini(GeminiProviderTag {
            thinking: Some(nested.clone()),
            thinking_level: Some(GeminiThinkingLevel::High),
            ..Default::default()
        })),
    );
    assert_eq!(
        project(&current)["reasoning"],
        json!({"kind":"configured", "values":[
            {"parameter":"thinking_level", "value":"high"}
        ]})
    );
    // Both pinned Gemini paths fall back per field, including an empty nested
    // object. Do not mistake its presence for an override of the flat level.
    let partial = identity(
        Provider::Gemini,
        Some(ProviderTag::Gemini(GeminiProviderTag {
            thinking: Some(GeminiThinkingConfig::default()),
            thinking_level: Some(GeminiThinkingLevel::High),
            ..Default::default()
        })),
    );
    assert_eq!(
        project(&partial)["reasoning"],
        json!({"kind":"configured", "values":[
            {"parameter":"thinking_level", "value":"high"}
        ]})
    );
    for tag in [
        GeminiProviderTag {
            thinking: Some(nested),
            thinking_level: Some(GeminiThinkingLevel::Low),
            ..Default::default()
        },
        GeminiProviderTag {
            thinking_level: Some(GeminiThinkingLevel::High),
            thinking_budget: Some(2048),
            ..Default::default()
        },
        GeminiProviderTag {
            thinking: Some(GeminiThinkingConfig {
                thinking_budget: Some(2048),
                ..Default::default()
            }),
            thinking_level: Some(GeminiThinkingLevel::High),
            ..Default::default()
        },
    ] {
        assert_eq!(
            project(&identity(Provider::Gemini, Some(ProviderTag::Gemini(tag))))["reasoning"],
            json!({"kind":"unknown"})
        );
    }
}

#[test]
fn unrepresented_or_mismatched_overrides_are_unknown_not_model_default() {
    let mismatch = identity(
        Provider::Anthropic,
        Some(ProviderTag::OpenAi(OpenAiProviderTag {
            reasoning_effort: Some(ReasoningEffort::High),
            ..Default::default()
        })),
    );
    assert_eq!(project(&mismatch)["reasoning"], json!({"kind":"unknown"}));
    let opaque = identity(
        Provider::OpenAI,
        Some(ProviderTag::OpenAi(OpenAiProviderTag {
            reasoning: Some(OpaqueProviderBody::from_value(
                &json!({"vendor_mode":"custom"}),
            )),
            ..Default::default()
        })),
    );
    assert_eq!(project(&opaque)["reasoning"], json!({"kind":"unknown"}));
    let disabled_payload = identity(
        Provider::OpenAI,
        Some(ProviderTag::OpenAi(OpenAiProviderTag {
            reasoning_effort: Some(ReasoningEffort::High),
            supports_reasoning_override: Some(false),
            ..Default::default()
        })),
    );
    assert_eq!(
        project(&disabled_payload)["reasoning"],
        json!({"kind":"unknown"})
    );
    let unknown = identity(
        Provider::OpenAI,
        Some(ProviderTag::Unknown {
            bag: StructuredProviderExtension {
                namespace: "legacy".into(),
                key: "reasoning".into(),
                body: "high".into(),
            },
        }),
    );
    assert_eq!(project(&unknown)["reasoning"], json!({"kind":"unknown"}));
    for params in [
        ProviderParamsOverride {
            reasoning: Some(ReasoningMode::Off),
            ..Default::default()
        },
        ProviderParamsOverride {
            thinking_budget_tokens: Some(2048),
            ..Default::default()
        },
    ] {
        let mut current = identity(Provider::OpenAI, None);
        current.provider_params = Some(params);
        assert_eq!(project(&current)["reasoning"], json!({"kind":"unknown"}));
    }
}
