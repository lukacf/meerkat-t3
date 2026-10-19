use super::*;
use crate::{
    host_tools::HostToolTransport,
    mobkit_registry::{CreateMobInput, ProjectMobkitRegistry},
};
use meerkat_runtime::terminal_status::{InputTerminalReceiptRead, InteractionSelector};
use std::time::Duration;

struct InspectChildCatalog {
    phase: AtomicU64,
    requests: AtomicU64,
}

#[async_trait::async_trait]
impl meerkat::LlmClient for InspectChildCatalog {
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
        self.requests.fetch_add(1, Ordering::SeqCst);
        assert!(
            request
                .tools
                .iter()
                .any(|tool| tool.name.as_str() == "shell"),
            "Native builtins must survive browser composition"
        );
        let phase = self.phase.load(Ordering::SeqCst);
        assert_eq!(
            request
                .tools
                .iter()
                .any(|tool| tool.name.as_str() == "preview_status"),
            matches!(phase, 1 | 2),
            "Browser tools must follow the explicit grant on the already-built child"
        );
        let mut events = Vec::new();
        let stop_reason = if phase == 1 {
            self.phase.store(2, Ordering::SeqCst);
            events.push(meerkat::LlmEvent::ToolCallComplete {
                id: "native-child-preview".into(),
                name: "preview_status".into(),
                args: json!({}),
                meta: None,
            });
            meerkat_core::StopReason::ToolUse
        } else {
            events.push(meerkat::LlmEvent::TextDelta {
                delta: "Native child catalog checked.".into(),
                meta: None,
            });
            meerkat_core::StopReason::EndTurn
        };
        events.push(meerkat::LlmEvent::Done {
            outcome: meerkat::LlmDoneOutcome::Success { stop_reason },
        });
        Box::pin(futures_util::stream::iter(events.into_iter().map(Ok)))
    }

    fn provider(&self) -> meerkat_core::Provider {
        meerkat_core::Provider::Other
    }
    async fn health_check(&self) -> Result<(), meerkat::LlmError> {
        Ok(())
    }
}

