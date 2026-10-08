use super::*;
use meerkat_providers::auth_store::{
    EphemeralTokenStore, InMemoryCoordinator, PersistedAuthMode, PersistedTokens,
    ProviderAuthPersistence,
};
use std::io::{Read, Write};

fn local_response_fixture() -> (String, std::thread::JoinHandle<(String, Value)>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let server = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut socket = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "No local writing request"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("Local writing fixture failed: {error}"),
            }
        };
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let header_end = loop {
            let mut chunk = [0; 4096];
            let count = socket.read(&mut chunk).unwrap();
            assert_ne!(count, 0, "Request ended before HTTP headers");
            bytes.extend_from_slice(&chunk[..count]);
            assert!(bytes.len() < 1024 * 1024);
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                break end + 4;
            }
        };
        let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
        let content_length: usize = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse().unwrap())
            })
            .expect("JSON request has content length");
        while bytes.len() < header_end + content_length {
            let mut chunk = [0; 4096];
            let count = socket.read(&mut chunk).unwrap();
            assert_ne!(count, 0);
            bytes.extend_from_slice(&chunk[..count]);
        }
        let body = serde_json::from_slice(&bytes[header_end..header_end + content_length]).unwrap();
        let item = json!({"type":"message","id":"local-message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"{\"title\":\"Native account policy\"}"}]});
        let events = [
            json!({"type":"response.created","response":{"id":"local-response"}}),
            json!({"type":"response.output_item.added","output_index":0,"item":item}),
            json!({"type":"response.completed","response":{"id":"local-response","status":"completed","output":[item],"usage":{"input_tokens":10,"output_tokens":10,"total_tokens":20}}}),
        ];
        let payload = events
            .into_iter()
            .map(|event| format!("data: {event}\n\n"))
            .collect::<String>();
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", payload.len(), payload).unwrap();
        (headers, body)
    });
    (format!("http://{address}"), server)
}

