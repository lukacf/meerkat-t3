use super::*;
use crate::{
    host_tools::HostToolTransport,
    mobkit_registry::{CreateMobInput, ProjectMobkitRegistry},
};
use serde_json::json;
use std::{
    path::PathBuf,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::sync::{mpsc, oneshot};

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct HeldStream {
    closed: mpsc::UnboundedSender<()>,
}
impl futures_util::Stream for HeldStream {
    type Item = Result<meerkat::LlmEvent, meerkat::LlmError>;
    fn poll_next(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Poll::Pending
    }
}
impl Drop for HeldStream {
    fn drop(&mut self) {
        let _ = self.closed.send(());
    }
}
struct HeldProvider {
    started: mpsc::UnboundedSender<()>,
    closed: mpsc::UnboundedSender<()>,
}
#[async_trait::async_trait]
impl meerkat::LlmClient for HeldProvider {
    fn project_replay_messages(
        &self,
        messages: &[meerkat_core::Message],
    ) -> Result<Vec<meerkat_core::Message>, meerkat::LlmError> {
        Ok(messages.to_vec())
    }
    fn stream<'a>(
        &'a self,
        _: &'a meerkat::LlmRequest,
    ) -> Pin<
        Box<
            dyn futures_util::Stream<Item = Result<meerkat::LlmEvent, meerkat::LlmError>>
                + Send
                + 'a,
        >,
    > {
        self.started.send(()).unwrap();
        Box::pin(HeldStream {
            closed: self.closed.clone(),
        })
    }
    fn provider(&self) -> meerkat_core::Provider {
        meerkat_core::Provider::Other
    }
    async fn health_check(&self) -> Result<(), meerkat::LlmError> {
        Ok(())
    }
}

fn input(root: &std::path::Path) -> CreateMobInput {
    CreateMobInput {
        mob_id: root.file_name().unwrap().to_string_lossy().into_owned(),
        kind: "thread".into(),
        label: "Disposal proof".into(),
        role: "coordinator".into(),
        coordinator_identity: "ingress".into(),
        model: "gpt-5.6-sol".into(), initial_llm: None,
        instructions: "Use the controlled test provider.".into(),
        thread_id: Some("disposal-thread".into()),
        include_native_workers: false,
        access_mode: None,
        config_project_path: root.join("project"),
        project_path: root.join("project"),
        state_root: root.join("state"),
        config_state_root: root.join("state"),
    }
}
fn run(test: impl Future<Output = ()> + Send + 'static) {
    std::thread::Builder::new()
        .stack_size(32 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_stack_size(16 * 1024 * 1024)
                .enable_all()
                .build()
                .unwrap()
                .block_on(test);
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn late_child_input_is_interrupted_while_the_same_shutdown_future_is_pending() {
    run(async {
        let fixture =
            Fixture(std::env::temp_dir().join(format!("disposal-late-{}", uuid::Uuid::new_v4())));
        let spec = input(&fixture.0);
        std::fs::create_dir_all(&spec.project_path).unwrap();
        std::fs::create_dir_all(&spec.state_root).unwrap();
        let (started, mut starts) = mpsc::unbounded_channel();
        let (closed, mut closes) = mpsc::unbounded_channel();
        let registry = Arc::new(ProjectMobkitRegistry::new_with_test_llm(
            HostToolTransport::new(),
            Arc::new(HeldProvider { started, closed }),
        ));
        let mob = registry.create_local(spec.clone()).await.unwrap();
        let runtime = mob.runtime.as_ref().unwrap();
        let owner = runtime
            .mob_handle()
            .resolve_bridge_session_id(&"ingress".into())
            .await
            .unwrap();
        let children = runtime.mob_runtime().agent_mob_mcp_state().unwrap();
        let child_id = meerkat_mob::MobId::from(format!("{}-child", spec.mob_id));
        let definition: meerkat_mob::MobDefinition = serde_json::from_value(json!({
            "id": child_id, "profiles": { "worker": {
                "model": "gpt-5.6-sol", "runtime_mode": "autonomous_host",
                "tools": { "builtins": true, "shell": true, "comms": true }
            }}
        }))
        .unwrap();
        children
            .mob_create_definition_with_owner_bridge_session(definition, owner.clone(), true, false)
            .await
            .unwrap();
        let child = children
            .mob_handles_snapshot()
            .await
            .unwrap()
            .into_iter()
            .find(|(id, _)| id == &child_id)
            .unwrap()
            .1;
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let cleanup_runtime = Arc::clone(runtime);
        let cleanup_child = child.clone();
        let cleanup = tokio::spawn(async move {
            let first_scan = std::sync::Mutex::new(Some((entered_tx, release_rx)));
            let mut changes = cleanup_child.machine_state_changes();
            let (start_shutdown, wait_for_input) = oneshot::channel();
            let start_shutdown = std::sync::Mutex::new(Some(start_shutdown));
            while_interrupting_inputs(
                async {
                    wait_for_input.await.unwrap();
                    cleanup_child.shutdown().await.unwrap();
                    while !changes.is_closed() {
                        if changes.changed().await.is_err() {
                            break;
                        }
                    }
                },
                || {
                    let first = first_scan.lock().unwrap().take();
                    let start_shutdown = &start_shutdown;
                    let runtime = &cleanup_runtime;
                    let child = &cleanup_child;
                    async move {
                        let result = interrupt_owned_inputs(runtime, child).await;
                        if let Some((entered, release)) = first {
                            // Hold the first empty scan before it returns. The
                            // late native input is admitted during this gap.
                            entered.send(()).unwrap();
                            release.await.unwrap();
                            start_shutdown
                                .lock()
                                .unwrap()
                                .take()
                                .unwrap()
                                .send(())
                                .unwrap();
                        }
                        result
                    }
                },
            )
            .await;
        });
        entered_rx.await.unwrap();
        let spawn = meerkat_mob::SpawnMemberSpec::new("worker", "late-worker")
            .with_runtime_mode(meerkat_mob::MobRuntimeMode::AutonomousHost)
            .with_initial_message("Hold this late provider request until native cancellation.");
        child
            .spawn_spec_with_generated_owner_context(spawn, owner)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), starts.recv())
            .await
            .unwrap()
            .unwrap();
        // Do not release the shutdown future until the input has really entered
        // the native provider. No provider event or test timeout releases it.
        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(10), closes.recv())
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(15), cleanup)
            .await
            .unwrap()
            .unwrap();
        assert!(child.machine_state_changes().is_closed());
        // The helper already proved this child's native acknowledgment/exit.
        // Retain that exact progress when checking the enclosing runtime.
        let disposal = NativeRuntimeDisposal::default();
        disposal
            .progress
            .lock()
            .await
            .children_closed
            .insert(child_id.to_string());
        disposal.shutdown(runtime).await.unwrap();
        assert!(runtime.mob_handle().machine_state_changes().is_closed());
    });
}

