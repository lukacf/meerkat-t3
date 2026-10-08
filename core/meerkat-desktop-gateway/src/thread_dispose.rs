use std::{
    collections::HashSet,
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use meerkat_mob::{MobError, MobHandle, MobMachineStateChanges};
use meerkat_mobkit::UnifiedRuntime;
use meerkat_runtime::SessionServiceRuntimeExt;
use tokio::{sync::Mutex, task::JoinHandle};

const CALLER_WAIT: Duration = Duration::from_secs(60);
const INPUT_RECHECK: Duration = Duration::from_millis(100);

async fn interrupt_owned_inputs(
    runtime: &UnifiedRuntime,
    handle: &MobHandle,
) -> Result<(), String> {
    let adapter = runtime
        .mob_runtime()
        .session_service()
        .and_then(|service| service.runtime_adapter())
        .ok_or("Owned native mob cleanup requires its session runtime")?;

    // Resolve identities through native session-binding authority. Retained
    // structural roster rows are not live bindings, and independent runtimes
    // are never included. Cancellation revalidates each exact input/driver.
    for member in handle.list_all_members().await {
        let Some(session) = handle
            .resolve_bridge_session_id(&member.agent_identity)
            .await
        else {
            continue;
        };
        if !adapter.contains_session(&session).await {
            continue;
        }
        let inputs = adapter
            .list_active_inputs(&session)
            .await
            .map_err(|error| format!("Cannot read owned inputs during cleanup: {error}"))?;
        for input in inputs {
            adapter
                .cancel_input_if_present(&session, &input, "Owning thread is closing")
                .await
                .map_err(|error| format!("Cannot interrupt owned input during cleanup: {error}"))?;
        }
    }
    Ok(())
}

/// Keep the same native lifecycle future alive while exact input cancellation
/// converges. An empty scan is not an admission fence: child producers and peer
/// deliveries may still admit work until native Shutdown closes them.
async fn while_interrupting<T>(
    runtime: &UnifiedRuntime,
    handle: &MobHandle,
    operation: impl Future<Output = T>,
) -> T {
    while_interrupting_inputs(operation, || interrupt_owned_inputs(runtime, handle)).await
}

async fn while_interrupting_inputs<T, F, I>(
    operation: impl Future<Output = T>,
    mut interrupt: F,
) -> T
where
    F: FnMut() -> I,
    I: Future<Output = Result<(), String>>,
{
    tokio::pin!(operation);
    let mut last_error = None;
    loop {
        let scan = interrupt();
        tokio::pin!(scan);
        tokio::select! {
            result = &mut operation => {
                // Join the exact interruption already in flight before this
                // cleanup owner exits. Native closure remains authoritative.
                let _ = scan.await;
                return result;
            },
            result = &mut scan => {
                match result {
                    Err(error) => {
                        if last_error.as_ref() != Some(&error) {
                            tracing::warn!(%error, "Owned input cleanup is incomplete; native shutdown remains in progress");
                        }
                        last_error = Some(error);
                    }
                    Ok(()) => last_error = None,
                }
            }
        }
        // A transient scan/interrupt refusal cannot cancel native Shutdown.
        // Its own acknowledgment is the completion authority, not this loop.
        tokio::select! {
            result = &mut operation => return result,
            _ = tokio::time::sleep(INPUT_RECHECK) => {}
        }
    }
}

async fn shutdown_actor(runtime: &UnifiedRuntime, handle: &MobHandle) -> Result<(), String> {
    let mut changes = handle.machine_state_changes();
    while_interrupting(runtime, handle, async {
        handle
            .shutdown()
            .await
            .map_err(|error| format!("Native mob cleanup did not complete: {error}"))?;
        while !changes.is_closed() {
            if changes.changed().await.is_err() {
                break;
            }
        }
        Ok(())
    })
    .await
}

/// One retained cleanup owner per embedded runtime. A caller wait can expire,
/// but it cannot drop or replace the ongoing native lifecycle operation.
#[derive(Default)]
pub(crate) struct NativeRuntimeDisposal {
    started: AtomicBool,
    state: Mutex<DisposalTask>,
    progress: Arc<Mutex<DisposalProgress>>,
}

#[derive(Default)]
struct DisposalTask {
    worker: Option<JoinHandle<Result<(), String>>>,
    complete: bool,
    failed_task: Option<String>,
}

#[derive(Default)]
struct DisposalProgress {
    runtime_phases_completed: bool,
    parent_closed: bool,
    children_closed: HashSet<String>,
}

impl NativeRuntimeDisposal {
    /// Latch removal intent before any console/scheduler/native cleanup await.
    /// This entry remains the retry owner, but it can never be reused for work.
    pub(crate) fn begin(&self) {
        self.started.store(true, Ordering::Release);
    }

    pub(crate) fn has_started(&self) -> bool {
        self.started.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) async fn pause_worker_for_test(&self) -> impl Drop + '_ {
        self.progress.lock().await
    }

    #[cfg(test)]
    pub(crate) async fn shutdown_with_wait_for_test(
        &self,
        runtime: &Arc<UnifiedRuntime>,
        wait: Duration,
    ) -> Result<(), String> {
        self.shutdown_with_wait(runtime, wait).await
    }

    pub(crate) async fn shutdown(&self, runtime: &Arc<UnifiedRuntime>) -> Result<(), String> {
        self.shutdown_with_wait(runtime, CALLER_WAIT).await
    }

    async fn shutdown_with_wait(
        &self,
        runtime: &Arc<UnifiedRuntime>,
        wait: Duration,
    ) -> Result<(), String> {
        self.begin();
        let mut state = self.state.lock().await;
        if state.complete {
            return Ok(());
        }
        if let Some(error) = state.failed_task.as_ref() {
            return Err(error.clone());
        }
        if state.worker.is_none() {
            let runtime = Arc::clone(runtime);
            let progress = Arc::clone(&self.progress);
            state.worker = Some(tokio::spawn(async move {
                dispose_runtime(&runtime, &mut *progress.lock().await).await
            }));
        }
        state.wait(wait).await
    }
}

