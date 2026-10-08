//! Project-agent responsibility revisions on the canonical session activation boundary.
//!
//! The session transcript owns the revision. No member replacement, sidecar
//! authority, profile rewrite, or direct session-store mutation is involved.
use std::sync::Arc;

use meerkat::session_runtime::{
    MeerkatSessionRuntime, SessionRuntimeBuilder,
    instruction_activation::InstructionActivationHostError,
};
use meerkat::{FactoryAgentBuilder, PersistentSessionService, StagedSessionRegistry};
use meerkat_core::{
    InstructionActivationAdmissionErrorCode, InstructionActivationId,
    InstructionActivationReadQuery, InstructionActivationRequest, InstructionContentDigest,
    InstructionKey, InstructionNamespace, InstructionRevisionId, InstructionRevisionRef, SessionId,
};
use meerkat_runtime::SessionServiceRuntimeExt as _;
use serde_json::{Map, Value, json};
use tokio::sync::Mutex;

use crate::GatewayError;
use crate::mobkit_registry::{ConsoleExpectedTarget, MobkitMobRuntime};

const NAMESPACE: &str = "meerkat.desktop.project-agent";
const KEY: &str = "responsibilities";
const MAX_INSTRUCTIONS_BYTES: usize = 64 * 1024;

pub(crate) struct NativeResponsibilities {
    runtime: MeerkatSessionRuntime,
    // Serialize desktop revisions of this one domain session. Native activation
    // still owns runtime-work admission and its durable compare-and-set boundary.
    revisions: Mutex<()>,
}

impl NativeResponsibilities {
    pub(crate) fn new(
        service: Arc<PersistentSessionService<FactoryAgentBuilder>>,
        machine: Arc<meerkat_runtime::MeerkatMachine>,
    ) -> Self {
        Self {
            runtime: SessionRuntimeBuilder::new(
                service,
                Arc::new(StagedSessionRegistry::new()),
                machine,
            )
            .build(),
            revisions: Mutex::new(()),
        }
    }

    async fn activate(
        &self,
        session_id: &SessionId,
        revision_id: InstructionRevisionId,
        instructions: &str,
    ) -> Result<(), GatewayError> {
        let _revision = self.revisions.lock().await;
        // The native facade waits for a finalization boundary before admission.
        // Check its machine authority before reading history so existing work
        // is refused promptly instead of holding the user's Apply request.
        let state = self
            .runtime
            .runtime_adapter
            .runtime_state(session_id)
            .await
            .map_err(|error| GatewayError::conflict(error.to_string(), None))?;
        let pending = self
            .runtime
            .runtime_adapter
            .list_active_inputs(session_id)
            .await
            .map_err(|error| GatewayError::conflict(error.to_string(), None))?;
        if matches!(state, meerkat_runtime::RuntimeState::Running) || !pending.is_empty() {
            return Err(activation_error(
                InstructionActivationHostError::Admission {
                    code: InstructionActivationAdmissionErrorCode::SessionBusy,
                    message: "The native session has active work".into(),
                },
            ));
        }
        let namespace = InstructionNamespace::new(NAMESPACE).expect("constant namespace");
        let key = InstructionKey::new(KEY).expect("constant key");
        let activation_id = InstructionActivationId::new(revision_id.as_str())
            .map_err(|error| GatewayError::invalid(error.to_string(), None))?;
        let body = responsibility_body(instructions);
        let revision = InstructionRevisionRef {
            namespace: namespace.clone(),
            key: key.clone(),
            revision_id,
            content_sha256: InstructionContentDigest::for_body(&body),
        };
        let page = self
            .runtime
            .read_instruction_activations(
                session_id,
                InstructionActivationReadQuery {
                    namespace: Some(namespace),
                    key: Some(key),
                    offset: None,
                    limit: 1,
                },
            )
            .await
            .map_err(|error| {
                GatewayError::conflict(
                    "Could not read the agent's current responsibility revision",
                    Some(json!({"kind":"responsibility_revision_unavailable","error":error.to_string()})),
                )
            })?;
        let state = page.key_state.ok_or_else(|| {
            GatewayError::policy("Native responsibility state is unavailable", None)
        })?;
        // The canonical duplicate check requires the original predecessor,
        // not the current row itself. Reconstruct it from the durable receipt.
        let supersedes = match state.effective_origin_local.as_ref() {
            Some(record) if record.identity.activation_id == activation_id => {
                record.identity.supersedes.clone()
            }
            _ => state.next_supersedes,
        };
        self.runtime
            .activate_instruction(
                session_id,
                InstructionActivationRequest {
                    revision,
                    activation_id,
                    expectation: state.next_expectation,
                    supersedes,
                    body,
                },
            )
            .await
            .map_err(activation_error)?;
        Ok(())
    }
}

