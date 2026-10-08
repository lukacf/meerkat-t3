use super::*;
use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn fixture_config(realm: &str, endpoint: &str, key: &str) -> String {
    format!(
        r#"[realm.{realm}]
default_binding = "fixture"
[realm.{realm}.backend.fixture]
provider = "openai"
backend_kind = "openai_api"
base_url = "{endpoint}"
[realm.{realm}.auth.fixture]
provider = "openai"
auth_method = "api_key"
source = {{ kind = "inline_secret", secret = "{key}" }}
[realm.{realm}.binding.fixture]
backend_profile = "fixture"
auth_profile = "fixture"
provider_default = true
[model_fallback]
enabled = false
"#
    )
}

#[test]
fn configured_workspace_auth_reaches_native_http_before_and_after_restart() {
    run_http_proof(async { http_auth_proof("root", false).await });
}

#[test]
fn child_tools_use_their_owning_workspace_http_binding() {
    run_http_proof(async {
        tokio::join!(
            http_auth_proof("first", true),
            http_auth_proof("second", true)
        );
    });
}

fn run_http_proof(proof: impl std::future::Future<Output = ()> + Send + 'static) {
    std::thread::Builder::new()
        .stack_size(32 * 1024 * 1024)
        .spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_stack_size(32 * 1024 * 1024)
                .enable_all()
                .build()
                .unwrap()
                .block_on(proof);
        })
        .unwrap()
        .join()
        .unwrap();
}