impl DisposalTask {
    async fn wait(&mut self, wait: Duration) -> Result<(), String> {
        match tokio::time::timeout(wait, self.worker.as_mut().expect("cleanup owner")).await {
            Err(_) => Err("Native cleanup is still running; its retained owner will continue. Retry to observe completion.".into()),
            Ok(Ok(result)) => {
                self.worker.take();
                self.complete = result.is_ok();
                result
            }
            Ok(Err(error)) => {
                self.worker.take();
                let error = format!("Native cleanup task failed before proving completion: {error}");
                self.failed_task = Some(error.clone());
                Err(error)
            }
        }
    }
}

async fn finish_parent_shutdown(
    changes: &mut MobMachineStateChanges,
    result: Result<(), MobError>,
) -> Result<(), String> {
    match result {
        Ok(())
        | Err(MobError::ActorCommandChannelClosed | MobError::ActorReplyChannelClosed) => {
            // This parent-only path follows acknowledged UnifiedRuntime phases.
            // Its own successful Shutdown can return before the actor drops
            // every field. A redundant command can find ingress closed, or be
            // queued before exit and lose its reply when the receiver drops.
            // Neither channel error nor time is success: still await actual
            // actor exit through this exact actor's publication sender.
            while !changes.is_closed() {
                if changes.changed().await.is_err() {
                    break;
                }
            }
            Ok(())
        }
        Err(error) => Err(format!("Native parent cleanup did not complete: {error}")),
    }
}

async fn finish_parent_actor(
    runtime: &UnifiedRuntime,
    parent: &MobHandle,
    progress: &mut DisposalProgress,
) -> Result<(), String> {
    if !progress.parent_closed {
        // MobKit 0.8.44 can report successful runtime phases after a final
        // actor refusal. Their acknowledgment and actor closure are distinct.
        // Redrive only the retained public actor when those phases are done.
        let mut changes = parent.machine_state_changes();
        if !changes.is_closed() {
            while_interrupting(runtime, parent, async {
                let result = parent.shutdown().await;
                finish_parent_shutdown(&mut changes, result).await
            })
            .await?;
        }
        progress.parent_closed = true;
    }
    Ok(())
}

async fn dispose_runtime(
    runtime: &UnifiedRuntime,
    progress: &mut DisposalProgress,
) -> Result<(), String> {
    let parent = runtime.mob_handle();
    let parent_id = parent.mob_id().clone();
    if !progress.runtime_phases_completed {
        let report = while_interrupting(runtime, &parent, runtime.shutdown()).await;
        if !report.cleanup_completed() {
            return Err(format!(
                "MobKit parent cleanup did not complete: {report:?}"
            ));
        }
        progress.runtime_phases_completed = true;
    }
    finish_parent_actor(runtime, &parent, progress).await?;

    // Agent-created mobs have their own actors. This is the exact set composed
    // for this runtime, never independent project agents or sibling threads.
    let Some(children) = runtime.mob_runtime().agent_mob_mcp_state() else {
        return Ok(());
    };
    loop {
        let handles = children
            .mob_handles_snapshot()
            .await
            .map_err(|error| format!("Cannot enumerate owned native mobs for cleanup: {error}"))?;
        let mut closed_any = false;
        for (id, handle) in handles {
            if id == parent_id {
                continue;
            }
            if progress.children_closed.contains(id.as_str())
                && handle.machine_state_changes().is_closed()
            {
                continue;
            }
            // Destroy would also remove history. A refusal retains the actor
            // and this runtime's registry entry for an authoritative retry.
            shutdown_actor(runtime, &handle)
                .await
                .map_err(|error| format!("Native child mob {id}: {error}"))?;
            progress.children_closed.insert(id.to_string());
            closed_any = true;
        }
        if !closed_any {
            return Ok(());
        }
        // A child can create another mob before native shutdown fences ingress.
        // Re-read the native set after each wave of acknowledged actor exits.
    }
}

#[cfg(test)]
mod tests;
