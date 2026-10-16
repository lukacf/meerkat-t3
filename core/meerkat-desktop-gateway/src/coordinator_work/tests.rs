use super::*;
use crate::host_tools::HostToolTransport;
use crate::mobkit_registry::{CreateMobInput, ProjectMobkitRegistry};
use meerkat_core::types::{HandlingMode, RuntimeAppendOrigin, SystemNoticeBlock};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

const PEER_A: &str = "Review A is ready";
const PEER_B: &str = "Review B is ready";
const STEERING: &str = "Keep the active review focused";
const PEER_SENDER: &str = "peer-coordinator/coordinator/reviewer";

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::thread::panicking() {
            eprintln!("Coordinator fixture retained at {}", self.0.display());
        } else {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

struct Evidence {
    path: PathBuf,
    records: Mutex<Vec<Value>>,
}
impl Evidence {
    fn record(&self, value: Value) {
        let mut records = self
            .records
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if records.len() < 96 {
            records.push(value);
            if let Ok(encoded) = serde_json::to_vec_pretty(&*records) {
                if let Err(error) = std::fs::write(&self.path, encoded) {
                    eprintln!("Could not write coordinator evidence: {error}");
                }
            }
        }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
struct PeerNotice {
    marker: &'static str,
    origin: Option<RuntimeAppendOrigin>,
}
#[derive(Clone, Debug, serde::Serialize)]
struct ProviderStart {
    ordinal: usize,
    peers: Vec<PeerNotice>,
    steering_count: usize,
}
struct PendingPeerStream {
    start: ProviderStart,
    evidence: Arc<Evidence>,
}
impl futures_util::Stream for PendingPeerStream {
    type Item = Result<meerkat::LlmEvent, meerkat::LlmError>;
    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        std::task::Poll::Pending
    }
}
impl Drop for PendingPeerStream {
    fn drop(&mut self) {
        self.evidence
            .record(json!({"event":"provider_drop","start":self.start}));
    }
}
struct BlockingPeerWork {
    started: tokio::sync::mpsc::UnboundedSender<ProviderStart>,
    next_ordinal: AtomicUsize,
    evidence: Arc<Evidence>,
}
#[async_trait::async_trait]
impl meerkat::LlmClient for BlockingPeerWork {
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
        let mut peers = Vec::new();
        let mut steering_count = 0;
        for message in &request.messages {
            match message {
                meerkat_core::Message::SystemNotice(notice) => {
                    for block in &notice.blocks {
                        if let SystemNoticeBlock::Comms { content, .. } = block {
                            let text = meerkat_core::types::text_content(content);
                            if let Some(marker) = [PEER_A, PEER_B].into_iter().find(|marker| {
                                meerkat_core::format_peer_message_projection(PEER_SENDER, marker)
                                    == text
                            }) {
                                if peers.len() < 8 {
                                    peers.push(PeerNotice {
                                        marker,
                                        origin: notice.runtime_origin.clone(),
                                    });
                                }
                            }
                        }
                    }
                }
                meerkat_core::Message::User(user) if user.text_content() == STEERING => {
                    steering_count += 1
                }
                _ => {}
            }
        }
        let start = ProviderStart {
            ordinal: self.next_ordinal.fetch_add(1, Ordering::Relaxed),
            peers,
            steering_count,
        };
        self.evidence
            .record(json!({"event":"provider_start","start":start}));
        let _ = self.started.send(start.clone());
        if start.peers.is_empty() && start.steering_count > 0 {
            // A pending steer may run independently after the original peer
            // turn is stopped. Let it finish so the queued second review can
            // start; only the two peer turns deliberately block for Stop.
            return Box::pin(futures_util::stream::iter([
                Ok(meerkat::LlmEvent::TextDelta {
                    delta: "Steering acknowledged.".into(),
                    meta: None,
                }),
                Ok(meerkat::LlmEvent::Done {
                    outcome: meerkat::LlmDoneOutcome::Success {
                        stop_reason: meerkat_core::StopReason::EndTurn,
                    },
                }),
            ]));
        }
        Box::pin(PendingPeerStream {
            start,
            evidence: self.evidence.clone(),
        })
    }
    fn provider(&self) -> meerkat_core::Provider {
        meerkat_core::Provider::Other
    }
    async fn health_check(&self) -> Result<(), meerkat::LlmError> {
        Ok(())
    }
}

async fn peer_started(
    starts: &mut tokio::sync::mpsc::UnboundedReceiver<ProviderStart>,
    marker: &str,
) -> Result<RuntimeAppendOrigin, String> {
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(start) = starts.recv().await {
            for peer in start.peers {
                if peer.marker == marker {
                    return peer
                        .origin
                        .ok_or_else(|| format!("{marker} has no native append origin"));
                }
            }
        }
        Err(format!("Provider channel closed before {marker}"))
    })
    .await
    .map_err(|_| format!("No identified provider start for {marker} within 10 seconds"))?
}

