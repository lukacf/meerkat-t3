//! Fault evidence for the consumer's cold-recovery fence. No production API.
#[cfg(unix)]
mod tests {
    use crate::{mobkit_registry::ProjectMobkitRegistry, MeerkatGateway};
    use meerkat_desktop_contracts::{RequestContext, RpcRequest};
    use serde_json::{json, Value};
    use std::{
        path::{Path, PathBuf},
        process::{Child, Command, Stdio},
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    const TOOL_SCRIPT: &str = r#"import json, os, pathlib, signal, socket, sys
root = pathlib.Path(sys.argv[1])
escape = sys.argv[2] == 'escape'
original_group = os.getpgrp()
signal.alarm(90)
if escape:
    child = os.fork()
    if child:
        os.waitpid(child, 0)
        sys.exit(0)
    os.setsid()
    signal.alarm(12)
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
    connection.settimeout(60)
    connection.connect(str(root / 'probe.sock'))
    connection.sendall((json.dumps({'pid': os.getpid(), 'parent': os.getppid(), 'group': os.getpgrp(), 'original_group': original_group}) + '\n').encode())
    with connection.makefile('rb') as incoming:
        for line in incoming:
            if line == b'effect\n':
                with (root / 'effect.txt').open('a') as output:
                    output.write('effect after gateway death\n')
                    output.flush()
                    os.fsync(output.fileno())
                connection.sendall(b'effect-committed\n')
            elif line == b'finish\n':
                connection.sendall(b'finished\n')
                break
"#;

    struct ShellOnce {
        command: String,
        calls: AtomicUsize,
    }
    #[async_trait::async_trait]
    impl meerkat::LlmClient for ShellOnce {
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
            let events = if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                assert!(request
                    .tools
                    .iter()
                    .any(|tool| tool.name.as_str() == "shell"));
                vec![
                    meerkat::LlmEvent::ToolCallComplete {
                        id: "containment-shell-call".into(),
                        name: "shell".into(),
                        args: json!({"command":self.command,"timeout_secs":20}),
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
                        delta: "Recovery successor complete.".into(),
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

    async fn rpc(gateway: &MeerkatGateway, method: &str, params: Value) -> Value {
        let response = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".into(),
                    id: None,
                    method: method.into(),
                    params: Some(params),
                },
                RequestContext::local(),
            )
            .await;
        assert!(response.error.is_none(), "{method}: {:?}", response.error);
        response.result.unwrap()
    }
    fn scope(root: &Path) -> Value {
        json!({"projectPath":root.join("project"),"stateRoot":root.join("state"),
            "threadId":"containment-thread","mobId":"containment-mob","runId":"crash-tool-operation"})
    }
    fn quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    #[test]
    fn native_gateway_child() {
        let Some(root) = std::env::var_os("T3_NATIVE_CONTAINMENT_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let python = std::env::var("T3_NATIVE_CONTAINMENT_PYTHON").unwrap();
        let kind = std::env::var("T3_NATIVE_CONTAINMENT_KIND").unwrap();
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_stack_size(16 * 1024 * 1024)
            .build()
            .unwrap()
            .block_on(async move {
                let project = root.join("project");
                let state = root.join("state");
                let realm = crate::mobkit_registry::load_effective_realm_config(&project, &state)
                    .await
                    .unwrap();
                let mut config = realm.raw_head;
                config.shell.program = "/bin/sh".into();
                realm.head_store.set(config).await.unwrap();
                let command = format!(
                    "exec {} {} {} {}",
                    quote(&python),
                    quote(root.join("tool.py").to_str().unwrap()),
                    quote(root.to_str().unwrap()),
                    quote(&kind)
                );
                let gateway = MeerkatGateway::new();
                let handle = gateway
                    .project_runtime_handle_for_paths(
                        project.to_str().unwrap(),
                        project.to_str().unwrap(),
                        "local".into(),
                        Some(state.to_str().unwrap()),
                    )
                    .await
                    .unwrap();
                handle.state.lock().await.mobkit =
                    Arc::new(ProjectMobkitRegistry::new_with_test_llm(
                        Arc::clone(&gateway.inner.host_tools),
                        Arc::new(ShellOnce {
                            command,
                            calls: AtomicUsize::new(0),
                        }),
                    ));
                let mut params = scope(&root);
                params["model"] = json!("gpt-5.6-sol");
                params["ingressAgentIdentity"] = json!("ingress");
                params["includeNativeWorkers"] = json!(false);
                rpc(&gateway, "mobs.v1.createThreadMob", params.clone()).await;
                params["input"] = json!("Execute the deterministic shell fixture once.");
                rpc(&gateway, "mobs.v1.turnStart", params).await;
                std::future::pending::<()>().await;
            });
    }

    struct OwnedGateway(Child);
    impl Drop for OwnedGateway {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn legacy_submission_stays_fenced_after_gateway_sigkill() {
        // Every fixture process self-expires and exits when its private socket
        // closes. The test only signals the gateway Child captured at spawn.
        tokio::runtime::Builder::new_multi_thread().enable_all()
            .thread_stack_size(16 * 1024 * 1024).build().unwrap().block_on(async {
            let python = Command::new("/usr/bin/which").arg("python3").output().unwrap();
            assert!(python.status.success());
            let python = String::from_utf8(python.stdout).unwrap().trim().to_owned();
            for kind in ["direct", "escape"] {
                let fixture = Fixture(PathBuf::from("/tmp").join(format!("t3-containment-{}", uuid::Uuid::new_v4())));
                let root = &fixture.0;
                std::fs::create_dir_all(root.join("project")).unwrap();
                std::fs::create_dir_all(root.join("state")).unwrap();
                std::fs::write(root.join("tool.py"), TOOL_SCRIPT).unwrap();
                let listener = tokio::net::UnixListener::bind(root.join("probe.sock")).unwrap();
                let stderr = std::fs::File::create(root.join("gateway.log")).unwrap();
                let mut gateway = OwnedGateway(Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "native_containment_probe::tests::native_gateway_child", "--nocapture"])
                    .env("T3_NATIVE_CONTAINMENT_ROOT", root)
                    .env("T3_NATIVE_CONTAINMENT_PYTHON", &python)
                    .env("T3_NATIVE_CONTAINMENT_KIND", kind)
                    .stdout(Stdio::null()).stderr(stderr).spawn().unwrap());
                let connected = tokio::time::timeout(Duration::from_secs(30), listener.accept()).await;
                assert!(connected.is_ok(), "native tool did not connect ({kind}): {}", std::fs::read_to_string(root.join("gateway.log")).unwrap());
                let (stream, _) = connected.unwrap().unwrap();
                let (read, mut write) = stream.into_split();
                let mut incoming = BufReader::new(read).lines();
                let identity: Value = serde_json::from_str(&incoming.next_line().await.unwrap().unwrap()).unwrap();
                assert_eq!(identity["pid"], identity["group"], "fixture process is its own group leader");
                if kind == "escape" {
                    assert_ne!(identity["group"], identity["original_group"], "setsid descendant escapes the native shell group");
                } else {
                    assert_eq!(identity["parent"].as_u64(), Some(gateway.0.id() as u64), "native tool was spawned by the owned gateway");
                }
                gateway.0.kill().unwrap();
                assert!(!gateway.0.wait().unwrap().success());
                // Old submission records lack custody provenance. Even if a
                // newer runtime happens to find process records, the consumer
                // must not treat that as coverage of an older host's tools.
                let journal = std::fs::read_dir(root.join("state/thread-recovery")).unwrap()
                    .map(|entry| entry.unwrap().path())
                    .find(|path| path.extension().is_some_and(|ext| ext == "json")).unwrap();
                let mut legacy: Value = serde_json::from_slice(&std::fs::read(&journal).unwrap()).unwrap();
                legacy.as_object_mut().unwrap().remove("nativeCustodyVersion");
                std::fs::write(journal, serde_json::to_vec(&legacy).unwrap()).unwrap();
                // A still-open, exact fixture socket is the ownership witness;
                // no numeric PID is inspected or signalled after the crash.
                write.write_all(b"effect\n").await.unwrap();
                assert_eq!(tokio::time::timeout(Duration::from_secs(3), incoming.next_line()).await.unwrap().unwrap().as_deref(), Some("effect-committed"));
                assert_eq!(std::fs::read_to_string(root.join("effect.txt")).unwrap(), "effect after gateway death\n");
                let cold = MeerkatGateway::new();
                let params = scope(root);
                let status = cold.mobs_run_status(Some(&params)).await.unwrap();
                assert_eq!(status["status"], "unknown");
                assert_eq!(status["canRecover"], false);
                assert!(cold.mobs_recover_thread(Some(&params)).await.is_err());
                assert!(crate::thread_recovery::reserve(&root.join("state"), params.as_object().unwrap(), "new-operation", &crate::thread_recovery::gateway_owner(&cold)).is_err());
                assert_eq!(std::fs::read_to_string(root.join("effect.txt")).unwrap().lines().count(), 1, "recovery must never replay the external effect");
                write.write_all(b"finish\n").await.unwrap();
                assert_eq!(tokio::time::timeout(Duration::from_secs(3), incoming.next_line()).await.unwrap().unwrap().as_deref(), Some("finished"));
                assert!(tokio::time::timeout(Duration::from_secs(3), incoming.next_line()).await.unwrap().unwrap().is_none());
                eprintln!("native containment fault proof ({kind}): gateway killed; tool committed one effect afterwards; recovery and new admission fenced; fixture drained");
            }
        });
    }

    #[test]
    fn native_custody_recovers_original_thread_without_replaying_interrupted_shell() {
        tokio::runtime::Builder::new_multi_thread().enable_all()
            .thread_stack_size(16 * 1024 * 1024).build().unwrap().block_on(async {
            let python = Command::new("/usr/bin/which").arg("python3").output().unwrap();
            assert!(python.status.success());
            let python = String::from_utf8(python.stdout).unwrap().trim().to_owned();
            let fixture = Fixture(PathBuf::from("/tmp").join(format!("t3-custody-{}", uuid::Uuid::new_v4())));
            let root = &fixture.0;
            std::fs::create_dir_all(root.join("project")).unwrap();
            std::fs::create_dir_all(root.join("state")).unwrap();
            std::fs::write(root.join("tool.py"), TOOL_SCRIPT).unwrap();
            let listener = tokio::net::UnixListener::bind(root.join("probe.sock")).unwrap();
            let stderr = std::fs::File::create(root.join("gateway.log")).unwrap();
            let mut gateway = OwnedGateway(Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "native_containment_probe::tests::native_gateway_child", "--nocapture"])
                .env("T3_NATIVE_CONTAINMENT_ROOT", root)
                .env("T3_NATIVE_CONTAINMENT_PYTHON", &python)
                .env("T3_NATIVE_CONTAINMENT_KIND", "direct")
                .stdout(Stdio::null()).stderr(stderr).spawn().unwrap());
            let (stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
                .await.expect("native shell did not connect").unwrap();
            let (read, mut write) = stream.into_split();
            let mut incoming = BufReader::new(read).lines();
            let _: Value = serde_json::from_str(&incoming.next_line().await.unwrap().unwrap()).unwrap();
            let original = crate::thread_recovery::read(&root.join("state"), "crash-tool-operation").unwrap().unwrap();
            assert!(original.supports_native_recovery(), "session and custody provenance persist before dispatch");
            gateway.0.kill().unwrap();
            assert!(!gateway.0.wait().unwrap().success());
            write.write_all(b"effect\n").await.unwrap();
            assert_eq!(tokio::time::timeout(Duration::from_secs(3), incoming.next_line()).await.unwrap().unwrap().as_deref(), Some("effect-committed"));

            let cold = MeerkatGateway::new();
            let handle = cold.project_runtime_handle_for_paths(
                root.join("project").to_str().unwrap(), root.join("project").to_str().unwrap(),
                "local".into(), Some(root.join("state").to_str().unwrap()),
            ).await.unwrap();
            // Any provider call before the explicit successor is a replay.
            let client = Arc::new(ShellOnce { command: "false".into(), calls: AtomicUsize::new(1) });
            handle.state.lock().await.mobkit = Arc::new(ProjectMobkitRegistry::new_with_test_llm(
                Arc::clone(&cold.inner.host_tools), client.clone(),
            ));
            let mut params = scope(root);
            params["includeNativeWorkers"] = json!(false);
            assert_eq!(cold.mobs_run_status(Some(&params)).await.unwrap()["canRecover"], true);
            let recovered = tokio::time::timeout(Duration::from_secs(45), cold.mobs_recover_thread(Some(&params)))
                .await.expect("recovery did not converge").unwrap();
            assert_eq!(recovered["outcome"], "unresolved");
            assert_eq!(recovered["cleanupCompleted"], true);
            assert!(tokio::time::timeout(Duration::from_secs(3), incoming.next_line()).await.unwrap().unwrap().is_none(), "native custody must close the exact tool process");
            let registry = handle.state.lock().await.mobkit.clone();
            let restored = registry.get("containment-mob").await.unwrap();
            let runtime = restored.runtime.as_ref().unwrap();
            let session = runtime.mob_handle().resolve_bridge_session_id(
                &meerkat_mobkit::member_comms_id::mob_member_id("ingress"),
            ).await.unwrap();
            assert_eq!(Some(session.to_string()), original.native_session_id);
            let history = tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let messages = crate::read_session_history_messages(runtime, &session.to_string()).await.unwrap();
                    let encoded = serde_json::to_string(&messages).unwrap();
                    if encoded.contains("tool_process_interrupted") { break encoded; }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }).await.expect("native interrupted-tool notice was not persisted");
            assert!(history.contains("Execute the deterministic shell fixture once."));
            assert_eq!(client.calls.load(Ordering::SeqCst), 1, "recovery must not call a provider");
            assert_eq!(std::fs::read_to_string(root.join("effect.txt")).unwrap().lines().count(), 1);
            assert_eq!(cold.mobs_run_status(Some(&params)).await.unwrap()["status"], "recovered");
            assert!(crate::thread_recovery::reserve(&root.join("state"), params.as_object().unwrap(), "crash-tool-operation", &crate::thread_recovery::gateway_owner(&cold)).is_err());
            let mut successor = params.clone();
            successor["runId"] = json!("successor-operation");
            successor["input"] = json!("Continue safely after the interrupted tool.");
            rpc(&cold, "mobs.v1.turnStart", successor.clone()).await;
            tokio::time::timeout(Duration::from_secs(30), async {
                loop {
                    let status = cold.mobs_run_status(Some(&successor)).await.unwrap();
                    match status["status"].as_str() {
                        Some("completed") => break,
                        Some("failed" | "cancelled") => panic!("successor failed: {status}"),
                        _ => tokio::time::sleep(Duration::from_millis(20)).await,
                    }
                }
            }).await.expect("the explicit successor did not complete");
            let continued_session = runtime.mob_handle().resolve_bridge_session_id(
                &meerkat_mobkit::member_comms_id::mob_member_id("ingress"),
            ).await.unwrap();
            assert_eq!(continued_session, session, "continuation must use the recovered conversation");
            let continued = crate::read_session_history_messages(runtime, &session.to_string()).await.unwrap();
            let continued = serde_json::to_string(&continued).unwrap();
            assert!(continued.contains("Execute the deterministic shell fixture once."));
            assert!(continued.contains("Continue safely after the interrupted tool."));
            assert!(continued.contains("Recovery successor complete."));
            assert_eq!(client.calls.load(Ordering::SeqCst), 2, "only the explicit successor may call the provider");
            assert_eq!(std::fs::read_to_string(root.join("effect.txt")).unwrap().lines().count(), 1, "continuation must not replay the interrupted shell");
            assert_eq!(cold.mobs_run_status(Some(&params)).await.unwrap()["status"], "recovered");
            registry.remove("containment-mob").await.unwrap();
        });
    }
}
