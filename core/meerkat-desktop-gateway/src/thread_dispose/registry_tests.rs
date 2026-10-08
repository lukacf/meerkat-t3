use super::*;
use std::{future::Future, path::PathBuf};

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct UnusedProvider;
#[async_trait::async_trait]
impl meerkat::LlmClient for UnusedProvider {
    fn project_replay_messages(
        &self,
        messages: &[meerkat_core::Message],
    ) -> Result<Vec<meerkat_core::Message>, meerkat::LlmError> {
        Ok(messages.to_vec())
    }
    fn stream<'a>(
        &'a self,
        _: &'a meerkat::LlmRequest,
    ) -> std::pin::Pin<
        Box<
            dyn futures_util::Stream<Item = Result<meerkat::LlmEvent, meerkat::LlmError>>
                + Send
                + 'a,
        >,
    > {
        panic!("idle disposal fixture must not invoke a provider")
    }
    fn provider(&self) -> meerkat_core::Provider {
        meerkat_core::Provider::Other
    }
    async fn health_check(&self) -> Result<(), meerkat::LlmError> {
        Ok(())
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
async fn fixture() -> (
    Fixture,
    CreateMobInput,
    Arc<ProjectMobkitRegistry>,
    Arc<MobkitMobRuntime>,
) {
    let fixture =
        Fixture(std::env::temp_dir().join(format!("disposal-admission-{}", uuid::Uuid::new_v4())));
    let input = CreateMobInput {
        mob_id: fixture
            .0
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        kind: "thread".into(),
        label: "Disposal admission proof".into(),
        role: "coordinator".into(),
        coordinator_identity: "ingress".into(),
        model: "gpt-5.6-sol".into(), initial_llm: None,
        instructions: "Idle lifecycle fixture".into(),
        thread_id: Some("disposal-thread".into()),
        include_native_workers: false,
        access_mode: None,
        config_project_path: fixture.0.join("project"),
        project_path: fixture.0.join("project"),
        state_root: fixture.0.join("state"),
        config_state_root: fixture.0.join("state"),
    };
    std::fs::create_dir_all(&input.project_path).unwrap();
    std::fs::create_dir_all(&input.state_root).unwrap();
    let registry = Arc::new(ProjectMobkitRegistry::new_with_test_llm(
        HostToolTransport::new(),
        Arc::new(UnusedProvider),
    ));
    let mob = registry.create_local(input.clone()).await.unwrap();
    (fixture, input, registry, mob)
}
async fn assert_reconnect_refused(
    registry: &ProjectMobkitRegistry,
    input: &CreateMobInput,
    original: &Arc<MobkitMobRuntime>,
) {
    let result = tokio::time::timeout(Duration::from_secs(2), registry.create_local(input.clone()))
        .await
        .unwrap();
    assert!(
        result.is_err(),
        "a retained cleanup owner must not be reused for work"
    );
    assert!(
        Arc::ptr_eq(&registry.get(&input.mob_id).await.unwrap(), original),
        "retain the original native owner for removal retry"
    );
}

#[test]
fn canceled_removal_before_schedule_cleanup_cannot_reconnect() {
    run(async {
        let (_fixture, input, registry, mob) = fixture().await;
        let runtime = mob.runtime.as_ref().unwrap();
        // Stop remove at its first cleanup await, before native shutdown starts.
        let schedule_guard = mob.schedule_host.as_ref().unwrap().lock().await;
        let remove_registry = registry.clone();
        let id = input.mob_id.clone();
        let caller = tokio::spawn(async move { remove_registry.remove(&id).await });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !mob.disposal.has_started() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert!(
            !runtime.mob_handle().machine_state_changes().is_closed(),
            "test cancellation precedes native cleanup"
        );
        assert_reconnect_refused(&registry, &input, &mob).await;
        drop(schedule_guard);
        assert!(
            tokio::time::timeout(Duration::from_secs(15), registry.remove(&input.mob_id))
                .await
                .unwrap()
                .unwrap()
        );
        assert!(runtime.mob_handle().machine_state_changes().is_closed());
        assert!(registry.get(&input.mob_id).await.is_none());
    });
}

#[test]
fn timed_out_cleanup_and_completed_worker_both_refuse_reconnect_until_removal_retry() {
    run(async {
        let (_fixture, input, registry, mob) = fixture().await;
        let runtime = mob.runtime.as_ref().unwrap();
        // Pause the actual retained worker at its progress lock. This affects
        // no native authority and makes caller timeout deterministic.
        let worker_gate = mob.disposal.pause_worker_for_test().await;
        let pending = mob
            .disposal
            .shutdown_with_wait_for_test(runtime, Duration::from_millis(1))
            .await;
        assert!(pending.is_err());
        assert_reconnect_refused(&registry, &input, &mob).await;
        let mut changes = runtime.mob_handle().machine_state_changes();
        drop(worker_gate);
        tokio::time::timeout(Duration::from_secs(15), async {
            while !changes.is_closed() {
                if changes.changed().await.is_err() {
                    break;
                }
            }
        })
        .await
        .unwrap();
        // Observe the same worker's successful result without removing the
        // registry entry. Completed cleanup still cannot resurrect that entry.
        mob.disposal
            .shutdown_with_wait_for_test(runtime, Duration::from_secs(15))
            .await
            .unwrap();
        assert_reconnect_refused(&registry, &input, &mob).await;
        assert!(registry.remove(&input.mob_id).await.unwrap());
        assert!(registry.get(&input.mob_id).await.is_none());
    });
}