async fn native_evidence(
    evidence: &Evidence,
    stage: &str,
    machine: &meerkat_runtime::MeerkatMachine,
    session: &meerkat_core::SessionId,
    known: &[meerkat_core::lifecycle::InputId],
) -> Vec<meerkat_core::lifecycle::InputId> {
    let active = machine.list_active_inputs(session).await;
    let mut ids = known.to_vec();
    if let Ok(active) = &active {
        for id in active.iter().take(16) {
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
    }
    let mut inputs = Vec::new();
    for id in &ids {
        match machine.input_state(session, id).await {
            Ok(Some(stored)) => {
                let peer_text = match stored.state.persisted_input.as_ref() {
                    Some(meerkat_runtime::input::Input::Peer(peer)) => {
                        Some(peer.content.text_content())
                    }
                    _ => None,
                };
                let header = stored
                    .state
                    .persisted_input
                    .as_ref()
                    .map(|input| input.header());
                inputs.push(json!({
                    "inputId":id,"peerText":peer_text,"phase":stored.seed.phase,
                    "runId":stored.seed.last_run_id,"terminal":stored.seed.terminal_outcome,
                    "attemptCount":stored.seed.attempt_count,"recoveryLane":stored.seed.recovery_lane,
                    "boundarySequence":stored.seed.last_boundary_sequence,
                    "idempotencyKey":stored.state.idempotency_key,
                    "correlationId":header.and_then(|header| header.correlation_id.as_ref()),
                    "source":header.map(|header| &header.source),
                    "history":stored.state.history.iter().rev().take(12).collect::<Vec<_>>()
                }));
            }
            other => inputs.push(json!({"inputId":id,"read":format!("{other:?}")})),
        }
    }
    evidence.record(
        json!({"event":"native_snapshot","stage":stage,"sessionId":session,
        "activeInputs":format!("{active:?}"),"inputs":inputs}),
    );
    ids
}

async fn assert_native_peer(
    machine: &meerkat_runtime::MeerkatMachine,
    session: &meerkat_core::SessionId,
    origin: &RuntimeAppendOrigin,
    marker: &str,
    envelope: uuid::Uuid,
    projection: &Value,
) -> Value {
    assert_eq!(&origin.session_id, session);
    let stored = machine
        .input_state(session, &origin.input_id)
        .await
        .unwrap()
        .unwrap();
    let Some(meerkat_runtime::input::Input::Peer(peer)) = stored.state.persisted_input.as_ref()
    else {
        panic!("{marker} must identify a canonical peer input");
    };
    assert_eq!(
        peer.content.text_content(),
        meerkat_core::format_peer_message_projection(PEER_SENDER, marker)
    );
    assert_eq!(
        peer.header.correlation_id.as_ref().map(|id| id.0),
        Some(envelope),
        "{marker} must bind the exact send receipt envelope"
    );
    assert_eq!(stored.seed.last_run_id.as_ref(), Some(&origin.run_id));
    projection["inputs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|input| {
            input["inputId"] == origin.input_id.to_string()
                && input["runId"] == origin.run_id.to_string()
        })
        .unwrap_or_else(|| {
            panic!("{marker} must be the exact projected native input/run: {projection}")
        })
        .clone()
}