async fn http_auth_proof(label: &str, child_tools: bool) {
    let root = std::env::temp_dir().join(format!("desktop-auth-{}", uuid::Uuid::new_v4()));
    let project = root.join("project");
    let state = root.join("state");
    std::fs::create_dir_all(&project).unwrap();
    let realm = derive_workspace_realm_id(&project);
    let realm_dir = state.join(&realm);
    let global_dir = state.join("__test_global__");
    std::fs::create_dir_all(&realm_dir).unwrap();
    std::fs::create_dir_all(&global_dir).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let workspace_key = format!("workspace-{label}-key");
    let child_id = format!("child-auth-{label}");
    // Both possible configured routes are loopback with fake credentials.
    // A regression is observable without ever contacting a real provider.
    std::fs::write(
        realm_dir.join("config.toml"),
        fixture_config(&realm, &endpoint, &workspace_key),
    )
    .unwrap();
    std::fs::write(
        global_dir.join("config.toml"),
        fixture_config("global", &endpoint, "wrong-global-key"),
    )
    .unwrap();
    let (request_tx, mut request_rx) = tokio::sync::mpsc::unbounded_channel();
    let served = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let provider_child_id = child_id.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request_tx = request_tx.clone();
            let served = served.clone();
            let provider_child_id = provider_child_id.clone();
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let (headers, offset, length) = loop {
                    let mut chunk = [0; 4096];
                    let count = socket.read(&mut chunk).await.unwrap();
                    if count == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&chunk[..count]);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|length| length.trim().parse::<usize>().ok())
                            })
                            .unwrap();
                        break (headers, end + 4, length);
                    }
                };
                while bytes.len() < offset + length {
                    let mut chunk = [0; 4096];
                    let count = socket.read(&mut chunk).await.unwrap();
                    if count == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&chunk[..count]);
                }
                let body: Value = serde_json::from_slice(&bytes[offset..offset + length]).unwrap();
                request_tx.send((headers, body)).unwrap();
                let index = served.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let item = match (child_tools, index) {
                    (true, 0) => {
                        json!({"type":"function_call","id":"fc_create","call_id":"call_create","name":"mob_create","arguments":json!({"definition":{"id":provider_child_id,"profiles":{"worker":{"model":"gpt-5.5","runtime_mode":"turn_driven","tools":{"builtins":false,"shell":false,"comms":true,"mob":false}}}}}).to_string(),"status":"completed"})
                    }
                    (true, 1) => {
                        json!({"type":"function_call","id":"fc_spawn","call_id":"call_spawn","name":"mob_spawn_member","arguments":json!({"mob_id":provider_child_id,"profile":"worker","member_id":"reviewer","runtime_mode":"turn_driven","auto_wire_parent":false}).to_string(),"status":"completed"})
                    }
                    _ => {
                        json!({"type":"message","id":"msg_fixture","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Workspace auth reached the local fixture."}]})
                    }
                };
                let mut events = vec![
                    json!({"type":"response.created","response":{"id":"resp_fixture"}}),
                    json!({"type":"response.output_item.added","output_index":0,"item":item}),
                ];
                if item["type"] == "function_call" {
                    events.push(json!({"type":"response.function_call_arguments.done","item_id":item["id"],"call_id":item["call_id"],"name":item["name"],"arguments":item["arguments"]}));
                } else {
                    events.push(json!({"type":"response.output_text.delta","item_id":"msg_fixture","output_index":0,"content_index":0,"delta":"Workspace auth reached the local fixture."}));
                }
                events.push(json!({"type":"response.completed","response":{"id":"resp_fixture","status":"completed","output":[item],"usage":{"input_tokens":10,"output_tokens":10,"total_tokens":20}}}));
                let body = events
                    .iter()
                    .map(|event| format!("data: {event}\n\n"))
                    .collect::<String>();
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
                socket.write_all(response.as_bytes()).await.unwrap();
            });
        }
    });
    let input = CreateMobInput {
        mob_id: format!("configured-auth-{label}"),
        kind: "thread".into(),
        label: "Auth proof".into(),
        role: "ingress".into(),
        coordinator_identity: "ingress".into(),
        model: "gpt-5.5".into(), initial_llm: None,
        instructions: "Respond once.".into(),
        thread_id: None,
        include_native_workers: false,
        access_mode: None,
        config_project_path: project.clone(),
        project_path: project,
        state_root: state.clone(),
        config_state_root: state,
    };
    let mut prior_session = None;
    for attempt in 0..2 {
        let registry = ProjectMobkitRegistry::new(HostToolTransport::new());
        let mob = tokio::time::timeout(
            Duration::from_secs(15),
            registry.create_local(input.clone()),
        )
        .await
        .unwrap()
        .unwrap();
        let runtime = mob.runtime.as_ref().unwrap();
        let session = runtime
            .mob_handle()
            .resolve_bridge_session_id(&"ingress".into())
            .await
            .unwrap();
        if let Some(prior) = prior_session.as_ref() {
            assert_eq!(prior, &session);
        }
        prior_session = Some(session.clone());
        let saved = runtime
            .mob_runtime()
            .session_service()
            .unwrap()
            .load_persisted_session_metadata(&session)
            .await
            .unwrap()
            .unwrap()
            .session_metadata
            .unwrap();
        assert_eq!(
            saved.realm_id.unwrap(),
            meerkat_core::mob_realm_id(&input.mob_id).unwrap(),
            "native mob realm must remain unchanged"
        );
        let binding = saved.auth_binding.unwrap();
        assert_eq!(binding.realm.as_str(), realm);
        assert_eq!(binding.binding.as_str(), "fixture");
        let turn = start_member_turn(
            runtime,
            "ingress",
            "Check the fixture.",
            meerkat_core::types::HandlingMode::Queue,
            MemberTurnOptions::new(),
            None,
        )
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(10), turn.turn.wait())
            .await
            .unwrap()
            .unwrap();
        let requests = if child_tools && attempt == 0 { 3 } else { 1 };
        for _ in 0..requests {
            assert_request(&mut request_rx, &workspace_key).await;
        }
        if attempt == 0 {
            if child_tools {
                let children = runtime.mob_runtime().agent_mob_mcp_state().unwrap();
                let child = children.handle_for(&child_id.clone().into()).await.unwrap();
                let child_session = child
                    .resolve_bridge_session_id(&"reviewer".into())
                    .await
                    .expect("native mob_spawn_member tool created the reviewer");
                let saved = children
                    .session_service()
                    .load_persisted_session_metadata(&child_session)
                    .await
                    .unwrap()
                    .unwrap()
                    .session_metadata
                    .unwrap();
                assert_eq!(
                    saved.realm_id.unwrap(),
                    meerkat_core::mob_realm_id(&child_id).unwrap()
                );
                let binding = saved.auth_binding.unwrap();
                assert_eq!(binding.realm.as_str(), realm);
                assert_eq!(binding.binding.as_str(), "fixture");
                let member = child.member(&"reviewer".into()).await.unwrap();
                let mut events = member.events().await.unwrap();
                member
                    .internal_turn("Verify child authentication.")
                    .await
                    .unwrap();
                tokio::time::timeout(Duration::from_secs(10), async {
                    while let Some(envelope) = events.next().await {
                        match envelope.payload {
                            meerkat_core::AgentEvent::RunCompleted { .. } => return,
                            meerkat_core::AgentEvent::RunFailed { error_report, .. } => {
                                panic!("Child fixture failed: {error_report:?}")
                            }
                            _ => {}
                        }
                    }
                    panic!("Child events closed before completion");
                })
                .await
                .unwrap();
                assert_request(&mut request_rx, &workspace_key).await;
            }
            runtime
                .mob_handle()
                .spawn_spec(
                    SpawnMemberSpec::new("ingress", "worker")
                        .with_runtime_mode(MobRuntimeMode::TurnDriven),
                )
                .await
                .unwrap();
            let worker = runtime
                .mob_handle()
                .resolve_bridge_session_id(&"worker".into())
                .await
                .unwrap();
            let saved = runtime
                .mob_runtime()
                .session_service()
                .unwrap()
                .load_persisted_session_metadata(&worker)
                .await
                .unwrap()
                .unwrap()
                .session_metadata
                .unwrap();
            assert_eq!(saved.auth_binding.unwrap().realm.as_str(), realm);
        }
        assert!(registry.shutdown().await.is_empty());
    }
    server.abort();
    let _ = server.await;
    std::fs::remove_dir_all(root).unwrap();
}

