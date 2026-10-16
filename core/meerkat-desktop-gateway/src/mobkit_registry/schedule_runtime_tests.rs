use super::*;

#[derive(Default)]
struct ScheduleLlm {
    result: std::sync::Mutex<Option<(bool, String)>>,
}

#[async_trait::async_trait]
impl meerkat::LlmClient for ScheduleLlm {
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
        let result = request.messages.iter().rev().find_map(|message| {
            if let meerkat_core::Message::ToolResults { results, .. } = message {
                results
                    .iter()
                    .find(|result| result.tool_use_id == "schedule-admission")
            } else {
                None
            }
        });
        let events = if let Some(result) = result {
            *self.result.lock().unwrap() = Some((result.is_error, result.text_content()));
            vec![
                meerkat::LlmEvent::TextDelta {
                    delta: "Schedule checked.".into(),
                    meta: None,
                },
                meerkat::LlmEvent::Done {
                    outcome: meerkat::LlmDoneOutcome::Success {
                        stop_reason: meerkat_core::StopReason::EndTurn,
                    },
                },
            ]
        } else {
            assert!(request
                .tools
                .iter()
                .any(|tool| tool.name == "meerkat_schedule_create"));
            vec![
                meerkat::LlmEvent::ToolCallComplete {
                    id: "schedule-admission".into(),
                    name: "meerkat_schedule_create".into(),
                    args: json!({
                        "name": "Desktop schedule admission proof",
                        "trigger": {"type": "once", "due_at_utc": (Utc::now() + chrono::Duration::days(1)).to_rfc3339()},
                        "target": {"target_kind": "session", "type": "current_session", "action": {"type": "prompt", "prompt": "Scheduled proof"}},
                        "misfire_policy": {"type": "skip"},
                        "overlap_policy": "skip_if_running",
                        "missing_target_policy": "mark_misfired"
                    }),
                    meta: None,
                },
                meerkat::LlmEvent::Done {
                    outcome: meerkat::LlmDoneOutcome::Success {
                        stop_reason: meerkat_core::StopReason::ToolUse,
                    },
                },
            ]
        };
        Box::pin(futures_util::stream::iter(events.into_iter().map(Ok)))
    }

    fn provider(&self) -> meerkat_core::Provider {
        meerkat_core::Provider::Other
    }

    async fn health_check(&self) -> Result<(), meerkat::LlmError> {
        Ok(())
    }
}

#[test]
fn native_schedule_tools_admit_writes_after_the_desktop_firing_host_starts() {
    std::thread::Builder::new()
        .name("desktop-schedule-admission".into())
        .stack_size(32 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_stack_size(16 * 1024 * 1024)
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    let fixture = tempfile::tempdir().unwrap();
                    let project = fixture.path().join("project");
                    let state = fixture.path().join("state");
                    std::fs::create_dir_all(&project).unwrap();
                    let llm = Arc::new(ScheduleLlm::default());
                    let registry = ProjectMobkitRegistry::new_with_test_llm(
                        HostToolTransport::new(),
                        llm.clone(),
                    );
                    let mob = registry
                        .create_local(CreateMobInput {
                            mob_id: format!("schedule-proof-{}", uuid::Uuid::new_v4()),
                            kind: "thread".into(),
                            label: "Schedule proof".into(),
                            role: "ingress".into(),
                            coordinator_identity: "ingress".into(),
                            model: "gpt-5.6-sol".into(),
                            initial_llm: None,
                            instructions: "Create the requested schedule.".into(),
                            thread_id: None,
                            include_native_workers: false,
                            access_mode: None,
                            config_project_path: project.clone(),
                            project_path: project,
                            state_root: state.clone(),
                            config_state_root: state,
                        })
                        .await
                        .unwrap();
                    let started = start_member_turn(
                        mob.runtime.as_ref().unwrap(),
                        "ingress",
                        "Schedule tomorrow's check.",
                        meerkat_core::types::HandlingMode::Queue,
                        MemberTurnOptions::new(),
                        None,
                    )
                    .await
                    .unwrap();
                    started.turn.wait().await.unwrap();
                    let result = llm
                        .result
                        .lock()
                        .unwrap()
                        .clone()
                        .expect("native schedule result");
                    assert!(!result.0, "native schedule write was refused: {}", result.1);
                    let value: Value = serde_json::from_str(&result.1).unwrap();
                    assert!(value["schedule_id"].as_str().is_some(), "{value}");
                    assert_eq!(value["name"], "Desktop schedule admission proof");
                    let failures = registry.shutdown().await;
                    assert!(failures.is_empty(), "{failures:?}");
                    drop(mob);
                    let failures = registry.drain_storage_observers().await;
                    assert!(failures.is_empty(), "{failures:?}");
                });
        })
        .unwrap()
        .join()
        .unwrap();
}
