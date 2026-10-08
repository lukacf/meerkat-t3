use super::*;
use crate::{
    host_tools::HostToolTransport,
    mobkit_registry::{CreateMobInput, ProjectMobkitRegistry},
};
use meerkat_core::types::HandlingMode;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

struct EditOncePerRun {
    calls: AtomicUsize,
    marker: PathBuf,
}
#[async_trait::async_trait]
impl meerkat::LlmClient for EditOncePerRun {
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
        let count = self.calls.fetch_add(1, Ordering::SeqCst);
        let events = if count % 2 == 0 {
            assert!(
                request
                    .tools
                    .iter()
                    .any(|tool| tool.name.as_str() == "shell")
            );
            vec![
                meerkat::LlmEvent::ToolCallComplete {
                    id: format!("approval-write-{count}"),
                    name: "shell".into(),
                    args: json!({"command":format!("printf 'native effect\\n' >> '{}'",self.marker.display()),"timeout_secs":5}),
                    meta: None,
                },
                meerkat::LlmEvent::Done {
                    outcome: meerkat::LlmDoneOutcome::Success {
                        stop_reason: meerkat_core::StopReason::ToolUse,
                    },
                },
            ]
        } else {
            vec![
                meerkat::LlmEvent::TextDelta {
                    delta: "The requested tool decision is complete.".into(),
                    meta: None,
                },
                meerkat::LlmEvent::Done {
                    outcome: meerkat::LlmDoneOutcome::Success {
                        stop_reason: meerkat_core::StopReason::EndTurn,
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

async fn wire_sender(runtime: &meerkat_mobkit::UnifiedRuntime) {
    let handle = runtime.mob_handle();
    if handle
        .resolve_bridge_session_id(&"sender".into())
        .await
        .is_none()
    {
        handle
            .spawn_spec(
                meerkat_mob::SpawnMemberSpec::new("domain", "sender")
                    .with_runtime_mode(meerkat_mob::MobRuntimeMode::TurnDriven),
            )
            .await
            .unwrap();
    }
    handle
        .wire(
            "sender".into(),
            meerkat_mob::AgentIdentity::from("specialist"),
        )
        .await
        .unwrap();
}
async fn settled(runtime: &meerkat_mobkit::UnifiedRuntime, session: &meerkat_core::SessionId) {
    let service = runtime.mob_runtime().session_service().unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if !service.read(session).await.unwrap().state.is_active {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

async fn decide_pending(
    approvals: &NativeApprovals,
    marker: &Path,
    expected_effects: usize,
    decision: ApprovalDecision,
) -> String {
    let record = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let rows = approvals.list(None).unwrap();
            if let Some(row) = rows["approvals"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["actionable"] == true)
            {
                break row["record"].clone();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("native tool must block for approval");
    assert_eq!(
        std::fs::read_to_string(marker)
            .unwrap_or_default()
            .lines()
            .count(),
        expected_effects,
        "tool executed before approval"
    );
    let session = record["owner"]["session_id"].as_str().unwrap();
    let id = record["approval_id"].as_str().unwrap();
    assert!(record["request_body"]["runId"].is_string());
    approvals.decide(session, id, decision).unwrap();
    session.to_string()
}

#[test]
fn native_approval_gate_covers_warm_peers_restart_and_child_builds() {
    std::thread::Builder::new().stack_size(32*1024*1024).spawn(|| {
        tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_stack_size(16*1024*1024).enable_all().build().unwrap().block_on(async {
            let root = std::env::temp_dir().join(format!("native-approval-lifecycle-{}",uuid::Uuid::new_v4()));
            let mut input = CreateMobInput {
                mob_id:"approval-domain".into(),kind:"sub".into(),label:"Approval proof".into(),role:"domain".into(),coordinator_identity:"specialist".into(),model:"gpt-5.6-sol".into(), initial_llm: None,instructions:"Use deterministic fixture.".into(),thread_id:None,include_native_workers:false,
                access_mode:Some(crate::native_execution_modes::ExecutionMode::Approvals),config_project_path:root.join("project"),project_path:root.join("project"),state_root:root.join("state"),config_state_root:root.join("state"),
            };
            std::fs::create_dir_all(&input.project_path).unwrap();
            let realm = crate::mobkit_registry::load_effective_realm_config(&input.config_project_path,&input.config_state_root).await.unwrap();
            let mut config = realm.raw_head; config.shell.program="/bin/sh".into(); realm.head_store.set(config).await.unwrap();
            let marker = input.project_path.join("effects.txt");
            let llm=Arc::new(EditOncePerRun{calls:AtomicUsize::new(0),marker:marker.clone()});
            let mut expected_effects=0;
            let mut saved_session=None;
            for restart in 0..2 {
                let registry=ProjectMobkitRegistry::new_with_test_llm(HostToolTransport::new(),llm.clone());
                let mob=registry.create_local(input.clone()).await.unwrap();
                assert_eq!(mob.access_mode,crate::native_execution_modes::ExecutionMode::Approvals);
                let approvals=mob.approvals.as_ref().unwrap();
                let runtime=mob.runtime.as_ref().unwrap();
                let session=runtime.mob_handle().resolve_bridge_session_id(&"specialist".into()).await.unwrap();
                if let Some(old)=&saved_session { assert_eq!(old,&session); }
                saved_session=Some(session.clone());
                wire_sender(runtime).await;
                for peer in [false,true] {
                    if peer { runtime.mob_handle().send_peer_message("sender".into(),"specialist".into(),"Peer approval episode",HandlingMode::Queue).await.unwrap(); }
                    else { crate::mobkit_registry::send_to_member(runtime,"specialist","Explicit approval episode",HandlingMode::Queue).await.unwrap(); }
                    let decision=if restart==0 && peer {ApprovalDecision::Deny}else{ApprovalDecision::Approve};
                    assert_eq!(decide_pending(approvals,&marker,expected_effects,decision).await,session.to_string());
                    settled(runtime,&session).await;
                    if decision==ApprovalDecision::Approve { expected_effects+=1; }
                    assert_eq!(std::fs::read_to_string(&marker).unwrap_or_default().lines().count(),expected_effects);
                }
                if restart==1 {
                    let state=runtime.mob_runtime().agent_mob_mcp_state().unwrap();
                    let child_id=meerkat_mob::MobId::from("approval-child");
                    let definition:meerkat_mob::MobDefinition=serde_json::from_value(json!({"id":child_id,"profiles":{"worker":{"model":"gpt-5.6-sol","runtime_mode":"turn_driven","tools":{"builtins":true,"shell":true,"comms":true}}}})).unwrap();
                    state.mob_create_definition_with_owner_bridge_session(definition,session.clone(),true,false).await.unwrap();
                    let child=state.mob_handles_snapshot().await.unwrap().into_iter().find(|(id,_)|id==&child_id).unwrap().1;
                    child.spawn_spec_with_generated_owner_context(meerkat_mob::SpawnMemberSpec::new("worker","approval-worker").with_runtime_mode(meerkat_mob::MobRuntimeMode::TurnDriven).with_initial_message("Child approval episode"),session.clone()).await.unwrap();
                    let child_session=child.resolve_bridge_session_id(&"approval-worker".into()).await.unwrap();
                    assert_eq!(decide_pending(approvals,&marker,expected_effects,ApprovalDecision::Approve).await,child_session.to_string());
                    settled(runtime,&child_session).await; expected_effects+=1;
                    assert_eq!(std::fs::read_to_string(&marker).unwrap().lines().count(),expected_effects);
                }
                assert!(registry.shutdown().await.is_empty());
                input.access_mode=None;
            }
            assert_eq!(llm.calls.load(Ordering::SeqCst),10);
            assert_eq!(expected_effects,4);
            std::fs::remove_dir_all(root).unwrap();
        });
    }).unwrap().join().unwrap();
}
