use meerkat_core::lifecycle::run_primitive::{
    AnthropicThinkingConfig, ProviderParamsOverride, ProviderTag,
};
use meerkat_core::{Provider, SessionLlmIdentity};
use serde::Serialize;
use serde_json::{json, Map, Value};

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Parameter {
    ReasoningEffort,
    Effort,
    ThinkingLevel,
    Thinking,
    ThinkingBudget,
}

#[derive(Serialize)]
struct Setting {
    parameter: Parameter,
    value: String,
}

impl Setting {
    fn new(parameter: Parameter, value: impl Into<String>) -> Self {
        Self {
            parameter,
            value: value.into(),
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Reasoning {
    Default,
    Unknown,
    Configured { values: Vec<Setting> },
}

fn reasoning(provider: Provider, params: Option<&ProviderParamsOverride>) -> Reasoning {
    let Some(params) = params else {
        return Reasoning::Default;
    };
    // These generalized/legacy controls need backend lowering. Do not turn an
    // unrepresented override into a claim that the model default is active.
    if params.reasoning.is_some() || params.thinking_budget_tokens.is_some() {
        return Reasoning::Unknown;
    }
    let mut values = Vec::new();
    match (provider, params.provider_tag.as_ref()) {
        (_, None) => {}
        (Provider::OpenAI, Some(ProviderTag::OpenAi(tag))) => {
            if tag.reasoning.is_some()
                || tag.thinking.is_some()
                || tag.chat_template_kwargs.is_some()
                || tag.supports_reasoning_override == Some(false)
            {
                return Reasoning::Unknown;
            }
            if let Some(effort) = tag.reasoning_effort {
                values.push(Setting::new(
                    Parameter::ReasoningEffort,
                    effort.as_legacy_str(),
                ));
            }
        }
        (Provider::Anthropic, Some(ProviderTag::Anthropic(tag))) => {
            if let Some(effort) = tag.effort {
                values.push(Setting::new(Parameter::Effort, effort.as_legacy_str()));
            }
            let thinking = match tag.thinking.as_ref() {
                Some(AnthropicThinkingConfig::Adaptive) => Some("adaptive".to_string()),
                Some(AnthropicThinkingConfig::BetweenTools) => Some("between_tools".to_string()),
                Some(AnthropicThinkingConfig::Enabled { budget_tokens }) => {
                    Some(budget_tokens.to_string())
                }
                None => tag.thinking_budget_tokens.map(|budget| budget.to_string()),
            };
            if let Some(thinking) = thinking {
                values.push(Setting::new(Parameter::Thinking, thinking));
            }
        }
        (Provider::Gemini, Some(ProviderTag::Gemini(tag))) => {
            let nested_level = tag
                .thinking
                .as_ref()
                .and_then(|thinking| thinking.thinking_level);
            let nested_budget = tag
                .thinking
                .as_ref()
                .and_then(|thinking| thinking.thinking_budget);
            if nested_level
                .zip(tag.thinking_level)
                .is_some_and(|(a, b)| a != b)
                || nested_budget
                    .zip(tag.thinking_budget)
                    .is_some_and(|(a, b)| a != b)
            {
                return Reasoning::Unknown;
            }
            let level = nested_level.or(tag.thinking_level);
            let budget = nested_budget.or(tag.thinking_budget);
            // Native Gemini backends differ in how they handle both fields.
            // This observation must not guess which backend policy wins.
            if level.is_some() && budget.is_some() {
                return Reasoning::Unknown;
            }
            if let Some(level) = level {
                values.push(Setting::new(Parameter::ThinkingLevel, level.as_str()));
            }
            if let Some(budget) = budget {
                values.push(Setting::new(Parameter::ThinkingBudget, budget.to_string()));
            }
        }
        _ => return Reasoning::Unknown,
    }
    if values.is_empty() {
        Reasoning::Default
    } else {
        Reasoning::Configured { values }
    }
}

pub(crate) fn project(identity: &SessionLlmIdentity) -> Map<String, Value> {
    // All fields come from one exact persisted session snapshot. Project-agent
    // creation settings may be obsolete after native reconfiguration.
    Map::from_iter([
        ("model".into(), json!(identity.model)),
        ("modelProvider".into(), json!(identity.provider.as_str())),
        (
            "reasoning".into(),
            json!(reasoning(
                identity.provider,
                identity.provider_params.as_ref()
            )),
        ),
    ])
}

#[cfg(test)]
mod tests;
