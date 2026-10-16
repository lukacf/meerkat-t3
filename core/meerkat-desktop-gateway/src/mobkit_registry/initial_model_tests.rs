use super::*;
use meerkat_core::lifecycle::run_primitive::{ProviderTag, ReasoningEffort, TurnMetadataOverride};
use meerkat_runtime::{SessionLlmReconfigureRequest, SessionServiceRuntimeExt};

#[derive(Default)]
struct LlmRecorder {
    requests: std::sync::Mutex<Vec<(String, Option<ProviderTag>)>>,
}

impl LlmRecorder {
    fn requests(&self) -> Vec<(String, Option<ProviderTag>)> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl meerkat::LlmClient for LlmRecorder {
    fn project_replay_messages(
        &self,
        messages: &[meerkat_core::Message],
    ) -> Result<Vec<meerkat_core::Message>, meerkat::LlmError> {
        Ok(messages.to_vec())
    }

    fn stream<'a>(
        &'a self,
        request: &'a meerkat::LlmRequest,
    ) -> std::pin::Pin<
        Box<
            dyn futures_util::Stream<Item = Result<meerkat::LlmEvent, meerkat::LlmError>>
                + Send
                + 'a,
        >,
    > {
        self.requests
            .lock()
            .unwrap()
            .push((request.model.clone(), request.provider_params.clone()));
        Box::pin(futures_util::stream::iter([
            Ok(meerkat::LlmEvent::TextDelta {
                delta: "Initial model fixture completed.".into(),
                meta: None,
            }),
            Ok(meerkat::LlmEvent::Done {
                outcome: meerkat::LlmDoneOutcome::Success {
                    stop_reason: meerkat_core::StopReason::EndTurn,
                },
            }),
        ]))
    }

    fn provider(&self) -> meerkat_core::Provider {
        meerkat_core::Provider::OpenAI
    }

    async fn health_check(&self) -> Result<(), meerkat::LlmError> {
        Ok(())
    }
}

fn assert_effort(tag: Option<&ProviderTag>, expected: ReasoningEffort) {
    let Some(ProviderTag::OpenAi(tag)) = tag else {
        panic!("expected typed OpenAI reasoning parameters");
    };
    assert_eq!(tag.reasoning_effort, Some(expected));
}

async fn assert_saved_identity(mob: &MobkitMobRuntime, model: &str, effort: ReasoningEffort) {
    let runtime = mob.runtime.as_ref().unwrap();
    let saved = member_llm_identity(runtime, "specialist")
        .await
        .unwrap()
        .expect("the first native build must persist its LLM identity");
    assert_eq!(saved.model, model);
    assert_eq!(saved.provider, meerkat_core::Provider::OpenAI);
    assert_eq!(saved.self_hosted_server_id, None);
    assert_effort(
        saved
            .provider_params
            .as_ref()
            .and_then(|params| params.provider_tag.as_ref()),
        effort,
    );
    // Exercise the production status read, including persisted metadata loading
    // and model observation merging, rather than projecting the saved value here.
    let record = mob
        .console
        .as_ref()
        .unwrap()
        .inspect_identity("specialist")
        .await
        .unwrap()
        .unwrap()
        .identity;
    let expected = ConsoleExpectedTarget {
        identity: record.identity,
        runtime_key: record.runtime_key,
        runtime_member_id: record.runtime_member_id,
        session_id: record.session_id,
        source_mob_id: record.labels.get("source_mob_id").cloned(),
    };
    assert_eq!(
        expected.session_id,
        runtime
            .mob_handle()
            .resolve_bridge_session_id(&member_comms_id::mob_member_id("specialist"))
            .await
            .map(|session| session.to_string()),
        "status must observe the exact specialist session"
    );
    let busy = mob.console_target_busy(&expected).await.unwrap();
    let observed = crate::native_work::read(mob, &expected, busy, None)
        .await
        .unwrap();
    mob.validate_console_incarnation(&expected).await.unwrap();
    assert_eq!(observed["model"], model);
    assert_eq!(observed["modelProvider"], "openai");
    assert_eq!(
        observed["reasoning"],
        json!({"kind":"configured", "values":[
            {"parameter":"reasoning_effort", "value":effort.as_legacy_str()}
        ]})
    );
}

async fn run_plain_turn(runtime: &UnifiedRuntime) {
    let started = start_member_turn(
        runtime,
        "specialist",
        "Reply once without calling tools.",
        meerkat_core::types::HandlingMode::Queue,
        MemberTurnOptions::new(),
        None,
    )
    .await
    .unwrap();
    started.turn.wait().await.unwrap();
}