async fn expected_child(owner: &MobkitMobRuntime, session: &SessionId) -> ConsoleExpectedTarget {
    let record = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let records = owner
                .console
                .as_ref()
                .unwrap()
                .list_identities()
                .await
                .unwrap();
            if let Some(record) = records
                .into_iter()
                .find(|record| record.session_id.as_deref() == Some(session.to_string().as_str()))
            {
                break record;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    ConsoleExpectedTarget {
        identity: record.identity,
        runtime_key: record.runtime_key,
        runtime_member_id: record.runtime_member_id,
        session_id: record.session_id,
        source_mob_id: record.labels.get("source_mob_id").cloned(),
    }
}

async fn console_turn(owner: &MobkitMobRuntime, expected: &ConsoleExpectedTarget, message: &str) {
    owner.validate_console_incarnation(expected).await.unwrap();
    let receipt = owner
        .console
        .as_ref()
        .unwrap()
        .send(meerkat_mobkit::ConsoleSendRequest {
            identity: expected.identity.clone(),
            content: json!(message),
            origin: "browser-child-fixture".into(),
            origin_kind: None,
            idempotency_key: message.into(),
            handling_mode: Some("queue".into()),
            skill_refs: Vec::new(),
        })
        .await
        .unwrap();
    assert_eq!(receipt.session_id, expected.session_id);
    let session = SessionId::parse(expected.session_id.as_ref().unwrap()).unwrap();
    let machine = owner.session_runtime.as_ref().unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let Some(read) = machine
                .input_terminal_receipt(
                    &session,
                    InteractionSelector::IdempotencyKey(receipt.input_frame_id.clone()),
                )
                .await
                .unwrap()
            {
                if let InputTerminalReceiptRead::Finalized(terminal) = read.report {
                    let meerkat_runtime::completion::CompletionOutcome::Completed(result) =
                        terminal.outcome()
                    else {
                        panic!(
                            "Native browser console turn did not complete: {:?}",
                            terminal.outcome()
                        );
                    };
                    assert_eq!(result.session_id, session);
                    assert!(result.extraction_error.is_none());
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[test]
fn native_child_build_receives_late_browser_grant_without_replacing_builtins() {
    std::thread::Builder::new().stack_size(32 * 1024 * 1024).spawn(|| {
        tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_stack_size(16 * 1024 * 1024).enable_all().build().unwrap().block_on(async {
            let root = std::env::temp_dir().join(format!("native-child-browser-{}", uuid::Uuid::new_v4()));
            let input = CreateMobInput {
                mob_id: "browser-thread".into(), kind: "thread".into(), label: "Browser child proof".into(),
                role: "coordinator".into(), coordinator_identity: "coordinator".into(), model: "gpt-5.6-sol".into(), initial_llm: None,
                instructions: "Use the deterministic fixture.".into(), thread_id: Some("browser-thread".into()), include_native_workers: true,
                access_mode: Some(crate::native_execution_modes::ExecutionMode::FullAccess),
                config_project_path: root.join("project"), project_path: root.join("project"), state_root: root.join("state"), config_state_root: root.join("state"),
            };
            std::fs::create_dir_all(&input.project_path).unwrap();
            let llm = Arc::new(InspectChildCatalog { phase: AtomicU64::new(0), requests: AtomicU64::new(0) });
            let registry = ProjectMobkitRegistry::new_with_test_llm(HostToolTransport::new(), llm.clone());
            let owner = registry.create_local(input.clone()).await.unwrap();
            let runtime = owner.runtime.as_ref().unwrap();
            let coordinator = runtime.mob_handle().resolve_bridge_session_id(&"coordinator".into()).await.unwrap();
            let state = runtime.mob_runtime().agent_mob_mcp_state().unwrap();
            let child_id = meerkat_mob::MobId::from("browser-native-child");
            let definition: meerkat_mob::MobDefinition = serde_json::from_value(json!({
                "id": child_id,
                "profiles": {
                    "worker": { "model": "gpt-5.6-sol", "runtime_mode": "turn_driven", "tools": { "builtins": true, "shell": true, "comms": true, "mcp": ["t3_preview"] } },
                    "restricted": { "model": "gpt-5.6-sol", "runtime_mode": "turn_driven", "tools": { "builtins": true, "shell": true, "comms": true, "mcp": ["another_source"] } }
                }
            })).unwrap();
            state.mob_create_definition_with_owner_bridge_session(definition, coordinator.clone(), true, false).await.unwrap();
            let child = state.mob_handles_snapshot().await.unwrap().into_iter().find(|(id, _)| id == &child_id).unwrap().1;
            child.spawn_spec_with_generated_owner_context(
                meerkat_mob::SpawnMemberSpec::new("worker", "browser-worker")
                    .with_runtime_mode(meerkat_mob::MobRuntimeMode::TurnDriven).with_initial_message("Inspect the initial catalog"),
                coordinator.clone(),
            ).await.unwrap();
            child.wait_for_kickoff_complete(Some(Duration::from_secs(15))).await.unwrap();
            let session = child.resolve_bridge_session_id(&"browser-worker".into()).await.unwrap();
            let expected = expected_child(&owner, &session).await;
            let guard = child_grant(&owner, &expected).await.unwrap().unwrap();
            assert_eq!(guard.binding().member, "browser-worker");
            let proxy = scoped(Scope { project: input.project_path, state: input.state_root, mob: input.mob_id });
            let host = Arc::new(Preview { names: vec!["preview_status", "preview_open"], calls: AtomicU64::new(0), invalidate_on_probe: None });
            let revision = proxy.revoke(&session.to_string());
            proxy.grants.write().unwrap().insert(session.to_string(), Grant {
                host_thread_id: Some("original-thread".into()), host_session_id: Some(coordinator.to_string()),
                dispatcher: host.clone(), revision, child_guard: Some(guard),
            });
            proxy.epoch.fetch_add(1, Ordering::SeqCst);
            llm.phase.store(1, Ordering::SeqCst);
            console_turn(&owner, &expected, "Use the shared browser").await;
            assert_eq!(host.calls.load(Ordering::SeqCst), 2, "Host probe and real tool dispatch must both execute");

            proxy.revoke(&session.to_string());
            llm.phase.store(3, Ordering::SeqCst);
            console_turn(&owner, &expected, "Check the revoked catalog").await;
            assert_eq!(host.calls.load(Ordering::SeqCst), 2);
            assert!(llm.requests.load(Ordering::SeqCst) >= 4);

            child.spawn_spec_with_generated_owner_context(
                meerkat_mob::SpawnMemberSpec::new("restricted", "restricted-worker").with_runtime_mode(meerkat_mob::MobRuntimeMode::TurnDriven).with_initial_message("Inspect the restricted catalog"),
                coordinator,
            ).await.unwrap();
            child.wait_for_kickoff_complete(Some(Duration::from_secs(15))).await.unwrap();
            let restricted = child.resolve_bridge_session_id(&"restricted-worker".into()).await.unwrap();
            assert!(child_grant(&owner, &expected_child(&owner, &restricted).await).await.is_err());
            assert!(registry.shutdown().await.is_empty());
            drop(child);
            drop(state);
            drop(owner);
            // Actor shutdown does not release the store observers. Drain them
            // before removing the fixture's SQLite files.
            let drain = registry.drain_storage_observers().await;
            assert!(drain.is_empty(), "browser child fixture: {drain:?}");
            std::fs::remove_dir_all(root).unwrap();
        });
    }).unwrap().join().unwrap();
}

#[test]
fn cold_restored_child_preserves_identity_and_requires_a_new_browser_grant() {
    std::thread::Builder::new()
        .name("cold-child-browser-proof".into())
        .stack_size(32 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_stack_size(16 * 1024 * 1024)
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    tokio::time::timeout(Duration::from_secs(90), cold_child_browser_proof())
                        .await
                        .expect("cold child browser proof must settle");
                });
        })
        .unwrap()
        .join()
        .unwrap();
}

async fn cold_child_browser_proof() {
    assert!(
        std::env::var_os("MEERKAT_UI_MCP_SERVER_JS").is_none(),
        "run this offline proof without a live UI MCP server"
    );
    assert!(
        std::env::var_os("MEERKAT_PROJECT_AGENT_PROPOSAL_MCP_SERVER_JS").is_none(),
        "run this offline proof without a live project proposal MCP server"
    );
    let root = std::env::temp_dir().join(format!("cold-child-browser-{}", uuid::Uuid::new_v4()));
    let input = CreateMobInput {
        mob_id: "cold-browser-thread".into(),
        kind: "thread".into(),
        label: "Cold browser child proof".into(),
        role: "coordinator".into(),
        coordinator_identity: "coordinator".into(),
        model: "gpt-5.6-sol".into(),
        initial_llm: None,
        instructions: "Use the deterministic fixture.".into(),
        thread_id: Some("cold-browser-thread".into()),
        include_native_workers: true,
        access_mode: Some(crate::native_execution_modes::ExecutionMode::FullAccess),
        config_project_path: root.join("project"),
        project_path: root.join("project"),
        state_root: root.join("state"),
        config_state_root: root.join("state"),
    };
    std::fs::create_dir_all(&input.project_path).unwrap();
    let scope = Scope {
        project: input.project_path.clone(),
        state: input.state_root.clone(),
        mob: input.mob_id.clone(),
    };
    let child_id = meerkat_mob::MobId::from("cold-browser-native-child");
    let llm = Arc::new(InspectChildCatalog {
        phase: AtomicU64::new(0),
        requests: AtomicU64::new(0),
    });
    let mut saved_sessions = None;

    for attempt in 0..2 {
        llm.phase.store(0, Ordering::SeqCst);
        let before_restore = llm.requests.load(Ordering::SeqCst);
        let registry =
            ProjectMobkitRegistry::new_with_test_llm(HostToolTransport::new(), llm.clone());
        let owner = registry.create_local(input.clone()).await.unwrap();
        let runtime = owner.runtime.as_ref().unwrap();
        let coordinator = runtime
            .mob_handle()
            .resolve_bridge_session_id(&"coordinator".into())
            .await
            .unwrap();
        let state = runtime.mob_runtime().agent_mob_mcp_state().unwrap();
        if attempt == 0 {
            let definition: meerkat_mob::MobDefinition = serde_json::from_value(json!({
                "id": child_id,
                "profiles": {
                    "worker": { "model": "gpt-5.6-sol", "runtime_mode": "turn_driven", "tools": { "builtins": true, "shell": true, "comms": true, "mcp": ["t3_preview"] } },
                    "restricted": { "model": "gpt-5.6-sol", "runtime_mode": "turn_driven", "tools": { "builtins": true, "shell": true, "comms": true, "mcp": ["another_source"] } }
                }
            }))
            .unwrap();
            state
                .mob_create_definition_with_owner_bridge_session(
                    definition,
                    coordinator.clone(),
                    true,
                    false,
                )
                .await
                .unwrap();
        }
        let child = state.handle_for(&child_id).await.unwrap();
        if attempt == 0 {
            for (profile, member) in [
                ("worker", "browser-worker"),
                ("restricted", "restricted-worker"),
            ] {
                child
                    .spawn_spec_with_generated_owner_context(
                        meerkat_mob::SpawnMemberSpec::new(profile, member)
                            .with_runtime_mode(meerkat_mob::MobRuntimeMode::TurnDriven)
                            .with_initial_message("Inspect the initial catalog"),
                        coordinator.clone(),
                    )
                    .await
                    .unwrap();
            }
            child
                .wait_for_kickoff_complete(Some(Duration::from_secs(15)))
                .await
                .unwrap();
        }
        let session = child
            .resolve_bridge_session_id(&"browser-worker".into())
            .await
            .unwrap();
        let restricted = child
            .resolve_bridge_session_id(&"restricted-worker".into())
            .await
            .unwrap();
        let sessions = (coordinator.clone(), session.clone(), restricted.clone());
        if let Some(saved) = &saved_sessions {
            assert_eq!(
                &sessions, saved,
                "cold restore must reuse every saved session"
            );
        } else {
            saved_sessions = Some(sessions);
        }
        let expected = expected_child(&owner, &session).await;
        let restricted_expected = expected_child(&owner, &restricted).await;
        if attempt == 1 {
            assert_eq!(
                llm.requests.load(Ordering::SeqCst),
                before_restore,
                "restoring and observing the child must not start a model turn"
            );
        }
        let restricted_profile = child
            .effective_member_profile(&"restricted-worker".into())
            .await
            .unwrap();
        assert_eq!(restricted_profile.tools.mcp, vec!["another_source".to_owned()]);
        assert!(restricted_profile.tools.builtins && restricted_profile.tools.shell);
        assert!(child_grant(&owner, &restricted_expected).await.is_err());

        let proxy = scoped(scope.clone());
        assert!(proxy.grants.read().unwrap().is_empty());
        // The recorder checks the actual LLM tool catalog: builtins remain,
        // while the restored child has no preview tool without a new grant.
        console_turn(
            &owner,
            &expected,
            &format!("No browser grant in lifetime {attempt}"),
        )
        .await;
        console_turn(
            &owner,
            &restricted_expected,
            &format!("Restricted browser source in lifetime {attempt}"),
        )
        .await;
        let guard = child_grant(&owner, &expected).await.unwrap().unwrap();
        assert_eq!(guard.binding().member, "browser-worker");
        let host = Arc::new(Preview {
            names: vec!["preview_status", "preview_open"],
            calls: AtomicU64::new(0),
            invalidate_on_probe: None,
        });
        let revision = proxy.revoke(&session.to_string());
        proxy.grants.write().unwrap().insert(
            session.to_string(),
            Grant {
                host_thread_id: Some("cold-browser-thread".into()),
                host_session_id: Some(coordinator.to_string()),
                dispatcher: host.clone(),
                revision,
                child_guard: Some(guard),
            },
        );
        proxy.epoch.fetch_add(1, Ordering::SeqCst);
        llm.phase.store(1, Ordering::SeqCst);
        console_turn(
            &owner,
            &expected,
            &format!("Use new browser grant in lifetime {attempt}"),
        )
        .await;
        assert_eq!(
            host.calls.load(Ordering::SeqCst),
            2,
            "the native child must execute the host probe and preview tool"
        );

        let prior_owner = Arc::downgrade(&owner);
        assert!(registry.shutdown().await.is_empty());
        drop(child);
        drop(state);
        drop(owner);
        let drain = registry.drain_storage_observers().await;
        assert!(drain.is_empty(), "cold browser fixture {attempt}: {drain:?}");
        drop(registry);
        assert!(
            prior_owner.upgrade().is_none(),
            "the prior runtime owner must be gone"
        );
        // SCOPES is process-local, not saved policy. Remove only this fixture's
        // entry to model process exit after all of its native owners joined.
        assert!(
            crate::browser_bridge::SCOPES
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .remove(&scope)
                .is_some()
        );
    }
    std::fs::remove_dir_all(root).unwrap();
}