async fn assert_request(
    requests: &mut tokio::sync::mpsc::UnboundedReceiver<(String, Value)>,
    key: &str,
) {
    let (headers, body) = tokio::time::timeout(Duration::from_secs(10), requests.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(headers.starts_with("POST /v1/responses "), "{headers}");
    assert!(
        headers
            .to_lowercase()
            .contains(&format!("authorization: bearer {key}")),
        "{headers}"
    );
    assert_eq!(body["model"], "gpt-5.5");
}

#[tokio::test]
async fn mob_auth_parent_preserves_raw_config_and_refuses_foreign_parent() {
    let realm = RealmId::parse("workspace").unwrap();
    let config: Config =
        toml::from_str(&fixture_config("workspace", "http://127.0.0.1:1", "fake")).unwrap();
    let raw = Arc::new(meerkat_core::MemoryConfigStore::new(
        config,
        meerkat_models::canonical(),
    ));
    let scoped = mob_config_store(raw.clone(), "owned-mob", realm.clone()).unwrap();
    let projected = scoped.get().await.unwrap();
    let mob_realm = meerkat_core::mob_realm_id("owned-mob").unwrap();
    assert_eq!(
        projected.realm[mob_realm.as_str()].parent.as_ref(),
        Some(&realm)
    );
    assert!(!raw
        .get()
        .await
        .unwrap()
        .realm
        .contains_key(mob_realm.as_str()));
    let route = meerkat_core::resolve_auth_binding_candidates_for_provider(
        &projected,
        meerkat_core::Provider::OpenAI,
        None,
        Some(&mob_realm),
        false,
    )
    .unwrap();
    assert_eq!(route[0].auth_binding.realm, realm);
    let mut config = raw.get().await.unwrap();
    config
        .realm
        .entry(mob_realm.to_string())
        .or_default()
        .parent = Some(RealmId::global());
    raw.set(config).await.unwrap();
    assert!(scoped.get().await.is_err());
}

#[tokio::test]
async fn child_ownership_reads_are_current_and_fail_closed() {
    let raw = Arc::new(meerkat_core::MemoryConfigStore::new(
        Config::default(),
        meerkat_models::canonical(),
    ));
    let realm = RealmId::parse("workspace").unwrap();
    let scoped = mob_config_store(raw.clone(), "root", realm.clone()).unwrap();
    let children = Arc::new(std::sync::Mutex::new(Ok(vec![meerkat_core::mob_realm_id(
        "child",
    )
    .unwrap()])));
    let owned_children = children.clone();
    scoped
        .bind_child_realms(Arc::new(move || {
            let current = owned_children.lock().unwrap().clone();
            Box::pin(async move { current })
        }))
        .unwrap();
    let child = meerkat_core::mob_realm_id("child").unwrap();
    assert_eq!(
        scoped.get().await.unwrap().realm[child.as_str()]
            .parent
            .as_ref(),
        Some(&realm)
    );
    assert!(raw.get().await.unwrap().realm.is_empty());
    *children.lock().unwrap() = Ok(Vec::new());
    assert!(!scoped
        .get()
        .await
        .unwrap()
        .realm
        .contains_key(child.as_str()));
    *children.lock().unwrap() = Err("Native registry unavailable".into());
    assert!(scoped
        .get()
        .await
        .unwrap_err()
        .to_string()
        .contains("Native registry unavailable"));
    assert!(scoped
        .bind_child_realms(Arc::new(|| Box::pin(async { Ok(Vec::new()) })))
        .is_err());
}
