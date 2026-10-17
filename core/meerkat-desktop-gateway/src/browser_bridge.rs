//! Ephemeral T3 preview grants. Credentials are held only in memory and are never mob specs.
use crate::{
    GatewayError, MeerkatGateway, console_expected_target, derive_project_locator, object_params,
    required_nonempty_string,
};
use meerkat::{McpRouter, McpRouterAdapter, McpServerConfig};
use meerkat_core::{
    AgentToolDispatcher, ToolDispatchContext, ToolDispatchOutcome, ToolError,
    types::{ToolCallView, ToolDef, ToolResult},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, OnceLock, RwLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

mod child_tools;
pub(crate) use child_tools::BrowserChildTools;

#[derive(Clone, Hash, PartialEq, Eq)]
struct Scope {
    project: PathBuf,
    state: PathBuf,
    mob: String,
}
struct Grant {
    host_thread_id: Option<String>,
    host_session_id: Option<String>,
    dispatcher: Arc<dyn AgentToolDispatcher>,
    revision: u64,
    child_guard: Option<Arc<dyn child_tools::ChildGrantGuard>>,
}
#[derive(Default)]
struct BrowserDispatcher {
    grants: RwLock<HashMap<String, Grant>>,
    epoch: AtomicU64,
    revisions: RwLock<HashMap<String, u64>>,
    unavailable: RwLock<HashMap<String, String>>,
}
static SCOPES: OnceLock<std::sync::Mutex<HashMap<Scope, Arc<BrowserDispatcher>>>> = OnceLock::new();
fn scoped(scope: Scope) -> Arc<BrowserDispatcher> {
    SCOPES
        .get_or_init(Default::default)
        .lock()
        .expect("browser grant registry")
        .entry(scope)
        .or_default()
        .clone()
}
pub(crate) fn dispatcher(
    project: PathBuf,
    state: PathBuf,
    mob: String,
) -> Arc<dyn AgentToolDispatcher> {
    scoped(Scope {
        project,
        state,
        mob,
    })
}
fn denied(call: &ToolCallView<'_>) -> ToolDispatchOutcome {
    ToolResult::new(call.id.to_string(),"Browser access is not granted to this native session. Ask the user to connect this agent to a desktop browser workspace.".into(),true).into()
}
impl BrowserDispatcher {
    fn revoke(&self, session: &str) -> u64 {
        self.revoke_expected(session, None)
            .expect("unconditional browser revoke")
    }
    fn revoke_expected(&self, session: &str, expected: Option<u64>) -> Option<u64> {
        let mut revisions = self.revisions.write().expect("browser revisions");
        if expected.is_some_and(|revision| revisions.get(session) != Some(&revision)) {
            return None;
        }
        let revision = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        revisions.insert(session.to_owned(), revision);
        self.grants.write().expect("browser grants").remove(session);
        self.unavailable
            .write()
            .expect("browser availability")
            .remove(session);
        Some(revision)
    }
    fn current(&self, session: &str, revision: u64) -> bool {
        self.revisions
            .read()
            .ok()
            .and_then(|revisions| revisions.get(session).copied())
            == Some(revision)
    }
    fn revoke_if_current(&self, session: &str, revision: u64) {
        let mut revisions = self.revisions.write().expect("browser revisions");
        if revisions.get(session) == Some(&revision) {
            revisions.insert(
                session.to_owned(),
                self.epoch.fetch_add(1, Ordering::SeqCst) + 1,
            );
            self.grants.write().expect("browser grants").remove(session);
            self.unavailable
                .write()
                .expect("browser availability")
                .insert(session.to_owned(), "no-host".into());
        }
    }
}

// A credential and a tool catalog do not prove that an Electron host is connected.
// Status does not navigate or read a page; a blank browser is a valid host.
async fn host_connection(
    dispatcher: &dyn AgentToolDispatcher,
    context: &ToolDispatchContext,
) -> Option<String> {
    let args = serde_json::value::RawValue::from_string("{}".into()).expect("status arguments");
    let outcome = tokio::time::timeout(
        Duration::from_secs(5),
        dispatcher.dispatch_with_context(
            ToolCallView {
                id: "t3-browser-host-check",
                name: "preview_status",
                args: &args,
            },
            context,
        ),
    )
    .await
    .ok()?
    .ok()?;
    if outcome.result.is_error {
        return None;
    }
    let status: Value = serde_json::from_str(&outcome.result.text_content()).ok()?;
    status
        .get("hostConnectionId")?
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}
async fn browser_adapter(
    endpoint: &str,
    authorization: &str,
    host_connection: Option<&str>,
) -> Result<Arc<McpRouterAdapter>, GatewayError> {
    let mut headers = HashMap::from([("Authorization".into(), authorization.to_owned())]);
    if let Some(connection) = host_connection {
        headers.insert("X-T3-Preview-Host".into(), connection.to_owned());
    }
    let mut router = McpRouter::new_with_surface_handle_and_stdio_profile(
        Arc::new(meerkat_runtime::RuntimeExternalToolSurfaceHandle::ephemeral()),
        meerkat_mcp::McpStdioLaunchProfile::trusted_host(),
    );
    router
        .stage_add(McpServerConfig::streamable_http(
            "t3_preview",
            endpoint.to_owned(),
            headers,
        ))
        .map_err(|_| GatewayError::policy("Browser tool configuration failed", None))?;
    tokio::time::timeout(Duration::from_secs(15), router.apply_staged())
        .await
        .map_err(|_| GatewayError::policy("Browser tool connection timed out", None))?
        .map_err(|_| GatewayError::policy("Browser tool connection failed", None))?;
    let adapter = Arc::new(McpRouterAdapter::new(router));
    adapter
        .wait_until_ready(Duration::from_secs(15))
        .await
        .map_err(|_| GatewayError::policy("Browser tool host is not ready", None))?;
    adapter
        .refresh_tools()
        .await
        .map_err(|_| GatewayError::policy("Browser tools unavailable", None))?;
    Ok(adapter)
}
fn unavailable_status(session: &str) -> Value {
    json!({"enabled":false,"sessionId":session,"reason":"no-host","message":"The shared desktop browser is unavailable. Open this environment in the desktop app and share its browser again."})
}
#[async_trait::async_trait]
impl AgentToolDispatcher for BrowserDispatcher {
    fn tools(&self) -> Arc<[Arc<ToolDef>]> {
        self.grants
            .read()
            .ok()
            .and_then(|slots| {
                slots.values().next().map(|grant| {
                    grant
                        .dispatcher
                        .tools()
                        .iter()
                        .filter(|tool| tool.name.starts_with("preview_"))
                        .cloned()
                        .collect::<Vec<_>>()
                        .into()
                })
            })
            .unwrap_or_else(|| Arc::from([]))
    }
    fn execution_binding_epoch(&self, _: &str) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }
    async fn dispatch(&self, call: ToolCallView<'_>) -> Result<ToolDispatchOutcome, ToolError> {
        Ok(denied(&call))
    }
    async fn dispatch_with_context(
        &self,
        call: ToolCallView<'_>,
        context: &ToolDispatchContext,
    ) -> Result<ToolDispatchOutcome, ToolError> {
        let target = self.grants.read().ok().and_then(|slots| {
            context
                .origin_session_id()
                .and_then(|id| slots.get(&id.to_string()))
                .filter(|_| call.name.starts_with("preview_"))
                .map(|grant| {
                    (
                        grant.dispatcher.clone(),
                        grant.revision,
                        grant.child_guard.clone(),
                    )
                })
        });
        let Some((target, revision, child_guard)) = target else {
            return Ok(denied(&call));
        };
        let session = context
            .origin_session_id()
            .expect("granted session")
            .to_string();
        if let Some(guard) = &child_guard {
            if guard.validate().await.is_err() {
                self.revoke_expected(&session, Some(revision));
                return Ok(denied(&call));
            }
        }
        if host_connection(target.as_ref(), context).await.is_none() {
            self.revoke_if_current(&session, revision);
            return Ok(denied(&call));
        }
        if let Some(guard) = &child_guard {
            if guard.validate().await.is_err() {
                self.revoke_expected(&session, Some(revision));
                return Ok(denied(&call));
            }
        }
        if !self.current(&session, revision) {
            return Ok(denied(&call));
        }
        target.dispatch_with_context(call, context).await
    }
}
impl MeerkatGateway {
    async fn browser_target(
        &self,
        params: &serde_json::Map<String, Value>,
    ) -> Result<(Arc<BrowserDispatcher>, String), GatewayError> {
        let mob_id = required_nonempty_string(params, "mobId")?;
        let project = required_nonempty_string(params, "projectPath")?;
        let state = required_nonempty_string(params, "stateRoot")?;
        let locator = derive_project_locator(&project, Some(&state))?;
        let mob = self.mob_for_params(params, &mob_id).await?;
        let session_id = if params.get("expected").is_some() {
            let record = mob
                .validate_console_incarnation(&console_expected_target(params)?)
                .await
                .map_err(|error| {
                    GatewayError::conflict(
                        "Browser agent target is not current",
                        Some(json!({"error":error})),
                    )
                })?;
            record
                .session_id
                .ok_or_else(|| GatewayError::conflict("Agent has no native session", None))?
        } else {
            let runtime = mob
                .runtime
                .as_ref()
                .ok_or_else(|| GatewayError::policy("Native runtime unavailable", None))?;
            runtime
                .mob_handle()
                .resolve_bridge_session_id(&meerkat_mob::AgentIdentity::from(
                    mob.coordinator_identity.as_str(),
                ))
                .await
                .ok_or_else(|| GatewayError::conflict("Coordinator has no native session", None))?
                .to_string()
        };
        let proxy = scoped(Scope {
            project: locator.project_path,
            state: locator.state_root,
            mob: mob_id.clone(),
        });
        Ok((proxy, session_id))
    }