async fn account_policy_fixture(chatgpt: bool, missing_first: bool) -> (String, Value) {
    let (base_url, server) = local_response_fixture();
    let selected_realm = if missing_first { "parent" } else { "writer" };
    let mut config = meerkat::Config::default();
    config
        .merge_toml_str(&format!(
            r#"
[realm.global]
default_binding = "local-safety"
[realm.global.backend.local-safety]
provider = "openai"
backend_kind = "openai_api"
base_url = "{base_url}"
[realm.global.auth.local-safety]
provider = "openai"
auth_method = "api_key"
source = {{ kind = "inline_secret", secret = "local-safety-only" }}
[realm.global.binding.local-safety]
backend_profile = "local-safety"
auth_profile = "local-safety"
provider_default = true
[realm.{selected_realm}]
default_binding = "selected"
[realm.{selected_realm}.backend.selected]
provider = "openai"
backend_kind = "{backend}"
base_url = "{base_url}"
[realm.{selected_realm}.auth.selected]
provider = "openai"
auth_method = "{auth_method}"
source = {source}
[realm.{selected_realm}.binding.selected]
backend_profile = "selected"
auth_profile = "selected"
provider_default = true
"#,
            backend = if chatgpt {
                "chatgpt_backend"
            } else {
                "openai_api"
            },
            auth_method = if chatgpt {
                "external_chatgpt_tokens"
            } else {
                "api_key"
            },
            source = if chatgpt {
                "{ kind = \"managed_store\" }"
            } else {
                "{ kind = \"inline_secret\", secret = \"local-writing-key\" }"
            },
        ))
        .unwrap();
    if missing_first {
        config
            .merge_toml_str(&format!(
                r#"
[realm.writer]
parent = "parent"
default_binding = "unavailable"
[realm.writer.backend.unavailable]
provider = "openai"
backend_kind = "chatgpt_backend"
base_url = "{base_url}"
[realm.writer.auth.unavailable]
provider = "openai"
auth_method = "external_chatgpt_tokens"
source = {{ kind = "managed_store" }}
[realm.writer.binding.unavailable]
backend_profile = "unavailable"
auth_profile = "unavailable"
provider_default = true
"#
            ))
            .unwrap();
    }
    let store = Arc::new(EphemeralTokenStore::new());
    let persistence = ProviderAuthPersistence::new(store, Arc::new(InMemoryCoordinator::new()));
    if chatgpt {
        let mut tokens = PersistedTokens::static_bearer("local-writing-key");
        tokens.auth_mode = PersistedAuthMode::ExternalTokens;
        tokens.account_id = Some("local-writing-account".into());
        tokens.expires_at = Some(chrono::Utc::now() + chrono::Duration::hours(1));
        let credential =
            meerkat_core::AuthCredentialIdentity::Binding(meerkat_core::AuthBindingRef {
                realm: RealmId::parse(selected_realm).unwrap(),
                binding: meerkat_core::BindingId::parse("selected").unwrap(),
                profile: None,
                origin: meerkat_core::BindingOrigin::Configured,
            });
        let login_runtime = meerkat_runtime::MeerkatMachine::ephemeral();
        meerkat_providers::browser_login::save_tokens_and_publish_lifecycle(
            persistence.clone(),
            login_runtime.generated_auth_lease_handle(),
            credential,
            tokens,
        )
        .await
        .unwrap();
    }
    let factory = AgentFactory::minimal().with_provider_auth_persistence(persistence);
    let input = GenerationInput {
        project_path: "/unused".into(),
        config_state_root: "/unused".into(),
        model: "gpt-5.6-sol".into(),
        provider: "openai".into(),
        provider_params: None,
        prompt: "Title the supplied change".into(),
        output_schema: json!({"type":"object","properties":{"title":{"type":"string"}},"required":["title"],"additionalProperties":false}),
        images: vec![],
    };
    // These unrelated agent features must not be consulted by a writing request.
    config.agent.system_prompt_file = Some(PathBuf::from("/missing-writing-prompt"));
    config
        .hooks
        .entries
        .push(meerkat_core::config::HookEntryConfig {
            runtime: meerkat_core::config::HookAdapterConfig::in_process("missing-writing-hook"),
            ..Default::default()
        });
    let identity = SessionLlmIdentity {
        model: input.model.clone(),
        provider: Provider::OpenAI,
        self_hosted_server_id: None,
        provider_params: None,
        auth_binding: None,
    };
    let result = tokio::time::timeout(
        Duration::from_secs(8),
        execute(
            &factory,
            &config,
            &identity,
            Some(&RealmId::parse("writer").unwrap()),
            None,
            &input,
        ),
    )
    .await
    .expect("Bounded native helper");
    let (headers, body) = server.join().expect("Local backend fixture");
    assert_eq!(
        result.unwrap(),
        json!({"output":{"title":"Native account policy"}})
    );
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("authorization: bearer local-writing-key")
    );
    assert_eq!(body["model"], "gpt-5.6-sol");
    assert!(
        body.get("tools")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
    );
    assert_eq!(body["text"]["format"]["type"], "json_schema");
    (headers, body)
}

#[tokio::test]
async fn configured_public_api_keeps_native_cache_defaults() {
    let (headers, body) = account_policy_fixture(false, false).await;
    assert!(headers.starts_with("POST /v1/responses "));
    assert_eq!(body["max_output_tokens"], DEFAULT_OUTPUT_TOKENS);
    assert_eq!(
        body["prompt_cache_key"],
        "meerkat:profile:openai:gpt-5.6-sol"
    );
    assert!(body.get("prompt_cache_options").is_some());
}

#[tokio::test]
async fn configured_chatgpt_backend_uses_native_policy_and_wire() {
    let (headers, body) = account_policy_fixture(true, false).await;
    assert!(headers.starts_with("POST /responses "));
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("chatgpt-account-id: local-writing-account")
    );
    assert!(body.get("instructions").and_then(Value::as_str).is_some());
    assert!(body.get("max_output_tokens").is_none());
    assert!(body.get("prompt_cache_key").is_none());
    assert!(body.get("prompt_cache_options").is_none());
}

#[tokio::test]
async fn credential_fallback_uses_actual_parent_backend_policy() {
    let (headers, body) = account_policy_fixture(true, true).await;
    assert!(headers.starts_with("POST /responses "));
    assert!(body.get("prompt_cache_key").is_none());
    assert!(body.get("prompt_cache_options").is_none());
}
