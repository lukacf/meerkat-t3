//! Skill discovery uses the same native factory and effective realm configuration as agents.
use meerkat::{AgentFactory, SkillFilter};
use meerkat_core::skills::{SkillKey, SkillRef};
use meerkat_mob::MemberTurnOptions;
use serde_json::{Map, Value, json};

use crate::{GatewayError, derive_project_locator, object_params, optional_string, required_string};
use crate::mobkit_registry::load_effective_realm_config;

/// The public contract carries native keys only. Rendered bodies remain owned
/// by the target agent's native skill runtime.
pub(crate) fn references(params: &Map<String, Value>) -> Result<Vec<SkillKey>, GatewayError> {
    let Some(value) = params.get("skillReferences") else {
        return Ok(Vec::new());
    };
    let references: Vec<SkillKey> = serde_json::from_value(value.clone()).map_err(|error| {
        GatewayError::invalid(
            "skillReferences must contain native source_uuid and skill_name keys",
            Some(json!({"error": error.to_string()})),
        )
    })?;
    let unique = references.iter().collect::<std::collections::BTreeSet<_>>();
    if unique.len() != references.len() {
        return Err(GatewayError::invalid("skillReferences must not contain duplicate keys", None));
    }
    Ok(references)
}

pub(crate) fn validate_handling(
    references: &[SkillKey],
    steering: bool,
) -> Result<(), GatewayError> {
    if steering && !references.is_empty() {
        return Err(GatewayError::invalid(
            "Skills cannot be activated while steering. Send the selected skills with a new message.",
            Some(json!({"kind": "skill_activation_unsupported", "handlingMode": "steer"})),
        ));
    }
    Ok(())
}

pub(crate) fn console_references(references: Vec<SkillKey>) -> Vec<SkillRef> {
    // Preserve source identity and selection order in MobKit's typed carrier.
    // Its admission fingerprint owns replay compatibility; the target agent
    // owns resolution, capability checks, context blocks, and failure events.
    references.into_iter().map(SkillRef::from).collect()
}

pub(crate) fn validate_enabled(
    config: &meerkat::Config,
    references: &[SkillKey],
) -> Result<(), GatewayError> {
    if !references.is_empty() && !config.skills.enabled {
        return Err(GatewayError::policy(
            "Skills are disabled for this workspace. Enable them or remove the skill selection to send this message.",
            Some(json!({"kind": "skills_disabled", "skillReferences": references})),
        ));
    }
    Ok(())
}

pub(crate) fn turn_options(
    options: MemberTurnOptions,
    config: &meerkat::Config,
    references: Vec<SkillKey>,
) -> Result<MemberTurnOptions, GatewayError> {
    validate_enabled(config, &references)?;
    if references.is_empty() {
        return Ok(options);
    }
    // Native turn activation owns key resolution, capability checks, rendered
    // bodies and events. If an agent was built without a skill engine, native
    // activation emits the typed NoSkillEngine failure before a provider call.
    Ok(options.with_skill_references(references))
}

pub(crate) async fn list(params: Option<&Value>) -> Result<Value, GatewayError> {
    let params = object_params(params)?;
    let project = required_string(params, "projectPath")?;
    let state_root = optional_string(params, "configStateRoot");
    let locator = derive_project_locator(&project, state_root.as_deref())?;
    let realm = load_effective_realm_config(&locator.project_path, &locator.state_root)
        .await.map_err(|error| GatewayError::policy(error, None))?;
    let factory = AgentFactory::new(&locator.state_root)
        .runtime_root(locator.state_root.clone())
        .project_root(locator.project_path.clone())
        .context_root(locator.project_path.clone())
        .builtins(true).shell(true).mob(true).comms(true).memory(true).schedule(true).workgraph(true);
    let skills = discover(&factory, &realm.effective).await?;
    Ok(json!({"skills": skills, "enabled": realm.effective.skills.enabled}))
}