    pub(crate) async fn mobs_browser_status(
        &self,
        params: Option<&Value>,
    ) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let (proxy, session_id) = self.browser_target(params).await?;
        let granted = proxy
            .grants
            .read()
            .map_err(|_| GatewayError::policy("Browser grant unavailable", None))?
            .get(&session_id)
            .map(|grant| {
                (
                    grant.dispatcher.clone(),
                    grant.revision,
                    grant.host_thread_id.clone(),
                    grant.host_session_id.clone(),
                    grant.child_guard.clone(),
                )
            });
        let Some((dispatcher, revision, host_thread_id, host_session_id, child_guard)) = granted
        else {
            return Ok(
                if proxy
                    .unavailable
                    .read()
                    .ok()
                    .is_some_and(|states| states.contains_key(&session_id))
                {
                    unavailable_status(&session_id)
                } else {
                    json!({"enabled":false,"sessionId":session_id})
                },
            );
        };
        let context = ToolDispatchContext::default().with_runtime_identity(
            meerkat_core::SessionId::parse(&session_id)
                .map_err(|_| GatewayError::invalid("Invalid native session", None))?,
            None,
        );
        if let Some(guard) = &child_guard {
            if guard.validate().await.is_err() {
                proxy.revoke_expected(&session_id, Some(revision));
                return Ok(json!({"enabled":false,"sessionId":session_id,"reason":"revoked"}));
            }
        }
        if host_connection(dispatcher.as_ref(), &context)
            .await
            .is_none()
        {
            proxy.revoke_if_current(&session_id, revision);
            return Ok(unavailable_status(&session_id));
        }
        if let Some(guard) = &child_guard {
            if guard.validate().await.is_err() {
                proxy.revoke_expected(&session_id, Some(revision));
                return Ok(json!({"enabled":false,"sessionId":session_id,"reason":"revoked"}));
            }
        }
        if !proxy.current(&session_id, revision) {
            return Ok(json!({"enabled":false,"sessionId":session_id,"reason":"revoked"}));
        }
        let tools: Vec<_> = dispatcher
            .tools()
            .iter()
            .filter(|tool| tool.name.starts_with("preview_"))
            .map(|tool| tool.name.clone())
            .collect();
        let mut status =
            json!({"enabled":true,"sessionId":session_id,"grantRevision":revision,"tools":tools});
        if let Some(host) = &host_thread_id {
            status["hostThreadId"] = json!(host);
        }
        if let Some(session) = &host_session_id {
            status["hostSessionId"] = json!(session);
        }
        Ok(status)
    }

    pub(crate) async fn mobs_browser_configure(
        &self,
        params: Option<&Value>,
    ) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let (proxy, session_id) = self.browser_target(params).await?;
        // Revoke before reconnecting so a failed renewal cannot leave stale authority.
        let revision = proxy
            .revoke_expected(
                &session_id,
                params.get("expectedGrantRevision").and_then(Value::as_u64),
            )
            .ok_or_else(|| {
                GatewayError::conflict("Browser access changed before revocation", None)
            })?;
        if params.get("enabled").and_then(Value::as_bool) != Some(true) {
            return Ok(json!({"enabled":false,"sessionId":session_id,"reason":"revoked"}));
        }
        let child_guard = if params.get("expected").is_some() {
            let expected = console_expected_target(params)?;
            let mob_id = required_nonempty_string(params, "mobId")?;
            let mob = self.mob_for_params(params, &mob_id).await?;
            child_tools::child_grant(&mob, &expected)
                .await
                .map_err(|error| {
                    GatewayError::conflict(
                        "Native child cannot use the browser",
                        Some(json!({"error":error})),
                    )
                })?
        } else {
            None
        };
        let endpoint = required_nonempty_string(params, "endpoint")?;
        let authorization = required_nonempty_string(params, "authorizationHeader")?;
        let host_thread_id = required_nonempty_string(params, "hostThreadId")?;
        let host_session_id = required_nonempty_string(params, "hostSessionId")?;
        // T3's local server supplies the endpoint; do not turn this into an arbitrary credential forwarder.
        let url = reqwest::Url::parse(&endpoint)
            .map_err(|_| GatewayError::invalid("Invalid browser endpoint", None))?;
        if url.scheme() != "http"
            || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(GatewayError::invalid(
                "Browser tools require the local T3 tool host",
                None,
            ));
        }
        let probe = browser_adapter(&endpoint, &authorization, None).await?;
        let context = ToolDispatchContext::default().with_runtime_identity(
            meerkat_core::SessionId::parse(&session_id)
                .map_err(|_| GatewayError::invalid("Invalid native session", None))?,
            None,
        );
        let Some(connection) = host_connection(probe.as_ref(), &context).await else {
            proxy.revoke_if_current(&session_id, revision);
            return Ok(unavailable_status(&session_id));
        };
        // Bind every later operation to the broker-owned connection generation.
        // A desktop replacement must never inherit an existing explicit grant.
        let adapter = browser_adapter(&endpoint, &authorization, Some(&connection)).await?;
        let tools: Vec<_> = adapter
            .tools()
            .iter()
            .filter(|tool| tool.name.starts_with("preview_"))
            .map(|tool| tool.name.clone())
            .collect();
        if tools.is_empty() {
            return Err(GatewayError::policy(
                "This T3 session has no browser capability",
                None,
            ));
        }
        if host_connection(adapter.as_ref(), &context).await.as_deref() != Some(connection.as_str())
        {
            proxy.revoke_if_current(&session_id, revision);
            return Ok(unavailable_status(&session_id));
        }
        let (current_proxy, current_session) = self.browser_target(params).await?;
        if !Arc::ptr_eq(&proxy, &current_proxy) || current_session != session_id {
            return Err(GatewayError::conflict(
                "The native browser target changed while connecting",
                None,
            ));
        }
        if let Some(guard) = &child_guard {
            guard.validate().await.map_err(|error| {
                GatewayError::conflict(
                    "Native browser target changed while connecting",
                    Some(json!({"error":error})),
                )
            })?;
        }
        let revisions = proxy
            .revisions
            .read()
            .map_err(|_| GatewayError::policy("Browser grant unavailable", None))?;
        if revisions.get(&session_id) != Some(&revision) {
            return Err(GatewayError::conflict(
                "Browser access was changed while connecting",
                None,
            ));
        }
        proxy
            .grants
            .write()
            .map_err(|_| GatewayError::policy("Browser grant unavailable", None))?
            .insert(
                session_id.clone(),
                Grant {
                    host_session_id: Some(host_session_id.clone()),
                    host_thread_id: Some(host_thread_id.clone()),
                    dispatcher: adapter,
                    revision,
                    child_guard,
                },
            );
        proxy.epoch.fetch_add(1, Ordering::SeqCst);
        Ok(
            json!({"enabled":true,"sessionId":session_id,"grantRevision":revision,"tools":tools,"hostThreadId":host_thread_id,"hostSessionId":host_session_id}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use meerkat_core::types::SessionId;
    struct FakePreview(AtomicU64);
    #[async_trait::async_trait]
    impl AgentToolDispatcher for FakePreview {
        fn tools(&self) -> Arc<[Arc<ToolDef>]> {
            vec![
                Arc::new(ToolDef::new("preview_open", "Open preview", json!({}))),
                Arc::new(ToolDef::new("preview_status", "Preview status", json!({}))),
                Arc::new(ToolDef::new("device_click", "Device", json!({}))),
            ]
            .into()
        }
        async fn dispatch(&self, call: ToolCallView<'_>) -> Result<ToolDispatchOutcome, ToolError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(ToolResult::new(
                call.id.to_owned(),
                if call.name == "preview_status" {
                    json!({"hostConnectionId":"fixture-connection"}).to_string()
                } else {
                    "preview opened".into()
                },
                false,
            )
            .into())
        }
    }
    #[tokio::test]
    async fn browser_dispatch_requires_exact_granted_session_and_preview_tool() {
        let proxy = BrowserDispatcher::default();
        let owner = SessionId::new();
        let worker = SessionId::new();
        let inner = Arc::new(FakePreview(AtomicU64::new(0)));
        proxy.grants.write().unwrap().insert(
            owner.to_string(),
            Grant {
                host_thread_id: Some("workspace".into()),
                host_session_id: Some("credential-session".into()),
                dispatcher: inner.clone(),
                revision: 1,
                child_guard: None,
            },
        );
        proxy
            .revisions
            .write()
            .unwrap()
            .insert(owner.to_string(), 1);
        assert_eq!(proxy.tools().len(), 2);
        let args = serde_json::value::RawValue::from_string("{}".into()).unwrap();
        let call = ToolCallView {
            id: "call",
            name: "preview_open",
            args: &args,
        };
        assert!(proxy.dispatch(call).await.unwrap().result.is_error);
        let worker_context = ToolDispatchContext::default().with_runtime_identity(worker, None);
        assert!(
            proxy
                .dispatch_with_context(call, &worker_context)
                .await
                .unwrap()
                .result
                .is_error
        );
        let owner_context =
            ToolDispatchContext::default().with_runtime_identity(owner.clone(), None);
        assert!(
            !proxy
                .dispatch_with_context(call, &owner_context)
                .await
                .unwrap()
                .result
                .is_error
        );
        assert!(
            proxy
                .dispatch_with_context(
                    ToolCallView {
                        name: "device_click",
                        ..call
                    },
                    &owner_context
                )
                .await
                .unwrap()
                .result
                .is_error
        );
        assert_eq!(inner.0.load(Ordering::SeqCst), 2);
        proxy.grants.write().unwrap().remove(&owner.to_string());
        proxy.epoch.fetch_add(1, Ordering::SeqCst);
        assert_eq!(proxy.execution_binding_epoch("preview_open"), 1);
        assert!(
            proxy
                .dispatch_with_context(call, &owner_context)
                .await
                .unwrap()
                .result
                .is_error
        );
        assert!(proxy.tools().is_empty());
        assert_eq!(inner.0.load(Ordering::SeqCst), 2);
    }
    #[test]
    fn stale_cleanup_cannot_revoke_a_newer_grant() {
        let proxy = BrowserDispatcher::default();
        let first = proxy.revoke("session");
        let second = proxy.revoke("session");
        assert!(proxy.revoke_expected("session", Some(first)).is_none());
        assert!(proxy.current("session", second));
        assert!(proxy.revoke_expected("session", Some(second)).is_some());
    }
    struct MissingHost;
    #[async_trait::async_trait]
    impl AgentToolDispatcher for MissingHost {
        fn tools(&self) -> Arc<[Arc<ToolDef>]> {
            vec![Arc::new(ToolDef::new(
                "preview_status",
                "Status",
                json!({}),
            ))]
            .into()
        }
        async fn dispatch(&self, call: ToolCallView<'_>) -> Result<ToolDispatchOutcome, ToolError> {
            Ok(ToolResult::new(call.id.into(), "No host".into(), true).into())
        }
    }
    #[tokio::test]
    async fn unavailable_host_revokes_tools_and_retains_explanation() {
        let proxy = BrowserDispatcher::default();
        let session = SessionId::new();
        let revision = proxy.revoke(&session.to_string());
        proxy.grants.write().unwrap().insert(
            session.to_string(),
            Grant {
                host_thread_id: None,
                host_session_id: None,
                dispatcher: Arc::new(MissingHost),
                revision,
                child_guard: None,
            },
        );
        let args = serde_json::value::RawValue::from_string("{}".into()).unwrap();
        let result = proxy
            .dispatch_with_context(
                ToolCallView {
                    id: "call",
                    name: "preview_status",
                    args: &args,
                },
                &ToolDispatchContext::default().with_runtime_identity(session.clone(), None),
            )
            .await
            .unwrap();
        assert!(result.result.is_error);
        assert!(proxy.tools().is_empty());
        assert_eq!(
            proxy
                .unavailable
                .read()
                .unwrap()
                .get(&session.to_string())
                .map(String::as_str),
            Some("no-host")
        );
        assert!(!proxy.current(&session.to_string(), revision));
    }
    struct WaitingHost {
        checking: tokio::sync::Notify,
        resume: tokio::sync::Notify,
        mutations: AtomicU64,
    }
    #[async_trait::async_trait]
    impl AgentToolDispatcher for WaitingHost {
        fn tools(&self) -> Arc<[Arc<ToolDef>]> {
            FakePreview(AtomicU64::new(0)).tools()
        }
        async fn dispatch(&self, call: ToolCallView<'_>) -> Result<ToolDispatchOutcome, ToolError> {
            if call.name == "preview_status" {
                self.checking.notify_one();
                self.resume.notified().await;
                Ok(ToolResult::new(
                    call.id.into(),
                    json!({"hostConnectionId":"connection"}).to_string(),
                    false,
                )
                .into())
            } else {
                self.mutations.fetch_add(1, Ordering::SeqCst);
                Ok(ToolResult::new(call.id.into(), "done".into(), false).into())
            }
        }
    }
    #[tokio::test]
    async fn revocation_during_host_probe_prevents_the_browser_action() {
        let proxy = BrowserDispatcher::default();
        let host = Arc::new(WaitingHost {
            checking: tokio::sync::Notify::new(),
            resume: tokio::sync::Notify::new(),
            mutations: AtomicU64::new(0),
        });
        let session = SessionId::new();
        let revision = proxy.revoke(&session.to_string());
        proxy.grants.write().unwrap().insert(
            session.to_string(),
            Grant {
                host_thread_id: None,
                host_session_id: None,
                dispatcher: host.clone(),
                revision,
                child_guard: None,
            },
        );
        let args = serde_json::value::RawValue::from_string("{}".into()).unwrap();
        let context = ToolDispatchContext::default().with_runtime_identity(session.clone(), None);
        let (result, ()) = tokio::join!(
            proxy.dispatch_with_context(
                ToolCallView {
                    id: "call",
                    name: "preview_open",
                    args: &args
                },
                &context
            ),
            async {
                host.checking.notified().await;
                proxy.revoke(&session.to_string());
                host.resume.notify_one();
            }
        );
        assert!(result.unwrap().result.is_error);
        assert_eq!(host.mutations.load(Ordering::SeqCst), 0);
        assert!(proxy.tools().is_empty());
    }
    #[tokio::test]
    async fn published_mcp_http_adapter_routes_granted_preview_calls() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
        let calls = Arc::new(AtomicU64::new(0));
        let observed = calls.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let observed = observed.clone();
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
                                .unwrap_or(0);
                            break (headers, end + 4, length);
                        }
                    };
                    assert!(
                        headers
                            .to_lowercase()
                            .contains("authorization: bearer preview-fixture")
                    );
                    while bytes.len() < offset + length {
                        let mut chunk = [0; 4096];
                        let count = socket.read(&mut chunk).await.unwrap();
                        if count == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&chunk[..count]);
                    }
                    if headers.starts_with("GET ") {
                        socket.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                        return;
                    }
                    let request: Value =
                        serde_json::from_slice(&bytes[offset..offset + length]).unwrap();
                    let Some(id) = request.get("id") else {
                        socket.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                        return;
                    };
                    let result = match request["method"].as_str().unwrap() {
                        "initialize" => {
                            json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"preview-fixture","version":"1"}})
                        }
                        "tools/list" => {
                            json!({"tools":[{"name":"preview_open","description":"Open preview","inputSchema":{"type":"object"}},{"name":"preview_status","description":"Preview status","inputSchema":{"type":"object"}}]})
                        }
                        "tools/call" => {
                            if request["params"]["name"] == "preview_status" {
                                json!({"content":[{"type":"text","text":"{\"available\":false,\"hostConnectionId\":\"fixture-connection\"}"}],"isError":false})
                            } else {
                                assert_eq!(request["params"]["name"], "preview_open");
                                observed.fetch_add(1, Ordering::SeqCst);
                                json!({"content":[{"type":"text","text":"preview opened"}],"isError":false})
                            }
                        }
                        other => panic!("Unexpected MCP method {other}"),
                    };
                    let body = json!({"jsonrpc":"2.0","id":id,"result":result}).to_string();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    socket.write_all(response.as_bytes()).await.unwrap();
                });
            }
        });
        let mut router = McpRouter::new_with_surface_handle_and_stdio_profile(
            Arc::new(meerkat_runtime::RuntimeExternalToolSurfaceHandle::ephemeral()),
            meerkat_mcp::McpStdioLaunchProfile::trusted_host(),
        );
        router
            .stage_add(McpServerConfig::streamable_http(
                "t3_preview",
                endpoint,
                HashMap::from([("Authorization".into(), "Bearer preview-fixture".into())]),
            ))
            .unwrap();
        router.apply_staged().await.unwrap();
        let adapter = Arc::new(McpRouterAdapter::new(router));
        adapter
            .wait_until_ready(Duration::from_secs(5))
            .await
            .unwrap();
        adapter.refresh_tools().await.unwrap();
        let owner = SessionId::new();
        let proxy = BrowserDispatcher::default();
        proxy.grants.write().unwrap().insert(
            owner.to_string(),
            Grant {
                host_thread_id: None,
                host_session_id: None,
                dispatcher: adapter,
                revision: 1,
                child_guard: None,
            },
        );
        proxy
            .revisions
            .write()
            .unwrap()
            .insert(owner.to_string(), 1);
        assert!(proxy.tools().iter().any(|tool| tool.name == "preview_open"));
        let args = serde_json::value::RawValue::from_string("{}".into()).unwrap();
        let result = proxy
            .dispatch_with_context(
                ToolCallView {
                    id: "call",
                    name: "preview_open",
                    args: &args,
                },
                &ToolDispatchContext::default().with_runtime_identity(owner, None),
            )
            .await
            .unwrap();
        assert!(!result.result.is_error);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        server.abort();
    }
}
