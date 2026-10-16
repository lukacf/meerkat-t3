use super::*;
use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// These proofs create and reopen real SQLite stores for concurrent workspaces.
// Allow schema setup on a shared development host; startup speed is not the
// assertion. Provider requests, delivery, session identity and cleanup retain
// their own strict checks and shorter waits.
const HTTP_PROOF_BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(60);

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
    run_http_proof(async { http_auth_proof("root", false, false).await });
}

#[test]
fn model_picker_keeps_managed_oauth_lease_across_first_second_and_restarted_turns() {
    run_http_proof(async { http_auth_proof("oauth", false, true).await });
}

#[test]
fn child_tools_use_their_owning_workspace_http_binding() {
    run_http_proof(async {
        // Each native request has its own task. Joining both complete proofs
        // in one task makes synchronous store setup block the other request's
        // timeout polling even when the runtime has spare worker threads.
        tokio::try_join!(
            tokio::spawn(http_auth_proof("first", true, false)),
            tokio::spawn(http_auth_proof("second", true, false))
        )
        .unwrap();
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

async fn http_auth_proof(label: &str, child_tools: bool, oauth: bool) {
    let fixture_id = uuid::Uuid::new_v4();
    let root = std::env::temp_dir().join(format!("desktop-auth-{fixture_id}"));
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
    let child_id = format!("child-auth-{label}-{fixture_id}");
    // Both possible configured routes are loopback with fake credentials.
    // A regression is observable without ever contacting a real provider.
    let workspace_config = fixture_config(&realm, &endpoint, &workspace_key);
    let workspace_config = if oauth {
        workspace_config
            .replace(
                "backend_kind = \"openai_api\"",
                "backend_kind = \"chatgpt_backend\"",
            )
            .replace(
                "auth_method = \"api_key\"",
                "auth_method = \"external_chatgpt_tokens\"",
            )
            .replace(
                &format!("source = {{ kind = \"inline_secret\", secret = \"{workspace_key}\" }}"),
                "source = { kind = \"managed_store\" }",
            )
    } else {
        workspace_config
    };
    std::fs::write(realm_dir.join("config.toml"), workspace_config).unwrap();
    let persistence = meerkat_providers::auth_store::ProviderAuthPersistence::new(
        Arc::new(meerkat_providers::auth_store::EphemeralTokenStore::new()),
        Arc::new(meerkat_providers::auth_store::InMemoryCoordinator::new()),
    );
    let binding = meerkat_core::AuthBindingRef {
        realm: RealmId::parse(&realm).unwrap(),
        binding: meerkat_core::BindingId::parse("fixture").unwrap(),
        profile: None,
        origin: meerkat_core::BindingOrigin::Configured,
    };
    let credential = meerkat_core::AuthCredentialIdentity::Binding(binding.clone());
    if oauth {
        let mut tokens =
            meerkat_providers::auth_store::PersistedTokens::static_bearer(&workspace_key);
        tokens.auth_mode = meerkat_providers::auth_store::PersistedAuthMode::ExternalTokens;
        tokens.account_id = Some("fixture-account".into());
        tokens.expires_at = Some(chrono::Utc::now() + chrono::Duration::hours(1));
        meerkat_providers::browser_login::save_tokens_and_publish_lifecycle(
            persistence.clone(),
            meerkat_runtime::MeerkatMachine::ephemeral().generated_auth_lease_handle(),
            credential.clone(),
            tokens,
        )
        .await
        .unwrap();
    }
    std::fs::write(
        global_dir.join("config.toml"),
        fixture_config("global", &endpoint, "wrong-global-key")
            .replace("default_binding = \"fixture\"", "default_binding = \"global-fixture\"")
            .replace(".binding.fixture]", ".binding.global-fixture]"),
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
        mob_id: format!("configured-auth-{label}-{fixture_id}"),
        kind: "thread".into(),
        label: "Auth proof".into(),
        role: "ingress".into(),
        coordinator_identity: "ingress".into(),
        model: "gpt-5.5".into(),
        initial_llm: None,
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
    let mut prior_child_session = None;
    for attempt in 0..2 {
        let registry = ProjectMobkitRegistry::new(HostToolTransport::new());
        let bootstrap_started = std::time::Instant::now();
        let mob = if oauth {
            let mob = Arc::new(
                tokio::time::timeout(
                    HTTP_PROOF_BOOTSTRAP_TIMEOUT,
                    bootstrap_local_runtime_with_provider_persistence(
                        input.clone(),
                        HostToolTransport::new(),
                        None,
                        None,
                        persistence.clone(),
                        Some(&registry.observer_disposals),
                    ),
                )
                .await
                .unwrap_or_else(|error| panic!("HTTP auth fixture {label} attempt {attempt}: OAuth bootstrap timed out after {:?}: {error}", bootstrap_started.elapsed()))
                .unwrap(),
            );
            registry
                .mobs
                .write()
                .await
                .insert(input.mob_id.clone(), mob.clone());
            mob
        } else {
            tokio::time::timeout(
                HTTP_PROOF_BOOTSTRAP_TIMEOUT,
                registry.create_local(input.clone()),
            )
            .await
            .unwrap_or_else(|error| panic!("HTTP auth fixture {label} attempt {attempt}: bootstrap timed out after {:?}: {error}", bootstrap_started.elapsed()))
            .unwrap()
        };
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
        for _ in 0..if oauth { 2 } else { 1 } {
            let options = if oauth {
                let config = load_effective_realm_config(
                    &input.config_project_path,
                    &input.config_state_root,
                )
                .await
                .unwrap();
                crate::member_turn_options_for_realm(
                    json!({"model":input.model, "provider":"openai", "providerParams":null})
                        .as_object()
                        .unwrap(),
                    &config.effective,
                    Some(meerkat_core::Provider::OpenAI),
                    Some(&config.realm_id),
                )
                .unwrap()
            } else {
                MemberTurnOptions::new()
            };
            let turn = start_member_turn(
                runtime,
                "ingress",
                "Check the fixture.",
                meerkat_core::types::HandlingMode::Queue,
                options,
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
                if oauth {
                    let (headers, body) =
                        tokio::time::timeout(Duration::from_secs(10), request_rx.recv())
                            .await
                            .unwrap()
                            .unwrap();
                    assert!(headers.starts_with("POST /responses "), "{headers}");
                    assert!(headers
                        .to_lowercase()
                        .contains(&format!("authorization: bearer {workspace_key}")));
                    assert!(headers
                        .to_lowercase()
                        .contains("chatgpt-account-id: fixture-account"));
                    assert_eq!(body["model"], input.model);
                    let saved = member_llm_identity(runtime, "ingress")
                        .await
                        .unwrap()
                        .unwrap();
                    assert_eq!(
                        saved.auth_binding,
                        Some(binding.clone()),
                        "model selection must retain the account in durable runtime identity"
                    );
                    let lease = mob
                        .session_runtime
                        .as_ref()
                        .unwrap()
                        .generated_auth_lease_handle()
                        .snapshot(&meerkat_core::handles::LeaseKey::from_credential_identity(
                            &credential,
                        ));
                    assert!(
                        lease.credential_present,
                        "a same-account model selection must not release its OAuth credential"
                    );
                } else {
                    assert_request(&mut request_rx, &workspace_key).await;
                }
            }
        }
        if child_tools {
            let children = runtime.mob_runtime().agent_mob_mcp_state().unwrap();
            let child = children.handle_for(&child_id.clone().into()).await.unwrap();
            let child_session = child
                .resolve_bridge_session_id(&"reviewer".into())
                .await
                .expect("native mob_spawn_member tool created the reviewer");
            if let Some(prior) = prior_child_session.as_ref() {
                assert_eq!(prior, &child_session, "cold restore must retain the child session");
            }
            prior_child_session = Some(child_session.clone());
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
            let effective = load_effective_realm_config(
                &input.config_project_path, &input.config_state_root,
            ).await.unwrap().effective;
            assert_saved_child_binding_resolves_without_child_realm(effective, &binding, &child_id);
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
        if attempt == 0 {
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
        drop(mob);
        let drain = registry.drain_storage_observers().await;
        assert!(drain.is_empty(), "HTTP auth fixture {label} attempt {attempt}: {drain:?}");
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

fn assert_saved_child_binding_resolves_without_child_realm(
    config: Config,
    saved_binding: &meerkat_core::AuthBindingRef,
    child_id: &str,
) {
    let child_realm = meerkat_core::mob_realm_id(child_id).unwrap();
    // During cold restoration the child registry is not yet readable. The
    // saved native binding must resolve without that derived parent link.
    // An unrelated global account or environment-default route cannot replace
    // it. Native resolution intentionally permits the SAME binding ID to be
    // inherited, so the global decoy has its own distinct ID.
    assert!(!config.realm.contains_key(child_realm.as_str()));
    assert!(config.realm["global"].binding.contains_key("global-fixture"));
    assert!(!config.realm["global"].binding.contains_key(saved_binding.binding.as_str()));
    let resolve = |config: &Config| {
        meerkat_core::resolve_auth_binding_candidates_for_provider(
            config, meerkat_core::Provider::OpenAI, Some(saved_binding),
            Some(&child_realm), true,
        )
    };
    let candidates = resolve(&config).unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(&candidates[0].auth_binding, saved_binding);

    let mut missing = config.clone();
    missing.realm.get_mut(saved_binding.realm.as_str()).unwrap()
        .binding.remove(saved_binding.binding.as_str());
    assert!(resolve(&missing).is_err(), "a missing saved binding must not select an unrelated account");

    let mut invalid = config;
    invalid.realm.get_mut(saved_binding.realm.as_str()).unwrap()
        .backend.clear();
    assert!(resolve(&invalid).is_err(), "an invalid saved route must not select another account");
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
