use std::{future::Future, pin::Pin};

use tokio::task::JoinHandle;

/// Keep the join in its owner while a removal caller waits or is cancelled.
pub(super) struct RetainedTask {
    name: &'static str,
    handle: Option<JoinHandle<()>>,
    outcome: Option<Result<(), String>>,
    abort_requested: bool,
}

impl RetainedTask {
    pub(super) fn new(name: &'static str, handle: JoinHandle<()>) -> Self {
        Self {
            name,
            handle: Some(handle),
            outcome: None,
            abort_requested: false,
        }
    }

    pub(super) async fn abort_and_join(&mut self) -> Result<(), String> {
        if let Some(handle) = self.handle.as_ref() {
            self.abort_requested = true;
            handle.abort();
        }
        self.join().await
    }

    pub(super) async fn join(&mut self) -> Result<(), String> {
        if let Some(outcome) = self.outcome.as_ref() {
            return outcome.clone();
        }
        let handle = self.handle.as_mut().expect("retained background task");
        let outcome = match handle.await {
            Ok(()) => Ok(()),
            Err(error) if self.abort_requested && error.is_cancelled() => Ok(()),
            Err(error) => Err(format!("{} task failed: {error}", self.name)),
        };
        // There is no await between observing completion and recording it.
        // Retrying must neither lose a failure nor poll a completed JoinHandle.
        self.handle.take();
        self.outcome = Some(outcome.clone());
        outcome
    }

    #[cfg(test)]
    pub(super) fn joined_successfully(&self) -> bool {
        self.handle.is_none() && self.outcome.as_ref().is_some_and(Result::is_ok)
    }
}

impl Drop for RetainedTask {
    fn drop(&mut self) {
        // A cancelled bootstrap has no registry entry to retain this owner.
        // At least stop its leaf observer instead of detaching an endless task.
        if let Some(handle) = self.handle.as_ref() {
            handle.abort();
        }
    }
}

enum ShutdownState {
    Running(Pin<Box<dyn Future<Output = ()> + Send + 'static>>),
    Stopping(JoinHandle<()>),
    Completed(Result<(), String>),
}

/// ScheduleHostHandle::shutdown consumes its handle. Transfer it to a retained
/// worker before the first await so cancellation cannot detach its supervisor.
pub(super) struct RetainedShutdown {
    name: &'static str,
    state: ShutdownState,
}

impl RetainedShutdown {
    pub(super) fn new(
        name: &'static str,
        shutdown: impl Future<Output = ()> + Send + 'static,
    ) -> Self {
        Self {
            name,
            state: ShutdownState::Running(Box::pin(shutdown)),
        }
    }

    pub(super) async fn shutdown(&mut self) -> Result<(), String> {
        let state = std::mem::replace(&mut self.state, ShutdownState::Completed(Ok(())));
        self.state = match state {
            ShutdownState::Running(shutdown) => ShutdownState::Stopping(tokio::spawn(shutdown)),
            state => state,
        };
        let outcome = match &mut self.state {
            ShutdownState::Stopping(worker) => worker
                .await
                .map_err(|error| format!("{} shutdown task failed: {error}", self.name)),
            ShutdownState::Completed(outcome) => return outcome.clone(),
            ShutdownState::Running(_) => unreachable!("shutdown worker installed before await"),
        };
        self.state = ShutdownState::Completed(outcome.clone());
        outcome
    }

    #[cfg(test)]
    pub(super) fn joined_successfully(&self) -> bool {
        matches!(&self.state, ShutdownState::Completed(Ok(())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::sync::{oneshot, Mutex};

    #[tokio::test]
    async fn cancelling_a_shutdown_wait_retains_the_same_worker_for_retry() {
        let (entered, started) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let calls = Arc::new(AtomicUsize::new(0));
        let worker_calls = Arc::clone(&calls);
        let owner = Arc::new(Mutex::new(RetainedShutdown::new("scheduler", async move {
            worker_calls.fetch_add(1, Ordering::SeqCst);
            entered.send(()).unwrap();
            released.await.unwrap();
        })));
        let waiting_owner = Arc::clone(&owner);
        let caller = tokio::spawn(async move { waiting_owner.lock().await.shutdown().await });
        started.await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert!(!owner.lock().await.joined_successfully());
        release.send(()).unwrap();
        owner.lock().await.shutdown().await.unwrap();
        assert!(owner.lock().await.joined_successfully());
        owner.lock().await.shutdown().await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancelling_a_drain_join_keeps_its_handle_for_retry() {
        let (release, released) = oneshot::channel();
        let owner = Arc::new(Mutex::new(RetainedTask::new(
            "drain",
            tokio::spawn(async move { released.await.unwrap() }),
        )));
        let (joining, waiting) = oneshot::channel();
        let waiting_owner = Arc::clone(&owner);
        let caller = tokio::spawn(async move {
            let mut owner = waiting_owner.lock().await;
            joining.send(()).unwrap();
            owner.join().await
        });
        waiting.await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert!(!owner.lock().await.joined_successfully());
        release.send(()).unwrap();
        owner.lock().await.join().await.unwrap();
        assert!(owner.lock().await.joined_successfully());
        owner.lock().await.join().await.unwrap();
    }

    #[tokio::test]
    async fn abort_and_join_waits_for_the_observer_to_drop() {
        struct NotifyDrop(Option<oneshot::Sender<()>>);
        impl Drop for NotifyDrop {
            fn drop(&mut self) {
                self.0.take().unwrap().send(()).unwrap();
            }
        }
        let (entered, started) = oneshot::channel();
        let (dropped, mut observed_drop) = oneshot::channel();
        let mut owner = RetainedTask::new(
            "watchdog",
            tokio::spawn(async move {
                let _notify = NotifyDrop(Some(dropped));
                entered.send(()).unwrap();
                std::future::pending::<()>().await;
            }),
        );
        started.await.unwrap();
        owner.abort_and_join().await.unwrap();
        assert_eq!(observed_drop.try_recv(), Ok(()));
        assert!(owner.joined_successfully());
    }

    #[tokio::test]
    async fn retry_preserves_an_unexpected_join_failure_without_repolling() {
        let task = tokio::spawn(std::future::pending::<()>());
        task.abort();
        let mut owner = RetainedTask::new("drain", task);
        let failure = owner.join().await.unwrap_err();
        assert_eq!(owner.join().await.unwrap_err(), failure);
        assert!(!owner.joined_successfully());
    }
}