async fn assert_background_tasks_joined(mob: &MobkitMobRuntime) {
    assert!(mob
        .schedule_host
        .as_ref()
        .unwrap()
        .lock()
        .await
        .joined_successfully());
    assert!(mob
        .schedule_watchdog
        .as_ref()
        .unwrap()
        .lock()
        .await
        .joined_successfully());
    assert!(mob
        .event_drain
        .as_ref()
        .unwrap()
        .lock()
        .await
        .joined_successfully());
}

#[test]
fn initial_project_agent_reasoning_reaches_first_request_and_preserves_later_cold_identity() {
    run_initial_model_proof("domain", None);
}

#[test]
fn thread_approval_model_reconfiguration_retains_its_host_across_cold_restore() {
    // Threads use the ApprovalReconfigureService adapter even when approval
    // gating is off. Exercise its real native transaction after bootstrap has
    // returned, when only the runtime can still own that exact adapter.
    run_initial_model_proof(
        "thread",
        Some(crate::native_execution_modes::ExecutionMode::Approvals),
    );
}

fn run_initial_model_proof(
    kind: &'static str,
    access_mode: Option<crate::native_execution_modes::ExecutionMode>,
) {
    std::thread::Builder::new()
        .name("initial-agent-model-proof".into())
        .stack_size(32 * 1024 * 1024)
        .spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_stack_size(16 * 1024 * 1024)
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    tokio::time::timeout(Duration::from_secs(90), initial_model_proof(kind, access_mode))
                        .await
                        .expect("initial model and cold restore proof must settle");
                });
        })
        .unwrap()
        .join()
        .unwrap();
}