async fn discover(factory: &AgentFactory, config: &meerkat::Config) -> Result<Vec<Value>, GatewayError> {
    let runtime = factory.build_skill_runtime(config).await
        .map_err(|error| GatewayError::policy(format!("Could not discover configured skills: {error}"), None))?;
    let Some(runtime) = runtime else { return Ok(vec![]); };
    let skills = runtime.list_skills(&SkillFilter::default()).await
        .map_err(|error| GatewayError::policy(format!("Could not list configured skills: {error}"), None))?;
    Ok(skills.into_iter().map(|skill| json!({
        "key": skill.key,
        "name": skill.name,
        "description": skill.description,
        "scope": skill.scope,
        "sourceName": skill.source_name,
    })).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selected_keys() -> Vec<SkillKey> {
        let params = json!({"skillReferences": [
            {"source_uuid": "b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64", "skill_name": "review"},
            {"source_uuid": "032dab6f-3c76-4071-bca2-6d705623d294", "skill_name": "review"}
        ]});
        references(params.as_object().unwrap()).unwrap()
    }

    #[test]
    fn transports_exact_native_source_keys_without_replacing_other_turn_options() {
        let keys = selected_keys();
        let options = MemberTurnOptions::new().with_self_hosted_server_id("local-proof");
        let options = turn_options(options, &meerkat::Config::default(), keys.clone()).unwrap();
        assert_eq!(options.skill_references.as_ref(), Some(&keys));
        assert_eq!(options.self_hosted_server_id.as_deref(), Some("local-proof"));
        assert_ne!(keys[0].source_uuid, keys[1].source_uuid);
        assert_eq!(keys[0].skill_name, keys[1].skill_name);
    }

    #[test]
    fn disabled_config_rejects_selections_but_preserves_ordinary_turns() {
        let mut config = meerkat::Config::default();
        config.skills.enabled = false;
        let error = turn_options(MemberTurnOptions::new(), &config, selected_keys()).unwrap_err();
        let GatewayError::Api { typed_code, details, .. } = error;
        assert_eq!(typed_code, "POLICY_ERROR");
        assert_eq!(details.unwrap()["kind"], "skills_disabled");
        let options = turn_options(MemberTurnOptions::new(), &config, vec![]).unwrap();
        assert!(options.skill_references.is_none());
    }

    #[test]
    fn selection_validation_uses_current_config_and_preserves_native_keys() {
        let keys = selected_keys();
        let mut config = meerkat::Config::default();
        config.skills.enabled = true;
        assert!(validate_enabled(&config, &keys).is_ok());
        config.skills.enabled = false;
        let GatewayError::Api { typed_code, details, .. } =
            validate_enabled(&config, &keys).unwrap_err();
        assert_eq!(typed_code, "POLICY_ERROR");
        assert_eq!(details.unwrap(), json!({
            "kind": "skills_disabled", "skillReferences": keys,
        }));
        assert!(validate_enabled(&config, &[]).is_ok());
    }

    #[test]
    fn malformed_and_duplicate_native_keys_are_rejected() {
        for skill in [
            json!({"source_uuid": "not-a-uuid", "skill_name": "review"}),
            json!({"source_uuid": "b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64", "skill_name": "../review"}),
            json!({"source_uuid": "b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64"}),
        ] {
            let params = json!({"skillReferences": [skill]});
            assert!(references(params.as_object().unwrap()).is_err());
        }
        let key = &selected_keys()[0];
        let params = json!({"skillReferences": [key, key]});
        assert!(references(params.as_object().unwrap()).is_err());
        assert!(references(json!({}).as_object().unwrap()).unwrap().is_empty());
    }

    #[test]
    fn selected_skills_cannot_use_steering_without_native_metadata_support() {
        let keys = selected_keys();
        assert!(validate_handling(&keys, true).is_err());
        assert!(validate_handling(&keys, false).is_ok());
        assert!(validate_handling(&[], true).is_ok());
    }

    #[test]
    fn console_selection_preserves_source_pinned_keys_and_legacy_empty_shape() {
        let keys = selected_keys();
        let mut request = meerkat_mobkit::ConsoleSendRequest {
            identity: "specialist".into(),
            content: json!("Review this change."),
            origin: "meerkat-app".into(),
            origin_kind: None,
            idempotency_key: "selected-skill-proof".into(),
            handling_mode: Some("queue".into()),
            skill_refs: console_references(keys.clone()),
        };
        assert_eq!(request.selected_skill_keys(), keys);
        let selected = serde_json::to_value(&request).unwrap();
        assert_eq!(selected["content"], "Review this change.");
        assert_eq!(selected["skill_refs"][0], json!({
            "kind": "structured",
            "source_uuid": keys[0].source_uuid,
            "skill_name": keys[0].skill_name,
        }));
        assert_eq!(selected["skill_refs"][1], json!({
            "kind": "structured",
            "source_uuid": keys[1].source_uuid,
            "skill_name": keys[1].skill_name,
        }));

        request.skill_refs = console_references(vec![]);
        assert!(request.selected_skill_keys().is_empty());
        let ordinary = serde_json::to_value(request).unwrap();
        assert!(ordinary.get("skill_refs").is_none());
        assert!(ordinary.get("origin_kind").is_none());
        assert_eq!(ordinary["content"], selected["content"]);
        assert_eq!(ordinary["idempotency_key"], selected["idempotency_key"]);
    }

    #[tokio::test]
    async fn discovers_configured_filesystem_skills_and_respects_disable() {
        let root = std::env::temp_dir().join(format!("meerkat-skills-{}", uuid::Uuid::new_v4()));
        let source = root.join("skills");
        std::fs::create_dir_all(source.join("local-proof")).unwrap();
        std::fs::write(source.join("local-proof/SKILL.md"), "---\nname: local-proof\ndescription: Configured native skill\n---\nUse the repository conventions.\n").unwrap();
        let mut config = meerkat::Config::default();
        config.skills.repositories = vec![serde_json::from_value(json!({
            "name": "test-source", "source_uuid": "b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64",
            "type": "filesystem", "path": source,
        })).unwrap()];
        let factory = AgentFactory::new(root.join("state")).project_root(root.clone()).context_root(root.clone()).builtins(true);
        let skills = discover(&factory, &config).await.unwrap();
        let proof = skills.iter().find(|skill| skill["name"] == "local-proof").expect("configured skill");
        assert_eq!(proof["key"]["source_uuid"], "b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64");
        assert_eq!(proof["description"], "Configured native skill");
        config.skills.enabled = false;
        assert!(discover(&factory, &config).await.unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
