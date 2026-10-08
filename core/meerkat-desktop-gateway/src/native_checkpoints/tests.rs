use super::*;
use crate::{
    host_tools::HostToolTransport,
    mobkit_registry::{CreateMobInput, ProjectMobkitRegistry},
};
use base64::Engine;
use meerkat_core::{
    types::HandlingMode, Config, ConfigDelta, ConfigStore, HookAdapterConfig, HookEntryConfig,
    HookExecutionMode, HookId, HookPoint, MemoryConfigStore,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        test_bridges().lock().unwrap().remove(&self.0.join("state"));
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn input(root: &std::path::Path) -> CreateMobInput {
    CreateMobInput {
        mob_id: "checkpoint-domain".into(),
        kind: "domain".into(),
        label: "Checkpoint proof".into(),
        role: "domain".into(),
        coordinator_identity: "specialist".into(),
        model: "gpt-5.6-sol".into(), initial_llm: None,
        instructions: "Use the deterministic fixture once per input.".into(),
        thread_id: None,
        include_native_workers: false,
        access_mode: None,
        config_project_path: root.join("project"),
        project_path: root.join("project"),
        state_root: root.join("state"),
        config_state_root: root.join("state"),
    }
}

#[tokio::test]
async fn checkpoint_overlay_is_runtime_only_and_retains_native_user_configuration() {
    let fixture =
        Fixture(std::env::temp_dir().join(format!("checkpoint-overlay-{}", uuid::Uuid::new_v4())));
    let input = input(&fixture.0);
    let bridge = Bridge::new(
        "http://127.0.0.1:12345/native-checkpoint".into(),
        "private-token".into(),
    )
    .unwrap();
    test_bridges()
        .lock()
        .unwrap()
        .insert(input.state_root.clone(), bridge);
    let original: Arc<dyn ConfigStore> = Arc::new(MemoryConfigStore::new(
        Config::default(),
        meerkat_models::canonical(),
    ));
    let overlay = runtime_config_store(original.clone(), &input).unwrap();
    let mut projected = overlay.get().await.unwrap();
    assert_eq!(projected.hooks.entries.len(), 3);
    assert!(projected
        .hooks
        .entries
        .iter()
        .all(|entry| entry.mode == HookExecutionMode::Foreground));
    projected.max_tokens = Some(1777);
    overlay.set(projected).await.unwrap();
    let raw = original.get().await.unwrap();
    assert!(raw.hooks.entries.is_empty());
    assert_eq!(raw.max_tokens, Some(1777));
    let projected = overlay
        .patch(ConfigDelta(json!({"max_tokens":1888})))
        .await
        .unwrap();
    assert_eq!(projected.hooks.entries.len(), 3);
    assert_eq!(original.get().await.unwrap().max_tokens, Some(1888));
    assert!(Bridge::new("https://example.test/checkpoint".into(), "token".into()).is_err());
    assert!(Bridge::new("http://localhost/checkpoint".into(), "token".into()).is_err());
    assert!(Bridge::new("http://127.0.0.1/checkpoint".into(), "bad\nheader".into()).is_err());
}

#[tokio::test]
async fn configured_http_hooks_cannot_project_metadata_for_large_native_inputs() {
    let config = Config::default();
    let mut hooks = config.hooks;
    hooks.entries.push(HookEntryConfig {
        id: HookId::new("checkpoint-payload-boundary-proof"),
        point: HookPoint::RunStarted,
        runtime: HookAdapterConfig::http("http://127.0.0.1:1/unused", "POST", HashMap::new()),
        ..Default::default()
    });
    let engine = meerkat::create_default_hook_engine(hooks).unwrap();
    let error = engine
        .execute(
            meerkat_core::HookInvocation::run_started(
                meerkat_core::SessionId::new(),
                meerkat_core::RunInput::from(meerkat_core::ContentInput::Text(
                    "x".repeat(200 * 1024),
                )),
            ),
            None,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(error, meerkat_core::HookEngineError::ExecutionFailed { ref reason, .. }
        if reason.contains("hook payload exceeds max size")),
        "{error:?}"
    );
}

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
            assert!(request
                .tools
                .iter()
                .any(|tool| tool.name.as_str() == "shell"));
            vec![
                meerkat::LlmEvent::ToolCallComplete {
                    id: format!("checkpoint-write-{count}"),
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
            vec![meerkat::LlmEvent::Done {
                outcome: meerkat::LlmDoneOutcome::Success {
                    stop_reason: meerkat_core::StopReason::EndTurn,
                },
            }]
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

async fn idle_workspace(
    gateway: &crate::MeerkatGateway,
    workspace: &std::path::Path,
) -> WorkspaceStatus {
    let workspace = workspace.canonicalize().unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let status = workspace_status(gateway, &workspace).await;
            if status.status == "idle" {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("native workspace did not become idle")
}

#[test]
fn native_checkpoint_hooks_precede_tools_for_warm_peers_and_restored_sessions() {
    std::thread::Builder::new().stack_size(32 * 1024 * 1024).spawn(|| {
        tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_stack_size(16 * 1024 * 1024).enable_all().build().unwrap().block_on(async {
            let fixture = Fixture(std::env::temp_dir().join(format!("native-checkpoint-{}",uuid::Uuid::new_v4())));
            let input = input(&fixture.0);
            std::fs::create_dir_all(&input.project_path).unwrap();
            std::fs::create_dir_all(&input.state_root).unwrap();
            let realm = crate::mobkit_registry::load_effective_realm_config(&input.config_project_path, &input.config_state_root).await.unwrap();
            let mut config = realm.raw_head;
            config.shell.program = "/bin/sh".into();
            realm.head_store.set(config).await.unwrap();
            let marker = input.project_path.join("effects.txt");
            let events = Arc::new(Mutex::new(Vec::<(Value, usize)>::new()));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let bridge = Bridge::new(format!("http://{}/native-checkpoint",listener.local_addr().unwrap()),"fixture-token".into()).unwrap();
            test_bridges().lock().unwrap().insert(input.state_root.clone(), bridge);
            let (completed_tx, mut completed_rx) = tokio::sync::mpsc::unbounded_channel();
            let expected_scope = serde_json::to_value(Scope { project_path: &input.config_project_path, workspace: &input.project_path, state_root: &input.state_root, mob_id: &input.mob_id }).unwrap();
            let hook_events = events.clone();
            let hook_marker = marker.clone();
            let gateway = crate::MeerkatGateway::new();
            let hook_gateway = gateway.clone();
            let observer_scope = Arc::new(Mutex::new(None::<Value>));
            let hook_observer_scope = observer_scope.clone();
            let server = tokio::spawn(async move {
                loop {
                    let (stream, _) = listener.accept().await.unwrap();
                    let mut incoming = BufReader::new(stream);
                    let mut line = String::new();
                    incoming.read_line(&mut line).await.unwrap();
                    assert_eq!(line, "POST /native-checkpoint HTTP/1.1\r\n");
                    let mut headers = HashMap::new();
                    loop {
                        line.clear(); incoming.read_line(&mut line).await.unwrap();
                        if line == "\r\n" { break; }
                        let (key, value) = line.split_once(':').unwrap();
                        headers.insert(key.to_ascii_lowercase(),value.trim().to_owned());
                    }
                    assert_eq!(headers["authorization"],"Bearer fixture-token");
                    let scope: Value = serde_json::from_slice(&base64::engine::general_purpose::STANDARD.decode(&headers["x-t3-checkpoint-scope"]).unwrap()).unwrap();
                    assert_eq!(scope, expected_scope);
                    let mut body = vec![0; headers["content-length"].parse::<usize>().unwrap()];
                    incoming.read_exact(&mut body).await.unwrap();
                    let invocation: Value = serde_json::from_slice(&body).unwrap();
                    let mut request = scope.clone();
                    request["sessionId"] = invocation["session_id"].clone();
                    let resolved = tokio::time::timeout(Duration::from_secs(2), resolve_scope(&hook_gateway, Some(&request))).await.unwrap().unwrap();
                    assert_eq!(resolved["workspace"], json!(std::fs::canonicalize(scope["workspace"].as_str().unwrap()).unwrap()));
                    assert_eq!(resolved["sessionId"], invocation["session_id"]);
                    if invocation["point"] == "run_started" {
                        let mut safety = hook_observer_scope.lock().unwrap().clone().unwrap();
                        safety["includeWorkspaceStatus"] = json!(true);
                        let observed = resolve_scope(&hook_gateway, Some(&safety)).await.unwrap();
                        assert_eq!(observed["workspaceStatus"], "busy", "a different idle mob must observe this native input, including child turns");
                        assert_eq!(observed["workspaceBusy"], true);
                        assert_eq!(observed["workspaceAdmissionFenced"], false);
                        assert!(!observed["workspaceGeneration"].as_str().unwrap().is_empty());
                    }
                    let mut wrong = request.clone();
                    wrong["sessionId"] = json!(meerkat_core::SessionId::new());
                    assert!(resolve_scope(&hook_gateway, Some(&wrong)).await.is_err());
                    wrong = request;
                    wrong["workspace"] = json!("/different-workspace");
                    assert!(resolve_scope(&hook_gateway, Some(&wrong)).await.is_err());
                    let effects = std::fs::read_to_string(&hook_marker).unwrap_or_default().lines().count();
                    let completed = invocation["point"] == "run_completed";
                    assert_ne!(invocation["point"], "run_failed", "native run failed: {invocation}");
                    hook_events.lock().unwrap().push((invocation, effects));
                    incoming.get_mut().write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await.unwrap();
                    incoming.get_mut().shutdown().await.unwrap();
                    if completed { completed_tx.send(()).unwrap(); }
                }
            });
            let llm = Arc::new(EditOncePerRun { calls: AtomicUsize::new(0), marker: marker.clone() });
            let registry = Arc::new(ProjectMobkitRegistry::new_with_test_llm(HostToolTransport::new(),llm.clone()));
            gateway.inner.mobkit_registries.lock().await.insert(input.state_root.canonicalize().unwrap(),registry.clone());
            let mob = registry.create_local(input.clone()).await.unwrap();
            let mut observer_input = input.clone();
            observer_input.mob_id = "checkpoint-observer".into();
            observer_input.coordinator_identity = "observer".into();
            let observer = registry.create_local(observer_input.clone()).await.unwrap();
            let observer_session = observer.runtime.as_ref().unwrap().mob_handle().resolve_bridge_session_id(&"observer".into()).await.unwrap();
            *observer_scope.lock().unwrap() = Some(json!({
                "projectPath":input.config_project_path,"workspace":input.project_path,
                "stateRoot":input.state_root,"mobId":observer_input.mob_id,"sessionId":observer_session
            }));
            let runtime = mob.runtime.as_ref().unwrap();
            let session = runtime.mob_handle().resolve_bridge_session_id(&"specialist".into()).await.unwrap();
            wire_sender(runtime).await;
            for peer in [false,true] {
                if peer {
                    runtime.mob_handle().send_peer_message("sender".into(),"specialist".into(),"Warm peer episode",HandlingMode::Queue).await.unwrap();
                } else { crate::mobkit_registry::send_to_member(runtime,"specialist","Explicit episode",HandlingMode::Queue).await.unwrap(); }
                tokio::time::timeout(Duration::from_secs(20),completed_rx.recv()).await.unwrap().unwrap();
                settled(runtime,&session).await;
            }
            let before_restart = idle_workspace(&gateway, &input.project_path).await;
            let first_incarnation = mob.checkpoint_incarnation;
            assert!(registry.shutdown().await.is_empty());
            drop(observer); drop(mob); drop(registry);
            let registry = Arc::new(ProjectMobkitRegistry::new_with_test_llm(HostToolTransport::new(),llm.clone()));
            gateway.inner.mobkit_registries.lock().await.insert(input.state_root.canonicalize().unwrap(),registry.clone());
            let mob = registry.create_local(input.clone()).await.unwrap();
            let runtime = mob.runtime.as_ref().unwrap();
            assert_eq!(runtime.mob_handle().resolve_bridge_session_id(&"specialist".into()).await.unwrap(),session);
            assert_eq!(llm.calls.load(Ordering::SeqCst),4,"restoring must not invoke the model");
            let observer = registry.create_local(observer_input).await.unwrap();
            assert_eq!(observer.runtime.as_ref().unwrap().mob_handle().resolve_bridge_session_id(&"observer".into()).await.unwrap(), observer_session);
            assert_ne!(mob.checkpoint_incarnation, first_incarnation);
            wire_sender(runtime).await;
            let after_restart = idle_workspace(&gateway, &input.project_path).await;
            assert_ne!(before_restart.generation, after_restart.generation, "runtime replacement must invalidate restore witnesses");
            for peer in [false,true] {
                if peer { runtime.mob_handle().send_peer_message("sender".into(),"specialist".into(),"Restored warm peer episode",HandlingMode::Queue).await.unwrap(); }
                else { crate::mobkit_registry::send_to_member(runtime,"specialist","Restored explicit episode",HandlingMode::Queue).await.unwrap(); }
                tokio::time::timeout(Duration::from_secs(20),completed_rx.recv()).await.unwrap().unwrap();
                settled(runtime,&session).await;
            }
            let before_child = idle_workspace(&gateway, &input.project_path).await;
            let state = runtime.mob_runtime().agent_mob_mcp_state().unwrap();
            let child_id = meerkat_mob::MobId::from("checkpoint-child");
            let definition: meerkat_mob::MobDefinition = serde_json::from_value(json!({
                "id":child_id,"profiles":{"worker":{
                    "model":"gpt-5.6-sol","runtime_mode":"turn_driven",
                    "tools":{"builtins":true,"shell":true,"comms":true}
                }}
            })).unwrap();
            state.mob_create_definition_with_owner_bridge_session(definition,session.clone(),true,false).await.unwrap();
            let child = state.mob_handles_snapshot().await.unwrap().into_iter().find(|(id,_)|id==&child_id).unwrap().1;
            let spawn = meerkat_mob::SpawnMemberSpec::new("worker","checkpoint-worker")
                .with_runtime_mode(meerkat_mob::MobRuntimeMode::TurnDriven)
                .with_initial_message("Child fixture episode");
            child.spawn_spec_with_generated_owner_context(spawn,session.clone()).await.unwrap();
            tokio::time::timeout(Duration::from_secs(20),completed_rx.recv()).await.unwrap().unwrap();
            let child_session = child.resolve_bridge_session_id(&"checkpoint-worker".into()).await.unwrap();
            settled(runtime,&child_session).await;
            let after_child = idle_workspace(&gateway, &input.project_path).await;
            assert_ne!(before_child.generation, after_child.generation, "a new native child must invalidate restore witnesses");
            assert_eq!(llm.calls.load(Ordering::SeqCst),10);
            assert_eq!(std::fs::read_to_string(&marker).unwrap().lines().count(),5);
            let actual = events.lock().unwrap().clone();
            assert_eq!(actual.len(),10);
            for (index, pair) in actual.chunks_exact(2).enumerate() {
                assert_eq!(pair[0].0["point"],"run_started");
                assert_eq!(pair[0].1,index,"baseline must precede the native tool effect");
                assert_eq!(pair[1].0["point"],"run_completed");
                assert_eq!(pair[1].1,index+1,"completion must follow the awaited tool effect");
                let expected_session = if index < 4 { &session } else { &child_session };
                assert_eq!(pair[0].0["session_id"],json!(expected_session));
                assert_eq!(pair[1].0["session_id"],json!(expected_session));
            }
            use meerkat_runtime::SessionServiceRuntimeExt as _;
            observer.session_runtime.as_ref().unwrap().retire_runtime(&observer_session).await.unwrap();
            let retired = workspace_status(&gateway, &input.project_path.canonicalize().unwrap()).await;
            assert_ne!(retired.status, "idle", "retired sessions must not disappear from the restore safety observation");
            assert!(registry.shutdown().await.is_empty());
            assert!(resolve_scope(&gateway, observer_scope.lock().unwrap().as_ref()).await.is_err(), "reads must not recreate unloaded runtimes");
            server.abort(); let _=server.await;
        });
    }).unwrap().join().unwrap();
}