async fn initial_model_proof(
    kind: &str,
    access_mode: Option<crate::native_execution_modes::ExecutionMode>,
) {
    // The cfg(test) realm source owns the entire config chain. Refuse the
    // optional UI child transport rather than inherit an operator's session.
    assert!(
        std::env::var_os("MEERKAT_UI_MCP_SERVER_JS").is_none(),
        "run this offline proof without a live UI MCP server"
    );
    let fixture =
        std::env::temp_dir().join(format!("meerkat-initial-model-{}", uuid::Uuid::new_v4()));
    let project = fixture.join("project");
    let state = fixture.join("state");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&state).unwrap();
    let config = Config::default();
    let initial = json!({
        "model": "gpt-5.6-sol",
        "provider": "openai",
        "providerParams": {"reasoning_effort": "xhigh"}
    });
    let input = CreateMobInput {
        // Native comms names are process-wide even when storage is isolated.
        // Keep this identity stable across this proof's restart, unique across
        // concurrently running domain and thread proofs.
        mob_id: format!("initial-model-proof-{}", uuid::Uuid::new_v4()),
        kind: kind.into(),
        label: "Initial model proof".into(),
        role: "domain".into(),
        coordinator_identity: "specialist".into(),
        model: "gpt-5.6-sol".into(),
        initial_llm: Some(crate::native_model::InitialAgentLlmRequest {
            params: initial.as_object().unwrap().clone(),
            catalog: crate::effective_catalog_models(&config).unwrap(),
        }),
        instructions: "Keep this project charter across reconnects.".into(),
        thread_id: None,
        include_native_workers: false,
        access_mode,
        config_project_path: project.clone(),
        project_path: project,
        state_root: state.clone(),
        config_state_root: state,
    };
    let llm = Arc::new(LlmRecorder::default());
    let host_tools = HostToolTransport::new();
    let first = Arc::new(
        bootstrap_local_runtime_with_proposal_dispatcher(
            input.clone(),
            Arc::clone(&host_tools),
            Some(llm.clone()),
            None,
            None,
        )
        .await
        .unwrap(),
    );
    let first_registry = ProjectMobkitRegistry::new(Arc::clone(&host_tools));
    first_registry
        .mobs
        .write()
        .await
        .insert(input.mob_id.clone(), Arc::clone(&first));
    let runtime = first.runtime.as_ref().unwrap();
    assert!(llm.requests().is_empty(), "creation must not start a turn");
    assert_saved_identity(&first, "gpt-5.6-sol", ReasoningEffort::XHigh).await;
    let member = member_comms_id::mob_member_id("specialist");
    let original_session = runtime
        .mob_handle()
        .resolve_bridge_session_id(&member)
        .await
        .unwrap();
    run_plain_turn(runtime).await;
    let requests = llm.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, "gpt-5.6-sol");
    assert_effort(requests[0].1.as_ref(), ReasoningEffort::XHigh);

    // Change both controls through the installed canonical native host. This
    // must become durable authority before the original creation input is replayed.
    let later = json!({
        "model": "gpt-5.4",
        "provider": "openai",
        "providerParams": {"reasoning_effort": "high"}
    });
    let later =
        crate::native_model::initial_selection(later.as_object().unwrap(), &config).unwrap();
    first
        .session_runtime
        .as_ref()
        .unwrap()
        .reconfigure_session_llm_identity(
            &original_session,
            SessionLlmReconfigureRequest {
                model: Some("gpt-5.4".into()),
                provider: Some(later.provider.as_str().into()),
                self_hosted_server_id: later.self_hosted_server_id,
                provider_params: Some(TurnMetadataOverride::Set(later.provider_params.unwrap())),
                auth_binding: Some(TurnMetadataOverride::Clear),
            },
        )
        .await
        .unwrap();
    assert_saved_identity(&first, "gpt-5.4", ReasoningEffort::High).await;
    assert_eq!(
        llm.requests().len(),
        1,
        "reconfiguration must not run a turn"
    );
    assert!(first_registry.remove(&input.mob_id).await.unwrap());
    assert_background_tasks_joined(&first).await;
    drop(first);
    drop(first_registry);

    // Construct fresh runtime/service owners against the saved stores. An
    // obsolete creation model must neither block resume at catalog validation
    // nor override the current durable model and effort.
    let mut stale_input = input.clone();
    stale_input.model = "removed-from-catalog-initial-model".into();
    stale_input
        .initial_llm
        .as_mut()
        .unwrap()
        .params
        .insert("model".into(), json!(stale_input.model));
    let restored = Arc::new(
        bootstrap_local_runtime_with_proposal_dispatcher(
            stale_input,
            Arc::clone(&host_tools),
            Some(llm.clone()),
            None,
            None,
        )
        .await
        .unwrap(),
    );
    let restored_registry = ProjectMobkitRegistry::new(host_tools);
    restored_registry
        .mobs
        .write()
        .await
        .insert(input.mob_id.clone(), Arc::clone(&restored));
    let runtime = restored.runtime.as_ref().unwrap();
    assert_eq!(llm.requests().len(), 1, "restore must not run a turn");
    assert_eq!(
        runtime
            .mob_handle()
            .resolve_bridge_session_id(&member)
            .await,
        Some(original_session.clone()),
        "cold restore must retain the original member session"
    );
    assert_saved_identity(&restored, "gpt-5.4", ReasoningEffort::High).await;
    run_plain_turn(runtime).await;
    let requests = llm.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].0, "gpt-5.4");
    assert_effort(requests[1].1.as_ref(), ReasoningEffort::High);
    assert_saved_identity(&restored, "gpt-5.4", ReasoningEffort::High).await;
    if kind == "thread" {
        // A cold bootstrap creates another wrapper. Its transaction must work
        // too, not merely restore the identity committed by the previous host.
        let next = json!({
            "model": "gpt-5.4",
            "provider": "openai",
            "providerParams": {"reasoning_effort": "low"}
        });
        let next =
            crate::native_model::initial_selection(next.as_object().unwrap(), &config).unwrap();
        restored
            .session_runtime
            .as_ref()
            .unwrap()
            .reconfigure_session_llm_identity(
                &original_session,
                SessionLlmReconfigureRequest {
                    model: Some("gpt-5.4".into()),
                    provider: Some(next.provider.as_str().into()),
                    self_hosted_server_id: next.self_hosted_server_id,
                    provider_params: Some(TurnMetadataOverride::Set(next.provider_params.unwrap())),
                    auth_binding: Some(TurnMetadataOverride::Clear),
                },
            )
            .await
            .unwrap();
        assert_eq!(llm.requests().len(), 2, "reconfiguration must not run a turn");
        assert_saved_identity(&restored, "gpt-5.4", ReasoningEffort::Low).await;
        run_plain_turn(runtime).await;
        let requests = llm.requests();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[2].0, "gpt-5.4");
        assert_effort(requests[2].1.as_ref(), ReasoningEffort::Low);
    }
    assert!(restored_registry.remove(&input.mob_id).await.unwrap());
    assert_background_tasks_joined(&restored).await;
    drop(restored);
    drop(restored_registry);
    std::fs::remove_dir_all(fixture).unwrap();
}