#[test]
fn real_peer_wake_is_visible_and_late_stop_cannot_cancel_successor_work() {
    std::thread::Builder::new().stack_size(32 * 1024 * 1024).spawn(|| {
        tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_stack_size(16 * 1024 * 1024)
            .enable_all().build().unwrap().block_on(async {
                let fixture = Fixture(std::env::temp_dir().join(format!("coordinator-peer-{}",uuid::Uuid::new_v4())));
                let project = fixture.0.join("project");
                let state = fixture.0.join("state");
                std::fs::create_dir_all(&project).unwrap();
                std::fs::create_dir_all(&state).unwrap();
                let evidence = Arc::new(Evidence { path: fixture.0.join("coordinator-evidence.json"), records: Mutex::new(Vec::new()) });
                let (started,mut starts) = tokio::sync::mpsc::unbounded_channel();
                let registry = Arc::new(ProjectMobkitRegistry::new_with_test_llm(HostToolTransport::new(), Arc::new(BlockingPeerWork {
                    started, next_ordinal: AtomicUsize::new(1), evidence: evidence.clone(),
                })));
                let gateway = MeerkatGateway::new();
                gateway.inner.mobkit_registries.lock().await.insert(state.canonicalize().unwrap(),registry.clone());
                let mob = registry.create_local(CreateMobInput {
                    mob_id:"peer-coordinator".into(),kind:"thread".into(),label:"Peer coordinator".into(),
                    role:"coordinator".into(),coordinator_identity:"ingress".into(),model:"gpt-5.6-sol".into(), initial_llm: None,
                    instructions:"Wait for peer review input.".into(),thread_id:Some("peer-thread".into()),
                    include_native_workers:false,access_mode:None,config_project_path:project.clone(),project_path:project.clone(),
                    state_root:state.clone(),config_state_root:state.clone(),
                }).await.unwrap();
                let runtime = mob.runtime.as_ref().unwrap();
                let handle = runtime.mob_handle();
                handle.spawn_spec(meerkat_mob::SpawnMemberSpec::new("coordinator","reviewer").with_runtime_mode(meerkat_mob::MobRuntimeMode::TurnDriven)).await.unwrap();
                handle.wire("reviewer".into(),meerkat_mob::AgentIdentity::from("ingress")).await.unwrap();
                let record = mob.console.as_ref().unwrap().inspect_identity("ingress").await.unwrap().unwrap().identity;
                let session: meerkat_core::SessionId = serde_json::from_value(json!(record.session_id.as_deref().unwrap())).unwrap();
                let machine = mob.session_runtime.as_ref().unwrap();
                let params = json!({"projectPath":project,"stateRoot":state,"mobId":mob.mob_id,"expected":{
                    "identity":record.identity,"runtimeKey":record.runtime_key,"runtimeMemberId":record.runtime_member_id,
                    "sessionId":record.session_id,"sourceMobId":record.labels.get("source_mob_id")
                }});
                assert!(gateway.mobs_coordinator_work(Some(&params)).await.unwrap()["inputs"].as_array().unwrap().is_empty());
                let delivery_a = handle.send_peer_message("reviewer".into(),"ingress".into(),PEER_A,HandlingMode::Queue).await.unwrap();
                evidence.record(json!({"event":"peer_send","marker":PEER_A,"receipt":delivery_a}));
                let origin_a = match peer_started(&mut starts, PEER_A).await {
                    Ok(origin) => origin,
                    Err(prerequisite) => {
                        let known = native_evidence(&evidence, "A prerequisite failed", machine, &session, &[]).await;
                        evidence.record(json!({"event":"A_prerequisite_failed","error":prerequisite}));
                        let shutdown_errors = registry.shutdown().await;
                        evidence.record(json!({"event":"registry_shutdown","errors":shutdown_errors}));
                        native_evidence(&evidence, "after shutdown with A prerequisite failed", machine, &session, &known).await;
                        assert!(shutdown_errors.is_empty(), "Registry shutdown failed: {shutdown_errors:?}; A prerequisite: {prerequisite}");
                        panic!("A prerequisite failed: {prerequisite}; whole registry shutdown was empty");
                    }
                };
                native_evidence(&evidence, "A started", machine, &session, &[origin_a.input_id.clone()]).await;
                let first = gateway.mobs_coordinator_work(Some(&params)).await.unwrap();
                assert_eq!(first["busy"],true);
                let first_input = assert_native_peer(machine, &session, &origin_a, PEER_A, delivery_a.envelope_id, &first).await;
                let mut stop_a = params.clone();
                stop_a["inputId"] = first_input["inputId"].clone();
                stop_a["nativeRunId"] = first_input["runId"].clone();
                let mut steer_a = stop_a.clone();
                steer_a["content"] = json!(STEERING);
                steer_a["idempotencyKey"] = json!("active-peer-steer");
                let admitted = gateway.mobs_coordinator_steer(Some(&steer_a)).await.unwrap();
                evidence.record(json!({"event":"steering_receipt","receipt":admitted["receipt"]}));
                assert_eq!(admitted["receipt"]["kind"],"runtime_input");
                assert_eq!(admitted["receipt"]["sessionId"],record.session_id.as_deref().unwrap());
                assert!(admitted["receipt"].get("input_frame_id").is_none(),"native ingress never invents a console receipt");
                let steering_id: meerkat_core::lifecycle::InputId = serde_json::from_value(admitted["receipt"]["inputId"].clone()).unwrap();
                let mut known = vec![origin_a.input_id.clone(), steering_id];
                native_evidence(&evidence, "S admitted during A", machine, &session, &known).await;
                let duplicate = gateway.mobs_coordinator_steer(Some(&steer_a)).await.unwrap();
                assert_eq!(duplicate["receipt"],admitted["receipt"]);
                let mut changed = steer_a.clone();
                changed["content"] = json!("A different message cannot reuse the admission");
                assert!(gateway.mobs_coordinator_steer(Some(&changed)).await.is_err());
                let recovered = coordinator_steer_receipt(Some(&steer_a)).await.unwrap();
                assert_eq!(recovered["receipt"],admitted["receipt"],"read-only lookup uses canonical input admission");
                assert_eq!(gateway.mobs_coordinator_stop(Some(&stop_a)).await.unwrap()["accepted"],true);
                native_evidence(&evidence, "after Stop A", machine, &session, &known).await;
                let delivery_b = handle.send_peer_message("reviewer".into(),"ingress".into(),PEER_B,HandlingMode::Queue).await.unwrap();
                evidence.record(json!({"event":"peer_send","marker":PEER_B,"receipt":delivery_b}));
                known = native_evidence(&evidence, "B sent", machine, &session, &known).await;
                // The next request may be durable steering S replaying after Stop A.
                // Only B's typed peer notice plus exact native input/run can identify B.
                let origin_b = match peer_started(&mut starts, PEER_B).await {
                    Ok(origin) => origin,
                    Err(prerequisite) => {
                        known = native_evidence(&evidence, "B prerequisite failed", machine, &session, &known).await;
                        evidence.record(json!({"event":"B_prerequisite_failed","error":prerequisite}));
                        let shutdown_errors = registry.shutdown().await;
                        evidence.record(json!({"event":"registry_shutdown","errors":shutdown_errors}));
                        native_evidence(&evidence, "after shutdown with B prerequisite failed", machine, &session, &known).await;
                        assert!(shutdown_errors.is_empty(), "Registry shutdown failed: {shutdown_errors:?}; B prerequisite: {prerequisite}");
                        panic!("B prerequisite failed: {prerequisite}; whole registry shutdown was empty");
                    }
                };
                if !known.contains(&origin_b.input_id) { known.push(origin_b.input_id.clone()); }
                native_evidence(&evidence, "B started", machine, &session, &known).await;
                let second = gateway.mobs_coordinator_work(Some(&params)).await.unwrap();
                let second_input = assert_native_peer(machine, &session, &origin_b, PEER_B, delivery_b.envelope_id, &second).await;
                assert_ne!(first_input["runId"],second_input["runId"]);
                assert_ne!(first_input["inputId"],second_input["inputId"]);
                assert_eq!(gateway.mobs_coordinator_stop(Some(&stop_a)).await.unwrap()["accepted"],false);
                native_evidence(&evidence, "after late Stop A", machine, &session, &known).await;
                let after_late_stop = gateway.mobs_coordinator_work(Some(&params)).await.unwrap();
                assert_eq!(after_late_stop["busy"],true,"late Stop for A must not interrupt B");
                assert!(after_late_stop["inputs"].as_array().unwrap().iter().any(|input|input["inputId"]==second_input["inputId"]));
                let mut stale_steer = stop_a.clone();
                stale_steer["content"] = json!("This instruction belongs to A only");
                stale_steer["idempotencyKey"] = json!("stale-peer-steer");
                assert!(gateway.mobs_coordinator_steer(Some(&stale_steer)).await.is_err());
                let mut stop_b = params.clone();
                stop_b["inputId"] = second_input["inputId"].clone();
                stop_b["nativeRunId"] = second_input["runId"].clone();
                assert_eq!(gateway.mobs_coordinator_stop(Some(&stop_b)).await.unwrap()["accepted"],true);
                native_evidence(&evidence, "after exact Stop B", machine, &session, &known).await;
                let app = gateway.project_runtime_handle_for_paths(project.to_str().unwrap(),project.to_str().unwrap(),"local".into(),Some(state.to_str().unwrap())).await.unwrap();
                assert!(app.state.lock().await.active_runs.is_empty(),"native peer controls never invent an app turn");
                let shutdown_errors = registry.shutdown().await;
                evidence.record(json!({"event":"registry_shutdown","errors":shutdown_errors}));
                native_evidence(&evidence, "after registry shutdown", machine, &session, &known).await;
                assert!(shutdown_errors.is_empty(), "Registry shutdown failed: {shutdown_errors:?}");
            });
    }).unwrap().join().unwrap();
}