#[test]
fn parent_runtime_phase_ack_requires_actual_actor_exit() {
    run(async {
        let fixture =
            Fixture(std::env::temp_dir().join(format!("disposal-parent-{}", uuid::Uuid::new_v4())));
        let spec = input(&fixture.0);
        std::fs::create_dir_all(&spec.project_path).unwrap();
        std::fs::create_dir_all(&spec.state_root).unwrap();
        let (started, _) = mpsc::unbounded_channel();
        let (closed, _) = mpsc::unbounded_channel();
        let registry = ProjectMobkitRegistry::new_with_test_llm(
            HostToolTransport::new(),
            Arc::new(HeldProvider { started, closed }),
        );
        let mob = registry.create_local(spec).await.unwrap();
        let runtime = mob.runtime.as_ref().unwrap();
        let parent = runtime.mob_handle();
        let changes = parent.machine_state_changes();
        assert!(!changes.is_closed());
        // Isolate the production phase immediately after a successful runtime
        // report. A still-live actor must not be mistaken for completed cleanup.
        // This does not fabricate a policy refusal: native Shutdown is allowed
        // even for Unresolved command authority in the published scope gate.
        let mut progress = DisposalProgress {
            runtime_phases_completed: true,
            ..Default::default()
        };
        tokio::time::timeout(
            Duration::from_secs(15),
            finish_parent_actor(runtime, &parent, &mut progress),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(progress.parent_closed);
        assert!(
            changes.is_closed(),
            "phase acknowledgment must not replace actual parent actor exit"
        );
        // A retry uses the recorded native closure, without asking the closed
        // actor to run Shutdown again (which cannot accept another command).
        finish_parent_actor(runtime, &parent, &mut progress)
            .await
            .unwrap();
        // Runtime phases were not run in this isolated gate test. Drain their
        // owners without asserting the actor's already-closed Stop can rerun.
        let _ = runtime.shutdown().await;
    });
}

#[test]
fn parent_exit_between_observation_and_redundant_shutdown_is_not_a_refusal() {
    run(async {
        let fixture = Fixture(
            std::env::temp_dir().join(format!("disposal-exit-race-{}", uuid::Uuid::new_v4())),
        );
        let spec = input(&fixture.0);
        std::fs::create_dir_all(&spec.project_path).unwrap();
        std::fs::create_dir_all(&spec.state_root).unwrap();
        let (started, _) = mpsc::unbounded_channel();
        let (closed, _) = mpsc::unbounded_channel();
        let registry = ProjectMobkitRegistry::new_with_test_llm(
            HostToolTransport::new(),
            Arc::new(HeldProvider { started, closed }),
        );
        let mob = registry.create_local(spec).await.unwrap();
        let runtime = mob.runtime.as_ref().unwrap();
        let parent = runtime.mob_handle();
        let mut changes = parent.machine_state_changes();
        assert!(!changes.is_closed());
        // This is the actual successful parent phase report preceding our
        // extra actor-closure check. Force the observation-to-command race.
        assert!(runtime.shutdown().await.cleanup_completed());
        while !changes.is_closed() {
            if changes.changed().await.is_err() {
                break;
            }
        }
        let result = parent.shutdown().await;
        assert!(matches!(result, Err(MobError::ActorCommandChannelClosed)));
        finish_parent_shutdown(&mut changes, result).await.unwrap();
        assert!(changes.is_closed());
        assert!(
            finish_parent_shutdown(
                &mut changes,
                Err(MobError::Internal("unrelated refusal".into()))
            )
            .await
            .is_err(),
            "a closed observation cannot turn arbitrary native errors into success"
        );
    });
}

#[test]
fn redundant_parent_reply_loss_requires_exact_actor_exit() {
    run(async {
        let fixture = Fixture(
            std::env::temp_dir().join(format!("disposal-reply-race-{}", uuid::Uuid::new_v4())),
        );
        let spec = input(&fixture.0);
        std::fs::create_dir_all(&spec.project_path).unwrap();
        std::fs::create_dir_all(&spec.state_root).unwrap();
        let (started, _) = mpsc::unbounded_channel();
        let (closed, _) = mpsc::unbounded_channel();
        let registry = ProjectMobkitRegistry::new_with_test_llm(
            HostToolTransport::new(),
            Arc::new(HeldProvider { started, closed }),
        );
        let mob = registry.create_local(spec).await.unwrap();
        let runtime = mob.runtime.as_ref().unwrap();
        let parent = runtime.mob_handle();
        let mut changes = parent.machine_state_changes();
        assert!(!changes.is_closed());

        // Inject the typed reply loss at the narrow post-phase boundary to
        // deterministically hold the observation-to-exit race open. A dropped
        // reply must not itself complete cleanup while this actor is alive.
        let mut finish = Box::pin(finish_parent_shutdown(
            &mut changes,
            Err(MobError::ActorReplyChannelClosed),
        ));
        assert!(matches!(futures_util::poll!(&mut finish), Poll::Pending));

        // The real runtime must acknowledge its phases, and this exact parent
        // must close its publisher before the pending boundary can complete.
        assert!(runtime.shutdown().await.cleanup_completed());
        tokio::time::timeout(Duration::from_secs(15), finish)
            .await
            .unwrap()
            .unwrap();
        assert!(changes.is_closed());
        finish_parent_shutdown(&mut changes, Err(MobError::ActorReplyChannelClosed))
            .await
            .unwrap();
        assert!(
            finish_parent_shutdown(
                &mut changes,
                Err(MobError::Internal("mob actor reply channel closed".into())),
            )
            .await
            .is_err(),
            "matching error text cannot replace the typed native channel outcome"
        );
    });
}

#[tokio::test]
async fn expired_caller_wait_retains_the_same_cleanup_owner() {
    let disposal = NativeRuntimeDisposal::default();
    let (release_tx, release_rx) = oneshot::channel();
    let worker = tokio::spawn(async move {
        release_rx.await.unwrap();
        Ok(())
    });
    let owner_id = worker.id();
    disposal.state.lock().await.worker = Some(worker);
    let mut state = disposal.state.lock().await;
    assert!(state.wait(Duration::from_millis(1)).await.is_err());
    assert!(!state.complete);
    assert_eq!(state.worker.as_ref().unwrap().id(), owner_id);
    release_tx.send(()).unwrap();
    state.wait(Duration::from_secs(1)).await.unwrap();
    assert!(state.complete);
    assert!(state.worker.is_none());
}

#[tokio::test]
async fn transient_input_scan_error_keeps_the_same_native_operation_alive() {
    let (complete_tx, complete_rx) = oneshot::channel();
    let mut complete_tx = Some(complete_tx);
    let scans = std::sync::atomic::AtomicUsize::new(0);
    let result = while_interrupting_inputs(
        async {
            complete_rx.await.unwrap();
            "native acknowledgment"
        },
        || {
            let scan = scans.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let complete = if scan == 1 { complete_tx.take() } else { None };
            async move {
                if scan == 0 {
                    return Err("Temporary exact-input read refusal".into());
                }
                if let Some(complete) = complete {
                    complete.send(()).unwrap();
                }
                Ok(())
            }
        },
    )
    .await;
    assert_eq!(result, "native acknowledgment");
    assert_eq!(scans.load(std::sync::atomic::Ordering::SeqCst), 2);
}