fn responsibility_body(instructions: &str) -> String {
    format!(
        "Current project-agent responsibilities. These replace the responsibilities previously assigned to this agent. Preserve other system policies, the existing conversation, and peer connections.\n\n{instructions}"
    )
}

fn activation_error(error: InstructionActivationHostError) -> GatewayError {
    let code = error.admission_code();
    let message = match code {
        Some(InstructionActivationAdmissionErrorCode::SessionBusy) => {
            "The agent is working. Apply this revision when it is idle."
        }
        Some(InstructionActivationAdmissionErrorCode::UnsupportedCurrentLowering) => {
            "The current model cannot apply instruction revisions to an existing conversation. Choose a compatible model before applying this revision."
        }
        Some(InstructionActivationAdmissionErrorCode::TargetNotMaterialized) => {
            "Connect the agent before applying a responsibility revision."
        }
        _ => "The native runtime could not apply this responsibility revision.",
    };
    GatewayError::conflict(
        message,
        Some(
            json!({"kind":"responsibility_revision_conflict","reason":code,"error":error.to_string()}),
        ),
    )
}

pub(crate) async fn revise(
    mob: &MobkitMobRuntime,
    params: &Map<String, Value>,
) -> Result<Value, GatewayError> {
    let text = |key: &str| {
        params
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| GatewayError::invalid(format!("{key} is required"), None))
    };
    let identity = text("identity")?;
    let instructions = text("instructions")?;
    let revision_id = InstructionRevisionId::new(text("revisionId")?)
        .map_err(|error| GatewayError::invalid(error.to_string(), None))?;
    if instructions.len() > MAX_INSTRUCTIONS_BYTES {
        return Err(GatewayError::invalid(
            "Responsibilities must be at most 64 KiB",
            None,
        ));
    }
    if mob.kind != "domain" || mob.coordinator_identity != identity {
        return Err(GatewayError::invalid(
            "Responsibilities can only be revised for this project's durable agent",
            Some(json!({"kind":"invalid_responsibility_target"})),
        ));
    }
    let host = mob.responsibility_host.as_ref().ok_or_else(|| {
        GatewayError::policy("Native responsibility controls are unavailable", None)
    })?;
    let record = mob
        .console
        .as_ref()
        .ok_or_else(|| GatewayError::policy("Agent console is unavailable", None))?
        .inspect_identity(identity)
        .await
        .map_err(|error| GatewayError::conflict(error.to_string(), None))?
        .ok_or_else(|| GatewayError::not_found("Project agent is not connected", None))?
        .identity;
    let expected = ConsoleExpectedTarget {
        identity: record.identity,
        runtime_key: record.runtime_key,
        runtime_member_id: record.runtime_member_id,
        session_id: record.session_id,
        source_mob_id: record.labels.get("source_mob_id").cloned(),
    };
    if expected.source_mob_id.is_some() {
        return Err(GatewayError::invalid(
            "A child worker is not a project agent",
            None,
        ));
    }
    // Reject already-active work promptly. The activation facade repeats
    // admission under the native turn boundary, closing the race with ingress.
    if mob
        .console_target_busy(&expected)
        .await
        .map_err(|error| GatewayError::conflict(error, None))?
    {
        return Err(GatewayError::conflict(
            "The agent is working. Apply this revision when it is idle.",
            Some(json!({"kind":"responsibility_revision_conflict","reason":"session_busy"})),
        ));
    }
    let session_id: SessionId =
        serde_json::from_value(json!(expected.session_id.as_ref().ok_or_else(|| {
            GatewayError::conflict("Project agent has no native session", None)
        })?))
        .map_err(|error| GatewayError::invalid(error.to_string(), None))?;
    host.activate(&session_id, revision_id.clone(), instructions)
        .await?;
    mob.validate_console_target(&expected)
        .await
        .map_err(|error| GatewayError::conflict(error, None))?;
    Ok(json!({"applied":true,"revisionId":revision_id}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mobkit_registry::ProjectMobkitRegistry;
    use meerkat::LlmClient;
    use meerkat_core::SessionServiceHistoryExt as _;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    struct FixtureClient {
        started: tokio::sync::Semaphore,
        release: tokio::sync::Semaphore,
        calls: AtomicUsize,
        requests: std::sync::Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl LlmClient for FixtureClient {
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
            use futures_util::StreamExt;
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.requests
                .lock()
                .unwrap()
                .push(serde_json::to_string(&request.messages).unwrap());
            self.started.add_permits(1);
            Box::pin(
                futures_util::stream::once(async move {
                    self.release.acquire().await.unwrap().forget();
                    Ok(meerkat::LlmEvent::TextDelta {
                        delta: "Existing conversation remains intact.".into(),
                        meta: None,
                    })
                })
                .chain(futures_util::stream::once(async {
                    Ok(meerkat::LlmEvent::Done {
                        outcome: meerkat::LlmDoneOutcome::Success {
                            stop_reason: meerkat_core::StopReason::EndTurn,
                        },
                    })
                })),
            )
        }
        fn provider(&self) -> meerkat_core::Provider {
            meerkat_core::Provider::Other
        }
        async fn health_check(&self) -> Result<(), meerkat::LlmError> {
            Ok(())
        }
    }

    #[test]
    fn responsibility_revision_preserves_native_identity_and_durable_history() {
        std::thread::Builder::new()
            .stack_size(16 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(proof());
            })
            .unwrap()
            .join()
            .unwrap();
    }

    async fn wait_idle(host: &NativeResponsibilities, session: &SessionId) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let machine = &host.runtime.runtime_adapter;
                let state = machine.runtime_state(session).await.unwrap();
                let inputs = machine.list_active_inputs(session).await.unwrap();
                if matches!(
                    state,
                    meerkat_runtime::RuntimeState::Idle | meerkat_runtime::RuntimeState::Attached
                ) && inputs.is_empty()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("native turn finishes and all admitted inputs settle");
    }

    async fn proof() {
        let fixture = std::env::temp_dir().join(format!(
            "meerkat-responsibility-revision-{}",
            uuid::Uuid::new_v4()
        ));
        let project = fixture.join("project");
        let state = fixture.join("state");
        std::fs::create_dir_all(&project).unwrap();
        let project = project.to_string_lossy().into_owned();
        let state = state.to_string_lossy().into_owned();
        let gateway = crate::MeerkatGateway::new();
        let client = Arc::new(FixtureClient {
            started: tokio::sync::Semaphore::new(0),
            release: tokio::sync::Semaphore::new(0),
            calls: AtomicUsize::new(0),
            requests: std::sync::Mutex::new(Vec::new()),
        });
        let project_handle = gateway
            .project_runtime_handle_for_paths(&project, &project, "local".into(), Some(&state))
            .await
            .unwrap();
        project_handle.state.lock().await.mobkit =
            Arc::new(ProjectMobkitRegistry::new_with_test_llm(
                Arc::clone(&gateway.inner.host_tools),
                client.clone(),
            ));
        let create = json!({"projectPath":project,"stateRoot":state,"mobId":"domain-revisions","label":"Revision Specialist","role":"domain","agentIdentity":"specialist","model":"gpt-5.6-sol","instructions":"Original responsibility"});
        gateway.mobs_create_domain_mob(Some(&create)).await.unwrap();
        let mob = gateway
            .mob_for_params(create.as_object().unwrap(), "domain-revisions")
            .await
            .unwrap();
        let console = mob.console.as_ref().unwrap();
        let record = console
            .inspect_identity("specialist")
            .await
            .unwrap()
            .unwrap()
            .identity;
        let session_id: SessionId =
            serde_json::from_value(json!(record.session_id.as_ref().unwrap())).unwrap();
        let runtime = mob.runtime.as_ref().unwrap();
        let native = runtime.mob_handle();
        native
            .spawn_spec(
                meerkat_mob::SpawnMemberSpec::new("domain", "peer")
                    .with_runtime_mode(meerkat_mob::MobRuntimeMode::TurnDriven),
            )
            .await
            .unwrap();
        native
            .wire(
                meerkat_mobkit::member_comms_id::mob_member_id("specialist"),
                meerkat_mobkit::member_comms_id::mob_member_id("peer"),
            )
            .await
            .unwrap();
        let before_members = native.list_members_observation_snapshot().await;
        let before = before_members
            .iter()
            .find(|m| {
                meerkat_mobkit::member_comms_id::runtime_alias_str(m.agent_identity.as_str())
                    == "specialist"
            })
            .unwrap();
        let send = json!({"projectPath":project,"stateRoot":state,"mobId":"domain-revisions","expected":{"identity":record.identity,"runtimeKey":record.runtime_key,"runtimeMemberId":record.runtime_member_id,"sessionId":record.session_id,"sourceMobId":null},"content":"Preserve my conversation","handlingMode":"queue","idempotencyKey":"revision-history"});
        gateway.mobs_console_send(Some(&send)).await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), client.started.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
        let mut revision = json!({"identity":"specialist","instructions":"Own release validation and report concrete evidence.","revisionId":"revision-1"});
        let busy = revise(&mob, revision.as_object().unwrap())
            .await
            .unwrap_err();
        let GatewayError::Api {
            typed_code,
            details,
            ..
        } = busy;
        assert_eq!(typed_code, "CONFLICT");
        assert_eq!(details.unwrap()["reason"], "session_busy");
        let native_busy = tokio::time::timeout(
            Duration::from_secs(2),
            mob.responsibility_host.as_ref().unwrap().activate(
                &session_id,
                InstructionRevisionId::new("revision-1").unwrap(),
                revision["instructions"].as_str().unwrap(),
            ),
        )
        .await
        .expect("busy native activation is promptly rejected")
        .unwrap_err();
        let GatewayError::Api { details, .. } = native_busy;
        assert_eq!(
            details.unwrap()["reason"],
            "session_busy",
            "native boundary also rejects active ingress"
        );
        client.release.add_permits(1);
        wait_idle(mob.responsibility_host.as_ref().unwrap(), &session_id).await;
        let history_before = mob
            .responsibility_host
            .as_ref()
            .unwrap()
            .runtime
            .service
            .read_history(&session_id, meerkat_core::SessionHistoryQuery::default())
            .await
            .unwrap();
        assert!(history_before.messages.iter().any(|message| matches!(message,
            meerkat_core::Message::User(user) if user.text_content() == "Preserve my conversation")));
        let mut wrong_target = revision.clone();
        wrong_target["identity"] = json!("peer");
        assert!(
            revise(&mob, wrong_target.as_object().unwrap())
                .await
                .is_err(),
            "project instructions must not change a same-mob worker"
        );
        let applied = revise(&mob, revision.as_object().unwrap()).await.unwrap();
        assert_eq!(applied, json!({"applied":true,"revisionId":"revision-1"}));
        assert_eq!(
            revise(&mob, revision.as_object().unwrap()).await.unwrap(),
            applied
        );
        let host = mob.responsibility_host.as_ref().unwrap();
        let page = host
            .runtime
            .read_instruction_activations(&session_id, InstructionActivationReadQuery::default())
            .await
            .unwrap();
        assert_eq!(
            page.records.len(),
            1,
            "replay cannot append a duplicate activation"
        );
        assert_eq!(
            client.calls.load(Ordering::SeqCst),
            1,
            "revising responsibilities does not invoke the model"
        );
        revision["instructions"] = json!("Same revision with different instructions");
        assert!(revise(&mob, revision.as_object().unwrap()).await.is_err());
        revision["revisionId"] = json!("revision-2");
        revise(&mob, revision.as_object().unwrap()).await.unwrap();
        let after_members = native.list_members_observation_snapshot().await;
        let after = after_members
            .iter()
            .find(|m| m.agent_identity == before.agent_identity)
            .unwrap();
        assert_eq!(
            native
                .resolve_bridge_session_id_observation(&after.agent_identity)
                .await,
            Some(session_id.clone())
        );
        assert!(
            !before.wired_to.is_empty(),
            "the proof must preserve a real peer edge"
        );
        assert_eq!(after.wired_to, before.wired_to);
        assert_eq!(after_members.len(), before_members.len());
        gateway.mobs_destroy(Some(&create)).await.unwrap();
        drop(mob);
        gateway.mobs_create_domain_mob(Some(&create)).await.unwrap();
        let restored = gateway
            .mob_for_params(create.as_object().unwrap(), "domain-revisions")
            .await
            .unwrap();
        let restored_record = restored
            .console
            .as_ref()
            .unwrap()
            .inspect_identity("specialist")
            .await
            .unwrap()
            .unwrap()
            .identity;
        assert_eq!(restored_record.session_id, record.session_id);
        let page = restored
            .responsibility_host
            .as_ref()
            .unwrap()
            .runtime
            .read_instruction_activations(&session_id, InstructionActivationReadQuery::default())
            .await
            .unwrap();
        assert_eq!(page.records.len(), 2);
        let history_restored = restored
            .responsibility_host
            .as_ref()
            .unwrap()
            .runtime
            .service
            .read_history(&session_id, meerkat_core::SessionHistoryQuery::default())
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(&history_restored.messages[..history_before.messages.len()])
                .unwrap(),
            serde_json::to_value(&history_before.messages).unwrap(),
            "old conversation is unchanged"
        );
        assert_eq!(
            page.records[1].identity.revision.revision_id.as_str(),
            "revision-2"
        );
        assert_eq!(
            revise(&restored, revision.as_object().unwrap())
                .await
                .unwrap()["applied"],
            true
        );
        assert_eq!(client.calls.load(Ordering::SeqCst), 1);
        let mut next_turn = send.clone();
        next_turn["idempotencyKey"] = json!("revision-after-reconnect");
        next_turn["content"] = json!("Use the revised responsibilities.");
        gateway.mobs_console_send(Some(&next_turn)).await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), client.started.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
        let request = client.requests.lock().unwrap().last().unwrap().clone();
        assert!(
            request.contains("Same revision with different instructions"),
            "the next model request must contain the latest responsibility revision"
        );
        assert!(
            request.contains("Preserve my conversation"),
            "the prior conversation still reaches the provider"
        );
        client.release.add_permits(1);
        wait_idle(restored.responsibility_host.as_ref().unwrap(), &session_id).await;
        assert_eq!(client.calls.load(Ordering::SeqCst), 2);
        assert!(gateway.shutdown().await.is_empty());
        let _ = std::fs::remove_dir_all(fixture);
    }
}