#[test]
fn typed_steering_has_one_user_append_and_preserves_image_blocks() {
    use meerkat_core::{
        lifecycle::{ConversationAppendRole, CoreRenderable},
        ContentInput,
    };
    let content: ContentInput = serde_json::from_value(json!([
        {"type":"text","text":"Inspect this image while continuing"},
        {"type":"image","media_type":"image/png","source":"blob","blob_id":"sha256:fixture"},
    ]))
    .unwrap();
    let meerkat_runtime::input::Input::Prompt(prompt) =
        steer_input(content.clone(), "stable-key".into())
    else {
        panic!("prompt");
    };
    assert_eq!(prompt.content.text_content(), "");
    assert_eq!(prompt.typed_turn_appends.len(), 1);
    assert_eq!(
        prompt.typed_turn_appends[0].role,
        ConversationAppendRole::User
    );
    let CoreRenderable::Blocks { blocks } = &prompt.typed_turn_appends[0].content else {
        panic!("image blocks");
    };
    assert_eq!(
        serde_json::to_value(blocks).unwrap(),
        serde_json::to_value(content.into_blocks()).unwrap()
    );
    assert_eq!(prompt.header.idempotency_key.unwrap().0, "stable-key");
    assert_eq!(
        prompt.turn_metadata.unwrap().handling_mode,
        Some(HandlingMode::Steer)
    );
}
