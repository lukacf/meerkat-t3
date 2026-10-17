#![cfg_attr(test, recursion_limit = "256")]

use chrono::{TimeZone, Utc};
use meerkat_core::derive_workspace_realm_id;
use meerkat_core::event::{AgentEvent, EventEnvelope};
use meerkat_core::lifecycle::run_primitive::{
    AnthropicProviderTag, GeminiProviderTag, ModelId, OpenAiProviderTag, ProviderParamsOverride,
    ProviderTag, TurnMetadataOverride,
};
use meerkat_core::service::{SessionHistoryQuery, SessionServiceHistoryExt, TurnToolOverlay};
use meerkat_core::types::{ContentInput, ContentBlock, HandlingMode, SessionId};
use meerkat_core::{
    apply_config_patch_preview, ConfigDelta, ConfigRuntimeError, Provider, SessionLlmIdentity,
};
use meerkat_desktop_contracts::{
    DesktopLiveRunEvent, EventEmit, RequestContext, RpcRequest, RpcResponse,
};
use meerkat_mob::{AgentIdentity, MemberTurnOptions};
use meerkat_mobkit::{
    SameProcessTopologyCoordinator, TopologyAction, TopologyBilateralApplyRequest,
    TopologyControlError, TopologyEdge, TopologyEndpoint, TopologyMutation,
};
use mobkit_registry::{
    compose_effective_realm_config, effective_config_snapshot, load_effective_realm_config,
    local_member_pair_metadata, member_llm_identity, mobkit_rpc, realm_config_runtime,
    send_peer_message, send_to_member, start_member_turn_content as start_mobkit_member_turn,
    CreateMobInput, MobkitMobRuntime, ProjectMobkitRegistry,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Weak};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use thiserror::Error;
use tokio::sync::{broadcast, oneshot, Mutex, Notify};
use tracing::{debug, info, warn};
use uuid::Uuid;

pub mod host_tools;
pub use meerkat_providers::auth_store::CredentialSettlement;
mod shared_specialist;
mod mobkit_registry;
mod media;
mod browser_bridge;
mod provider_auth;
mod desktop_auth_scope;
mod user_questions;
mod native_model;
mod native_work;
mod coordinator_work;
mod native_steering;
mod native_history;
mod native_receipt;
mod native_search;
mod native_transcript;
mod native_usage;
mod thread_followups;
mod thread_deliveries;
mod thread_recovery;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod native_process_custody;
mod thread_dispose;
mod auxiliary_generation;
mod native_responsibilities;
mod native_distribution;
mod native_skills;
mod native_skill_events;
mod native_execution_modes;
mod native_approvals;
mod native_checkpoints;
#[cfg(test)]
mod native_containment_probe;
#[cfg(test)]
mod native_scale_probe;

use host_tools::{
    DesktopHostInvocationWitnessV1, DesktopHostToolCompleteV1, DesktopHostToolNotificationV1,
    DesktopHostToolsConfigureV1, HostToolTransport, HostToolTransportError,
};

const DESKTOP_INTERACTIVE_TURN_INGRESS_KIND: &str = "desktop_interactive_turn";

#[derive(Clone)]
pub struct MeerkatGateway {
    inner: Arc<GatewayInner>,
}

struct GatewayInner {
    booted_at: chrono::DateTime<Utc>,
    shutting_down: AtomicBool,
    shutdown_lock: Mutex<()>,
    project_runtimes: Mutex<HashMap<String, Arc<ProjectRuntimeHandle>>>,
    mobkit_registries: Mutex<HashMap<PathBuf, Arc<ProjectMobkitRegistry>>>,
    topology_coordinators: Mutex<HashMap<PathBuf, Weak<SameProcessTopologyCoordinator>>>,
    events_tx: broadcast::Sender<EventEmit>,
    host_tools: Arc<HostToolTransport>,
    provider_auth: provider_auth::DesktopProviderAuth,
    shared_tools: Arc<shared_specialist::SharedWorkspaceHost>,
}

struct ProjectRuntimeHandle {
    state: Mutex<ProjectRuntimeState>,
    runs_settled: Notify,
}

struct ProjectRuntimeState {
    locator: ProjectLocator,
    execution_path: PathBuf,
    execution_mode: String,
    instance_id: String,
    mobkit: Arc<ProjectMobkitRegistry>,
    active_runs: HashMap<String, ActiveRun>,
    member_turn_locks: HashMap<String, Arc<Mutex<()>>>,
    dirty: bool,
}

/// Reserve a thread's active-run slot while the caller holds the project-state
/// mutex. The builder is invoked only for the winning request, so a concurrent
/// loser cannot emit `run.started`, spawn turn work, or overwrite the winner.
fn admit_active_run_locked(
    state: &mut ProjectRuntimeState,
    thread_id: &str,
    build_active_run: impl FnOnce() -> ActiveRun,
) -> Result<(), ActiveRun> {
    match state.active_runs.entry(thread_id.to_string()) {
        std::collections::hash_map::Entry::Occupied(entry) => Err(entry.get().clone()),
        std::collections::hash_map::Entry::Vacant(entry) => {
            entry.insert(build_active_run());
            Ok(())
        }
    }
}

#[derive(Clone)]
struct ActiveRun {
    run_id: String,
    mob_id: String,
    agent_identity: String,
    started_at: chrono::DateTime<Utc>,
    deliveries: AppRunDeliveries,
    projection: Arc<Mutex<RunEventProjection>>,
}

#[derive(Clone)]
struct AppRunDeliveries {
    pending: usize,
    finalizing: bool,
    pending_finalization: Option<RunFinalization>,
    finalization_error: Option<String>,
    failure: Option<RunFailure>,
    cancellation_requested: bool,
    cancellation_requests_pending: usize,
}

impl Default for AppRunDeliveries {
    fn default() -> Self {
        Self {
            pending: 1,
            finalizing: false,
            pending_finalization: None,
            finalization_error: None,
            failure: None,
            cancellation_requested: false,
            cancellation_requests_pending: 0,
        }
    }
}

#[derive(Clone)]
struct RunFinalization {
    event: EventEmit,
    status: &'static str,
    message: Option<String>,
    attribution: Option<thread_followups::Attribution>,
    followup: Option<thread_followups::Attribution>,
}

impl AppRunDeliveries {
    fn is_cancelling(&self) -> bool {
        self.cancellation_requested || self.cancellation_requests_pending > 0
    }
}

#[derive(Default)]
struct RunEventProjection {
    seen: HashSet<Uuid>,
    assembler: LiveEventAssembler,
    native_identity_ready: Arc<Notify>,
    emitted: bool,
    presentation: Arc<Mutex<()>>,
    delivery_scope: Option<thread_followups::Attribution>,
    followup: Option<thread_followups::Attribution>,
    followup_failed: bool,
    pending_events: Vec<EventEnvelope<AgentEvent>>,
}

impl RunEventProjection {
    fn bind_input_attribution(
        &mut self,
        agent_identity: &str,
        attribution: thread_followups::Attribution,
    ) -> Result<(), GatewayError> {
        // Every admitted member has input-owned output. Peer followup capture
        // remains restricted to the existing ingress coordinator boundary.
        let followup = if agent_identity == "ingress" {
            thread_followups::begin(&attribution)?;
            Some(attribution.clone())
        } else {
            None
        };
        self.delivery_scope = Some(attribution);
        self.followup = followup;
        Ok(())
    }
}

#[derive(Clone, Debug)]
enum RunFailure {
    Failed(String),
    Delivery(String),
    Cancelled,
}

impl RunFailure {
    fn from_report(report: &meerkat_core::event::AgentErrorReport) -> Self {
        if report.class == meerkat_core::event::AgentErrorClass::Cancelled {
            Self::Cancelled
        } else {
            Self::Failed(report.message.clone())
        }
    }

    fn from_interaction(reason: &meerkat_core::event::InteractionFailureReason) -> Self {
        if matches!(
            reason,
            meerkat_core::event::InteractionFailureReason::Cancelled
        ) {
            Self::Cancelled
        } else {
            Self::Failed(reason.to_string())
        }
    }
}

impl From<String> for RunFailure {
    fn from(error: String) -> Self {
        Self::Failed(error)
    }
}

impl std::fmt::Display for RunFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Failed(error) | Self::Delivery(error) => formatter.write_str(error),
            Self::Cancelled => formatter.write_str("Run cancelled."),
        }
    }
}

#[derive(Clone)]
struct ProjectLocator {
    project_path: PathBuf,
    state_root: PathBuf,
    context_root: PathBuf,
    realm_id: String,
}

#[derive(Default)]
struct LiveEventAssembler {
    pending_tools: HashMap<String, PendingToolCall>,
    started_tool_ids: HashSet<String>,
    finished_tool_ids: HashSet<String>,
    assistant_delta_text: String,
    assistant_delta_emitted: bool,
    assistant_final_emitted: bool,
    native_session_id: Option<String>,
    native_run_id: Option<meerkat_core::RunId>,
    native_segment_id: Option<String>,
    delivery_scope: Option<thread_followups::Attribution>,
    followup_scope: Option<thread_followups::Attribution>,
}

#[derive(Clone, Default)]
struct PendingToolCall {
    name: String,
    command: Option<String>,
}

#[derive(serde::Deserialize)]
struct ShellCommandResult {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

fn shell_command_result(value: &Value) -> Option<ShellCommandResult> {
    match value {
        Value::String(text) => serde_json::from_str(text).ok(),
        Value::Array(blocks) => blocks.iter().find_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("structured"))
                .then(|| block.get("data"))
                .flatten()
                .and_then(|data| serde_json::from_value(data.clone()).ok())
        }),
        Value::Object(_) => serde_json::from_value(value.clone()).ok(),
        _ => None,
    }
}

#[derive(Clone, Debug)]
struct RestoredTranscriptEntry {
    role: String,
    kind: String,
    content: String,
    created_at: Option<String>,
}

impl Default for MeerkatGateway {
    fn default() -> Self {
        Self::new()
    }
}

async fn settle_credentials_with_deadline<F>(
    deadline: tokio::time::Instant,
    settle: impl FnOnce(Duration) -> F,
) -> CredentialSettlement
where
    F: std::future::Future<Output = CredentialSettlement>,
{
    // Admitted host writes already retain the runtime's request-join horizon.
    // This final observation must not give an unanswered OS prompt that entire
    // horizon again. Core keeps custody until physical completion or exit, and
    // its currentness rules reconcile any unsettled write on the next start.
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    settle(remaining.min(Duration::from_secs(10))).await
}

impl MeerkatGateway {
    pub fn new() -> Self {
        let (events_tx, _) = broadcast::channel(4096);
        let host_tools = HostToolTransport::new();
        Self {
            inner: Arc::new(GatewayInner {
                booted_at: Utc::now(),
                shutting_down: AtomicBool::new(false),
                shutdown_lock: Mutex::new(()),
                project_runtimes: Mutex::new(HashMap::new()),
                mobkit_registries: Mutex::new(HashMap::new()),
                topology_coordinators: Mutex::new(HashMap::new()),
                events_tx,
                host_tools,
                provider_auth: provider_auth::DesktopProviderAuth::new(),
                shared_tools: Arc::new(shared_specialist::SharedWorkspaceHost::default()),
            }),
        }
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<EventEmit> {
        self.inner.events_tx.subscribe()
    }

    pub fn subscribe_host_tool_notifications(
        &self,
    ) -> broadcast::Receiver<DesktopHostToolNotificationV1> {
        self.inner.host_tools.subscribe()
    }

    pub fn host_tool_connection_id(&self) -> &str {
        self.inner.host_tools.connection_id()
    }

    pub async fn disconnect_host_tools(&self) {
        self.inner.host_tools.disconnect().await;
    }

    pub fn shutdown_horizon() -> Duration {
        meerkat_mobkit::gateway_composition::GATEWAY_RUNTIME_SHUTDOWN_TIMEOUT
            + Duration::from_secs(15)
    }

    /// Close admission before draining the exact registries this gateway owns.
    /// Native shutdown retains durable history and owns descendant cleanup.
    pub async fn shutdown(&self) -> Vec<String> {
        self.inner.shutting_down.store(true, Ordering::SeqCst);
        let _shutdown_guard = self.inner.shutdown_lock.lock().await;
        self.disconnect_host_tools().await;
        let registries = self.owned_mobkit_registries().await;
        let mut errors: Vec<String> = futures_util::future::join_all(registries.iter().map(|registry| registry.shutdown()))
            .await.into_iter().flatten().collect();
        let handles = self.inner.project_runtimes.lock().await.values().cloned().collect::<Vec<_>>();
        let delivery_results = futures_util::future::join_all(handles.iter().map(|handle| async {
            tokio::time::timeout(Duration::from_secs(15), async {
                loop {
                    let settled = handle.runs_settled.notified();
                    tokio::pin!(settled);
                    settled.as_mut().enable();
                    retry_run_finalizations(&self.inner.events_tx, handle).await;
                    let state = handle.state.lock().await;
                    if let Some(error) = state.active_runs.values().find_map(|run| run.deliveries.finalization_error.clone()) {
                        return Err(error);
                    }
                    if state.active_runs.is_empty() { return Ok(()); }
                    drop(state);
                    settled.await;
                }
            }).await.unwrap_or_else(|_| Err("Native shutdown ended before conversation delivery settled".into()))
        })).await;
        errors.extend(delivery_results.into_iter().filter_map(Result::err));
        errors
    }

    async fn owned_mobkit_registries(&self) -> Vec<Arc<ProjectMobkitRegistry>> {
        // Match project-handle creation's lock order. Shutdown closes gateway
        // admission before either phase snapshots these exact registries.
        let runtimes = self.inner.project_runtimes.lock().await;
        let mut registries = self.inner.mobkit_registries.lock().await.values().cloned().collect::<Vec<_>>();
        for handle in runtimes.values() {
            let registry = Arc::clone(&handle.state.lock().await.mobkit);
            if !registries.iter().any(|existing| Arc::ptr_eq(existing, &registry)) {
                registries.push(registry);
            }
        }
        registries
    }

    /// The stdio owner calls this after shutdown and admitted request joins.
    /// Retained observer tasks survive a caller deadline without authorizing
    /// any deletion or claiming that unrelated databases have been drained.
    pub async fn drain_storage_observers(&self) -> Vec<String> {
        if !self.inner.shutting_down.load(Ordering::SeqCst) {
            return vec!["Cannot drain mob observers before gateway shutdown".into()];
        }
        let _shutdown_guard = self.inner.shutdown_lock.lock().await;
        let registries = self.owned_mobkit_registries().await;
        let mut failures = Vec::new();
        for registry in registries {
            failures.extend(registry.drain_storage_observers().await);
        }
        failures
    }

    /// Observe physical credential work only after this gateway has closed
    /// admission and its producers and admitted requests have settled.
    pub async fn settle_credential_mutations(&self, deadline: tokio::time::Instant) -> Result<CredentialSettlement, String> {
        if !self.inner.shutting_down.load(Ordering::SeqCst) {
            return Err("Cannot settle credential work before gateway shutdown".into());
        }
        Ok(settle_credentials_with_deadline(deadline,
            meerkat_providers::auth_store::settle_in_flight_credential_mutations).await)
    }

    pub async fn handle(&self, request: RpcRequest, ctx: RequestContext) -> RpcResponse {
        let started = std::time::Instant::now();
        let method_log: String = request.method.chars().take(128).collect();
        debug!(target: "meerkat_desktop_gateway::rpc", trace_id = %ctx.trace_id, method = %method_log, "rpc.request");

        if request.jsonrpc != "2.0" {
            return RpcResponse::err(
                request.id,
                -32602,
                "Invalid JSON-RPC version",
                "INVALID_JSONRPC_VERSION",
                ctx.trace_id,
                None,
            );
        }

        match self.dispatch(&request).await {
            Ok(result) => {
                info!(
                    target: "meerkat_desktop_gateway::rpc",
                    trace_id = %ctx.trace_id,
                    method = %method_log,
                    duration_ms = started.elapsed().as_millis() as u64,
                    "rpc.ok"
                );
                RpcResponse::ok(request.id, result)
            }
            Err(err) => {
                warn!(
                    target: "meerkat_desktop_gateway::rpc",
                    trace_id = %ctx.trace_id,
                    method = %method_log,
                    duration_ms = started.elapsed().as_millis() as u64,
                    error = %err,
                    "rpc.err"
                );
                err_to_response(request.id, err, ctx.trace_id)
            }
        }
    }

    async fn dispatch(&self, request: &RpcRequest) -> Result<Value, GatewayError> {
        if self.inner.shutting_down.load(Ordering::SeqCst) {
            return Err(GatewayError::conflict("Gateway is shutting down", None));
        }
        match request.method.as_str() {
            "text.v1.generate" => auxiliary_generation::generate(request.params.as_ref(), &self.inner.provider_auth).await,
            "approvals.v1.list" => native_approvals::dispatch(self, request.params.as_ref(), false).await,
            "approvals.v1.decide" => {
                ensure_request_id(request)?;
                native_approvals::dispatch(self, request.params.as_ref(), true).await
            }
            "questions.v1.list" | "questions.v1.answer" => {
                ensure_request_id(request)?;
                let params = object_params(request.params.as_ref())?;
                let project_path = required_string(params, "projectPath")?;
                let state_root = optional_string(params, "stateRoot");
                let locator = derive_project_locator(&project_path, state_root.as_deref())?;
                let mob_id = required_string(params, "mobId")?;
                if request.method == "questions.v1.list" {
                    user_questions::list(locator.project_path, locator.state_root, mob_id, optional_string(params, "sessionId"))
                } else {
                    let answers = serde_json::from_value(params.get("answers").cloned().unwrap_or_else(|| json!([])))
                        .map_err(|_| GatewayError::invalid("Invalid question answers", None))?;
                    user_questions::answer(locator.project_path, locator.state_root, mob_id,
                        required_string(params, "sessionId")?, required_string(params, "requestId")?, answers,
                        params.get("dismissed").and_then(Value::as_bool).unwrap_or(false))
                }
            }
            "sharedTools.v1.configure" => {
                ensure_request_id(request)?;
                let params = parse_closed_params::<shared_specialist::SharedToolsConfigure>(request.params.as_ref())?;
                self.inner.shared_tools.configure(params)
                    .map_err(|message| GatewayError::invalid(message, None))?;
                Ok(json!({"configured": true}))
            }
            "desktop.hostTools.configure.v1" => {
                ensure_request_id(request)?;
                let params =
                    parse_closed_params::<DesktopHostToolsConfigureV1>(request.params.as_ref())?;
                let ack = self
                    .inner
                    .host_tools
                    .configure(params)
                    .await
                    .map_err(GatewayError::host_tools)?;
                serde_json::to_value(ack).map_err(|_| {
                    GatewayError::host_tools(HostToolTransportError::InternalUnavailable)
                })
            }
            "desktop.hostTools.complete.v1" => {
                ensure_request_id(request)?;
                let params =
                    parse_closed_params::<DesktopHostToolCompleteV1>(request.params.as_ref())?;
                let ack = self
                    .inner
                    .host_tools
                    .complete(params)
                    .await
                    .map_err(GatewayError::host_tools)?;
                serde_json::to_value(ack).map_err(|_| {
                    GatewayError::host_tools(HostToolTransportError::InternalUnavailable)
                })
            }
            "configs.v1.get" => self.configs_get(request.params.as_ref()).await,
            "configs.v1.patch" => self.configs_patch(request.params.as_ref()).await,
            "models.v1.catalog" => self.models_catalog(request.params.as_ref()).await,
            "auth.v1.status" => {
                self.inner
                    .provider_auth
                    .status(request.params.as_ref())
                    .await
            }
            "auth.v1.configure" => self.inner.provider_auth.configure(request.params.as_ref()).await,
            "auth.v1.check" => self.inner.provider_auth.check(request.params.as_ref()).await,
            "auth.v1.deviceStart" => self.inner.provider_auth.device_start(request.params.as_ref()).await,
            "auth.v1.devicePoll" => self.inner.provider_auth.device_poll(request.params.as_ref()).await,
            "auth.v1.delete" => self.inner.provider_auth.delete_account(request.params.as_ref()).await,
            "auth.v1.default" => self.inner.provider_auth.set_default(request.params.as_ref()).await,
            "auth.v1.loginStart" => {
                self.inner
                    .provider_auth
                    .login_start(request.params.as_ref())
                    .await
            }
            "auth.v1.loginComplete" => {
                self.inner
                    .provider_auth
                    .login_complete(request.params.as_ref())
                    .await
            }
            "auth.v1.logout" => {
                self.inner
                    .provider_auth
                    .logout(request.params.as_ref())
                    .await
            }
            "system.v1.health" => self.system_health().await,
            "system.v1.capabilities" => self.system_capabilities().await,
            "system.v1.projectRuntimeInfo" => {
                self.system_project_runtime_info(request.params.as_ref())
                    .await
            }
            "mobs.v1.list" => self.mobs_list(request.params.as_ref()).await,
            "mobs.v1.teamSnapshot" => self.mobs_team_snapshot(request.params.as_ref()).await,
            "mobs.v1.snapshot" => self.mobs_snapshot(request.params.as_ref()).await,
            "mobs.v1.members" => self.mobs_members(request.params.as_ref()).await,
            "mobs.v1.events" => self.mobs_events(request.params.as_ref()).await,
            "mobs.v1.recoverThread" => self.mobs_recover_thread(request.params.as_ref()).await,
            "mobs.v1.runStatus" => self.mobs_run_status(request.params.as_ref()).await,
            "mobs.v1.consoleHistory" => native_history::read(request.params.as_ref()).await,
            "mobs.v1.usageSnapshot" => native_usage::read(request.params.as_ref()).await,
            "mobs.v1.consoleReceipt" => native_steering::read_receipt(request.params.as_ref()).await,
            "mobs.v1.consoleSearch" => native_search::search(request.params.as_ref()).await,
            "mobs.v1.checkpointScope" => native_checkpoints::resolve_scope(self, request.params.as_ref()).await,
            "skills.v1.list" => native_skills::list(request.params.as_ref()).await,
            "mobs.v1.consoleResume" => {
                let params = object_params(request.params.as_ref())?;
                let expected = console_expected_target(params)?;
                let mob_id = required_mob_id(params)?;
                let mob = self.mob_for_params(params, &mob_id).await?;
                native_history::resume(&mob, &expected).await
            },
            "mobs.v1.consoleStopCrew" => {
                let params = object_params(request.params.as_ref())?;
                let expected = console_expected_target(params)?;
                let mob_id = required_mob_id(params)?;
                let mob = self.mob_for_params(params, &mob_id).await?;
                native_history::stop_crew(&mob, &expected).await
            },
            "mobs.v1.threadFollowups" => self.mobs_thread_followups(request.params.as_ref()).await,
            "mobs.v1.threadDeliveries" => self.mobs_thread_deliveries(request.params.as_ref(), false).await,
            "mobs.v1.acknowledgeThreadDelivery" => self.mobs_thread_deliveries(request.params.as_ref(), true).await,
            "mobs.v1.consoleTimeline" => self.mobs_console_timeline(request.params.as_ref()).await,
            "mobs.v1.memberSend" => self.mobs_member_send(request.params.as_ref()).await,
            "mobs.v1.browserStatus" => self.mobs_browser_status(request.params.as_ref()).await,
            "mobs.v1.browserConfigure" => self.mobs_browser_configure(request.params.as_ref()).await,
            "mobs.v1.imageUpload" => self.mobs_image_upload(request.params.as_ref()).await,
            "mobs.v1.imageRead" => self.mobs_image_read(request.params.as_ref()).await,
            "mobs.v1.consoleSend" => self.mobs_console_send(request.params.as_ref()).await,
            "mobs.v1.consoleStop" => self.mobs_console_stop(request.params.as_ref()).await,
            "mobs.v1.consoleStatus" => self.mobs_console_status(request.params.as_ref()).await,
            "mobs.v1.coordinatorWork" => self.mobs_coordinator_work(request.params.as_ref()).await,
            "mobs.v1.coordinatorStop" => self.mobs_coordinator_stop(request.params.as_ref()).await,
            "mobs.v1.coordinatorSteer" => self.mobs_coordinator_steer(request.params.as_ref()).await,
            "mobs.v1.coordinatorSteerReceipt" => coordinator_work::coordinator_steer_receipt(request.params.as_ref()).await,
            "mobs.v1.peerMessage" => self.mobs_peer_message(request.params.as_ref()).await,
            "mobs.v1.memberAsk" => self.mobs_member_ask(request.params.as_ref()).await,
            "mobs.v1.forceCancel" => self.mobs_force_cancel(request.params.as_ref()).await,
            "mobs.v1.destroy" => self.mobs_destroy(request.params.as_ref()).await,
            "mobs.v1.createThreadMob" => self.mobs_create_thread_mob(request.params.as_ref()).await,
            "mobs.v1.createDomainMob" => self.mobs_create_domain_mob(request.params.as_ref()).await,
            "mobs.v1.domainRevise" => {
                let params = object_params(request.params.as_ref())?;
                let mob_id = required_string(params, "mobId")?;
                let mob = self.mob_for_params(params, &mob_id).await?;
                native_responsibilities::revise(&mob, params).await
            }
            "mobs.v1.createSubMob" => self.mobs_create_sub_mob(request.params.as_ref()).await,
            "mobs.v1.registerRemoteTcp" => {
                self.mobs_register_remote_tcp(request.params.as_ref()).await
            }
            "mobs.v1.topologyPair" => self.mobs_topology_pair(request.params.as_ref()).await,
            "mobs.v1.peerLocal" => self.mobs_peer_local(request.params.as_ref()).await,
            "mobs.v1.unpeerLocal" => self.mobs_unpeer_local(request.params.as_ref()).await,
            "mobs.v1.turnStart" => self.mobs_turn_start(request.params.as_ref()).await,
            "mobkit/cross_mob/peer_info"
            | "mobkit/cross_mob/wire_local"
            | "mobkit/cross_mob/unwire_local"
            | "mobkit/peer_pubkey"
            | "mobkit/cross_mob/directory"
            | "mobkit/cross_mob/wire"
            | "mobkit/cross_mob/unwire"
            | "mobkit/cross_mob/send" => {
                self.mobkit_runtime_rpc(request.method.as_str(), request.params.as_ref())
                    .await
            }
            "events.v1.subscribe" | "events.v1.unsubscribe" => Ok(json!({"ok": true})),
            "debug.v1.clearProjectRuntimes" => self.debug_clear_project_runtimes().await,
            _ => Err(GatewayError::not_found(
                "Unknown method",
                Some(json!({"method": request.method})),
            )),
        }
    }

    async fn models_catalog(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        if !params.contains_key("projectPath") {
            return self.inner.provider_auth.global_models_catalog().await;
        }
        let project_path = required_string(params, "projectPath")?;
        let config_state_root = optional_string(params, "configStateRoot")
            .or_else(|| optional_string(params, "stateRoot"));
        let locator = derive_project_locator(&project_path, config_state_root.as_deref())?;
        let realm_config = load_effective_realm_config(&locator.project_path, &locator.state_root)
            .await
            .map_err(|error| {
                GatewayError::policy(
                    "Failed to load the workspace model configuration",
                    Some(json!({"error": error})),
                )
            })?;
        let catalog = self.inner.provider_auth.account_models_catalog(params).await?;
        Ok(json!({
            "projectPath": locator.project_path,
            "configStateRoot": locator.state_root,
            "realmId": realm_config.realm_id.to_string(),
            "catalog": {
                "contract_version": "models-catalog.v1",
                "providers": catalog
                    .get("providers")
                    .cloned()
                    .unwrap_or_else(|| Value::Array(Vec::new())),
            }
        }))
    }

    /// Read exact app submission correspondence and native-witnessed terminal state.
    /// Absence is unknown, never evidence that input was not accepted.
    async fn mobs_run_status(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let project_path = required_nonempty_string(params, "projectPath")?;
        let run_id = required_nonempty_string(params, "runId")?;
        let locator = derive_project_locator(&project_path, optional_string(params, "stateRoot").as_deref())?;
        let submission = thread_recovery::read(&locator.state_root, &run_id)?;
        let thread = optional_string(params, "threadId");
        let mob = optional_string(params, "mobId");
        if submission.as_ref().is_some_and(|record|
            thread.as_ref().is_some_and(|thread|thread != &record.thread_id) ||
            mob.as_ref().is_some_and(|mob|mob != &record.mob_id)) {
            return Err(GatewayError::conflict("Run status target does not match its recorded submission", None));
        }
        if submission.as_ref().is_some_and(|record|record.status == "recovered") {
            return Ok(json!({"runId":run_id,"threadId":thread,"mobId":mob,"status":"recovered","outcome":"unresolved"}));
        }
        let handles = self.inner.project_runtimes.lock().await.values().cloned().collect::<Vec<_>>();
        for handle in handles {
            retry_run_finalizations(&self.inner.events_tx, &handle).await;
            let state = handle.state.lock().await;
            if state.locator.state_root != locator.state_root { continue; }
            for (active_thread, active) in &state.active_runs {
                if active.run_id != run_id { continue; }
                if thread.as_ref().is_some_and(|thread|thread != active_thread) || mob.as_ref().is_some_and(|mob|mob != &active.mob_id) {
                    return Err(GatewayError::conflict("Run status target does not match the active submission", None));
                }
                if active.deliveries.finalizing {
                    return Ok(json!({"runId":run_id,"threadId":active_thread,"mobId":active.mob_id,
                        "status":"unknown","canRecover":false,"recoveryReason":
                        active.deliveries.finalization_error.clone().unwrap_or_else(||"Execution ended. Its final result is still being saved; refresh to retry delivery.".into())}));
                }
                return Ok(json!({"runId":run_id,"threadId":active_thread,"mobId":active.mob_id,"status":"running"}));
            }
        }
        let record = lookup_terminal_run(&locator.state_root, &run_id);
        if record.as_ref().is_some_and(|record| thread.as_ref().is_some_and(|thread|record.get("threadId").and_then(Value::as_str) != Some(thread.as_str()))) {
            return Err(GatewayError::conflict("Terminal receipt belongs to a different thread", None));
        }
        let status = record.as_ref().and_then(|record|record.get("status").and_then(Value::as_str))
            .or_else(||submission.as_ref().filter(|record|["completed","failed","cancelled"].contains(&record.status.as_str())).map(|record|record.status.as_str()))
            .unwrap_or("unknown");
        let cold_uncontained = submission.as_ref().is_some_and(|record|
            record.owner() != thread_recovery::gateway_owner(self) && record.may_have_dispatched()
                && !record.supports_native_recovery());
        let recovery_reason = if cold_uncontained {
            Some("This operation predates native process custody or lost its session binding. Its tool cleanup cannot be proven; this operation remains unresolved.")
        } else if submission.is_none() {
            Some("This older operation has no durable ownership record. Its outcome cannot be safely cleared.")
        } else { None };
        Ok(json!({"projectPath":locator.project_path,"stateRoot":locator.state_root,"runId":run_id,
            "threadId":thread,"mobId":mob,"status":status,"record":record,
            "canRecover":submission.is_some() && !cold_uncontained,"recoveryReason":recovery_reason,"submissionStatus":submission.map(|record|record.status)}))
    }

    async fn configs_get(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let project_path = required_string(params, "projectPath")?;
        let config_state_root = optional_string(params, "configStateRoot")
            .or_else(|| optional_string(params, "stateRoot"));
        let locator = derive_project_locator(&project_path, config_state_root.as_deref())?;
        let realm_config = load_effective_realm_config(&locator.project_path, &locator.state_root)
            .await
            .map_err(|error| {
                GatewayError::policy(
                    "Failed to load the workspace configuration",
                    Some(json!({"error": error})),
                )
            })?;
        let snapshot = realm_config_runtime(&realm_config, &locator.state_root)
            .get()
            .await
            .map_err(config_runtime_error)?;
        let (effective, generation) = effective_config_snapshot(&realm_config, snapshot)
            .await
            .map_err(|error| {
                GatewayError::policy(
                    "Failed to compose the workspace configuration",
                    Some(json!({"error": error})),
                )
            })?;
        Ok(json!({
            "projectPath": locator.project_path,
            "stateRoot": locator.state_root,
            "configStateRoot": locator.state_root,
            "contextRoot": locator.context_root,
            "realmId": realm_config.realm_id.to_string(),
            "config": {
                "envelope": {
                    "generation": generation,
                    "realmId": realm_config.realm_id.to_string(),
                    "config": desktop_runtime_config_projection(&effective),
                }
            }
        }))
    }

    async fn configs_patch(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let project_path = required_string(params, "projectPath")?;
        let config_state_root = optional_string(params, "configStateRoot")
            .or_else(|| optional_string(params, "stateRoot"));
        let locator = derive_project_locator(&project_path, config_state_root.as_deref())?;
        let patch = params
            .get("patch")
            .cloned()
            .ok_or_else(|| GatewayError::invalid("Missing patch", None))?;
        if !patch.is_object() {
            return Err(GatewayError::invalid(
                "patch must be a JSON merge-patch object",
                Some(json!({"patch": patch})),
            ));
        }
        validate_desktop_config_patch(&patch)?;
        let expected_generation = optional_generation(params, "expectedGeneration")?;
        let realm_config = load_effective_realm_config(&locator.project_path, &locator.state_root)
            .await
            .map_err(|error| {
                GatewayError::policy(
                    "Failed to load the workspace configuration",
                    Some(json!({"error": error})),
                )
            })?;
        let runtime = realm_config_runtime(&realm_config, &locator.state_root);
        let baseline = runtime.get().await.map_err(config_runtime_error)?;
        if let Some(expected) = expected_generation {
            if expected != baseline.generation {
                return Err(config_runtime_error(
                    ConfigRuntimeError::GenerationConflict {
                        expected,
                        current: baseline.generation,
                    },
                ));
            }
        }
        let preview_raw =
            apply_config_patch_preview(&baseline.config, patch.clone()).map_err(|error| {
                GatewayError::invalid(
                    "Workspace configuration patch is invalid",
                    Some(json!({"error": error.to_string()})),
                )
            })?;
        // Validate the inherited/effective result before committing the raw
        // head. ConfigRuntime's CAS then closes the preview/write race even
        // when the caller intentionally omitted expectedGeneration.
        compose_effective_realm_config(&realm_config, preview_raw.clone())
            .await
            .map_err(|error| {
                GatewayError::invalid(
                    "Workspace configuration patch is invalid",
                    Some(json!({"error": error})),
                )
            })?;
        let snapshot = runtime
            .patch(ConfigDelta(patch), Some(baseline.generation))
            .await
            .map_err(config_runtime_error)?;
        let (effective, generation) = effective_config_snapshot(&realm_config, snapshot)
            .await
            .map_err(|error| {
                GatewayError::policy(
                    "Failed to compose the updated workspace configuration",
                    Some(json!({"error": error})),
                )
            })?;
        Ok(json!({
            "projectPath": locator.project_path,
            "stateRoot": locator.state_root,
            "configStateRoot": locator.state_root,
            "contextRoot": locator.context_root,
            "realmId": realm_config.realm_id.to_string(),
            "config": {
                "envelope": {
                    "generation": generation,
                    "realmId": realm_config.realm_id.to_string(),
                    "config": desktop_runtime_config_projection(&effective),
                }
            },
            "result": {
                "generation": generation,
                "status": "accepted",
                "runtime": "mobkit"
            }
        }))
    }

    async fn system_health(&self) -> Result<Value, GatewayError> {
        let runtimes = self.inner.project_runtimes.lock().await;
        let active_run_count = runtimes
            .values()
            .filter_map(|handle| handle.state.try_lock().ok())
            .map(|state| state.active_runs.len())
            .sum::<usize>();
        Ok(json!({
            "ok": true,
            "bootedAt": self.inner.booted_at,
            "runtime": "mobkit",
            "build": native_distribution::build_info(),
            "projectRuntimeCount": runtimes.len(),
            "activeRunCount": active_run_count,
            "shutdownHorizonMs": Self::shutdown_horizon().as_millis() as u64,
        }))
    }

    async fn system_capabilities(&self) -> Result<Value, GatewayError> {
        let proposal_tool_available = mobkit_registry::project_agent_proposal_dispatcher()
            .await
            .map(|dispatcher| dispatcher.is_some())
            .unwrap_or(false);
        Ok(json!({
            "contractVersion": "pure-mobkit-runtime-v1",
            "capabilities": {
                "executionModel": "mobkit_project_thread_domain_mobs",
                "threadBacking": "mob",
                "runtimeSubstrate": "mobkit",
                "projectAgentProposalTool": proposal_tool_available,
                "images": {"durable":true,"maxImageBytes":media::MAX_IMAGE_BYTES,"maxImagesPerMessage":media::MAX_IMAGES_PER_MESSAGE}
            },
            "methods": [
                "configs.v1.get",
                "desktop.hostTools.configure.v1",
                "sharedTools.v1.configure",
                "desktop.hostTools.complete.v1",
                "configs.v1.patch",
                "models.v1.catalog",
                "skills.v1.list",
                "auth.v1.status",
                "auth.v1.configure",
                "auth.v1.check",
                "auth.v1.deviceStart",
                "auth.v1.devicePoll",
                "auth.v1.delete",
                "auth.v1.default",
                "auth.v1.loginStart",
                "auth.v1.loginComplete",
                "auth.v1.logout",
                "system.v1.health",
                "text.v1.generate",
                "approvals.v1.list",
                "approvals.v1.decide",
                "system.v1.capabilities",
                "system.v1.projectRuntimeInfo",
                "mobs.v1.list",
                "mobs.v1.teamSnapshot",
                "mobs.v1.snapshot",
                "mobs.v1.members",
                "mobs.v1.events",
                "mobs.v1.runStatus",
                "mobs.v1.recoverThread",
                "mobs.v1.consoleTimeline",
                "mobs.v1.consoleHistory",
                "mobs.v1.usageSnapshot",
                "mobs.v1.consoleReceipt",
                "mobs.v1.consoleSearch",
                "mobs.v1.checkpointScope",
                "mobs.v1.threadFollowups",
                "mobs.v1.threadDeliveries",
                "mobs.v1.acknowledgeThreadDelivery",
                "mobs.v1.consoleResume",
                "mobs.v1.consoleStopCrew",
                "mobs.v1.browserConfigure",
                "mobs.v1.browserStatus",
                "mobs.v1.createThreadMob",
                "mobs.v1.createDomainMob",
                "mobs.v1.domainRevise",
                "mobs.v1.createSubMob",
                "mobs.v1.registerRemoteTcp",
                "mobs.v1.topologyPair",
                "mobs.v1.peerLocal",
                "mobs.v1.unpeerLocal",
                "mobs.v1.turnStart",
                "mobs.v1.memberSend",
                "mobs.v1.imageUpload",
                "mobs.v1.imageRead",
                "mobs.v1.consoleSend",
                "mobs.v1.consoleStop",
                "mobs.v1.consoleStatus",
                "mobs.v1.coordinatorWork",
                "mobs.v1.coordinatorStop",
                "mobs.v1.coordinatorSteer",
                "mobs.v1.coordinatorSteerReceipt",
                "mobs.v1.peerMessage",
                "mobs.v1.memberAsk",
                "mobs.v1.forceCancel",
                "mobs.v1.destroy",
                "mobkit/send_message",
                "mobkit/list_members",
                "mobkit/query_events",
                "mobkit/mob_events/query",
                "mobkit/console/query_timeline",
                "mobkit/cross_mob/directory",
                "mobkit/cross_mob/wire",
                "mobkit/cross_mob/unwire",
                "mobkit/cross_mob/send",
                "mobkit/cross_mob/peer_info",
                "mobkit/cross_mob/wire_local",
                "mobkit/cross_mob/unwire_local",
                "mobkit/peer_pubkey"
            ],
        }))
    }

    async fn system_project_runtime_info(
        &self,
        params: Option<&Value>,
    ) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let project_path = required_string(params, "projectPath")?;
        let execution_path =
            optional_string(params, "executionPath").unwrap_or_else(|| project_path.clone());
        let execution_mode =
            optional_string(params, "executionMode").unwrap_or_else(|| "local".to_string());
        let state_root_override = optional_string(params, "stateRoot");
        let handle = self
            .project_runtime_handle_for_paths(
                &project_path,
                &execution_path,
                execution_mode,
                state_root_override.as_deref(),
            )
            .await?;
        let state = handle.state.lock().await;
        Ok(json!({
            "host": {
                "hostId": project_runtime_key(&state.locator, &state.execution_path),
                "placement": "local",
                "status": "ready",
                "runtime": "mobkit",
                "projectPath": state.locator.project_path.to_string_lossy().to_string(),
                "stateRoot": state.locator.state_root.to_string_lossy().to_string(),
                "contextRoot": state.execution_path.to_string_lossy().to_string(),
                "executionPath": state.execution_path.to_string_lossy().to_string(),
                "executionMode": state.execution_mode.clone(),
                "realmId": state.locator.realm_id.clone(),
                "instanceId": state.instance_id.clone(),
                "dirty": state.dirty,
                "activeRunCount": state.active_runs.len(),
                "activeRuns": state.active_runs.iter().map(|(thread_id, active)| json!({
                    "threadId": thread_id,
                    "runId": active.run_id,
                    "mobId": active.mob_id,
                    "agentIdentity": active.agent_identity,
                    "startedAt": active.started_at,
                })).collect::<Vec<_>>(),
                "contractVersion": "pure-mobkit-runtime-v1",
                "serverName": "meerkat-app-mobkit",
                "serverVersion": env!("CARGO_PKG_VERSION"),
                "methods": [
                    "mobkit/send_message",
                    "mobkit/list_members",
                    "mobkit/query_events",
                    "mobkit/mob_events/query",
                    "mobkit/console/query_timeline",
                    "mobkit/cross_mob/directory",
                    "mobkit/cross_mob/wire",
                    "mobkit/cross_mob/unwire",
                    "mobkit/cross_mob/send",
                    "mobkit/cross_mob/peer_info",
                    "mobkit/cross_mob/wire_local",
                    "mobkit/cross_mob/unwire_local",
                    "mobkit/peer_pubkey"
                ],
                "capabilities": {
                    "mobkit": true
                }
            }
        }))
    }

    async fn debug_clear_project_runtimes(&self) -> Result<Value, GatewayError> {
        self.inner.project_runtimes.lock().await.clear();
        Ok(json!({"cleared": true}))
    }

    async fn mobs_list(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let handle = self
            .project_runtime_handle_for_mob_params(object_params(params)?)
            .await?;
        let state = handle.state.lock().await;
        let mobs = state.mobkit.list().await;
        let mut projected = Vec::new();
        for mob in mobs {
            projected.push(mob.snapshot().await);
        }
        Ok(json!({ "mobs": projected }))
    }

    async fn mobs_snapshot(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let mob_id = required_mob_id(params)?;
        let mob = self.mob_for_params(params, &mob_id).await?;
        Ok(mob.snapshot().await)
    }

    async fn mobs_team_snapshot(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let project_path = normalize_project_path(&required_string(params, "projectPath")?)?;
        let state_root = match optional_string(params, "stateRoot") {
            Some(path) => normalize_state_root_path(&path)?,
            None => normalize_state_root_path(&project_path.join(".rkat").to_string_lossy())?,
        };
        // Observation must not create a state directory, project handle, or
        // native runtime. Match an already loaded scope and release its lock
        // before querying the console's native read model.
        let handles = self
            .inner
            .project_runtimes
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut registry = None;
        for handle in handles {
            let state = handle.state.lock().await;
            if state.locator.project_path == project_path && state.locator.state_root == state_root
            {
                registry = Some(Arc::clone(&state.mobkit));
                break;
            }
        }
        let Some(registry) = registry else {
            return Ok(json!({"observation": "loaded_runtimes", "loaded": false, "mobs": []}));
        };
        let mut mobs = Vec::new();
        for mob in registry.list().await {
            mobs.push(mob.team_snapshot().await);
        }
        Ok(json!({"observation": "loaded_runtimes", "loaded": true, "mobs": mobs}))
    }

    async fn mobs_members(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let mob_id = required_mob_id(params)?;
        let mob = self.mob_for_params(params, &mob_id).await?;
        let members = match mob.runtime.as_ref() {
            Some(runtime) => mobkit_registry::list_members(runtime).await,
            None => Vec::new(),
        };
        Ok(json!({ "mobId": mob_id, "members": members }))
    }

    async fn mobs_events(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let mob_id = required_mob_id(params)?;
        let after_cursor = params
            .get("after_cursor")
            .or_else(|| params.get("afterCursor"))
            .and_then(Value::as_u64);
        let since_ms = params
            .get("since_ms")
            .or_else(|| params.get("sinceMs"))
            .and_then(Value::as_u64);
        let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(100);
        let mob = self.mob_for_params(params, &mob_id).await?;
        let Some(runtime) = mob.runtime.as_ref() else {
            return Ok(
                json!({ "mobId": mob_id, "events": [], "nextCursor": after_cursor.unwrap_or(0) }),
            );
        };
        let result = mobkit_rpc(
            runtime,
            "mobkit/query_events",
            json!({
                "identity": mob.coordinator_identity,
                "after_seq": after_cursor,
                "since_ms": since_ms,
                "limit": limit,
            }),
        )
        .await
        .map_err(|error| {
            GatewayError::policy(
                "Failed to query MobKit events",
                Some(json!({"error": error})),
            )
        })?;
        Ok(json!({ "mobId": mob_id, "events": result }))
    }

    async fn mobs_thread_deliveries(&self, params: Option<&Value>, acknowledge: bool) -> Result<Value, GatewayError> {
        let values = object_params(params)?;
        let project = normalize_project_path(&required_nonempty_string(values, "projectPath")?)?;
        let state = optional_string(values, "stateRoot").map(|path| normalize_state_root_path(&path)).transpose()?.unwrap_or_else(|| project.join(".rkat"));
        let thread = required_nonempty_string(values, "threadId")?;
        let mob = required_nonempty_string(values, "mobId")?;
        let event = if acknowledge { Some(required_nonempty_string(values, "eventId")?) } else { None };
        if !acknowledge {
            let handles = self.inner.project_runtimes.lock().await.values().cloned().collect::<Vec<_>>();
            for handle in handles {
                let matches = {
                    let current = handle.state.lock().await;
                    current.locator.project_path == project && current.locator.state_root == state
                        && current.active_runs.get(&thread).is_some_and(|run| run.mob_id == mob)
                };
                if matches { retry_run_finalizations(&self.inner.events_tx, &handle).await; }
            }
        }
        tokio::task::spawn_blocking(move || {
            if let Some(event) = event {
                thread_deliveries::acknowledge(&state, &thread, &mob, &event)?;
                Ok(json!({"acknowledged":true}))
            } else {
                Ok(json!({"events":thread_deliveries::read(&state, &thread, &mob)?}))
            }
        }).await.map_err(|error| GatewayError::policy("Conversation delivery is unavailable",Some(json!({"error":error.to_string()}))))?
    }

    async fn mobs_thread_followups(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let values=object_params(params)?;
        let project=normalize_project_path(&required_nonempty_string(values,"projectPath")?)?;
        let state_root=optional_string(values,"stateRoot").map(|path|normalize_state_root_path(&path)).transpose()?.unwrap_or_else(||project.join(".rkat"));
        let thread=required_nonempty_string(values,"threadId")?;
        let mob=required_nonempty_string(values,"mobId")?;
        let handles=self.inner.project_runtimes.lock().await.values().cloned().collect::<Vec<_>>();
        let mut active=std::collections::BTreeSet::new();
        for handle in handles {
            let state=handle.state.lock().await;
            if state.locator.project_path==project && state.locator.state_root==state_root {
                if let Some(run)=state.active_runs.get(&thread).filter(|run|run.mob_id==mob && run.deliveries.finalization_error.is_none()) {
                    active.insert(run.run_id.clone());
                }
            }
        }
        thread_followups::read(params,active).await
    }

    async fn mobs_console_timeline(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let mob_id = required_mob_id(params)?;
        let identity = optional_string(params, "identity")
            .or_else(|| optional_string(params, "agent_identity"))
            .or_else(|| optional_string(params, "agentIdentity"))
            .unwrap_or_else(|| "ingress".to_string());
        let after = params
            .get("after")
            .or_else(|| params.get("afterCursor"))
            .or_else(|| params.get("after_cursor"))
            .and_then(|value| {
                if value.is_null() {
                    None
                } else if let Some(text) = value.as_str() {
                    let trimmed = text.trim();
                    (!trimmed.is_empty()).then(|| Value::String(trimmed.to_string()))
                } else if let Some(seq) = value.as_u64() {
                    Some(Value::String(format!("console:{seq}")))
                } else {
                    Some(value.clone())
                }
            });
        let before = match params.get("before") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) if !value.trim().is_empty() => {
                Some(meerkat_mobkit::ConsoleCursor::from(value.clone()))
            }
            Some(_) => {
                return Err(GatewayError::invalid(
                    "before must be a nonempty cursor string",
                    None,
                ))
            }
        };
        let mode = optional_string(params, "mode").unwrap_or_else(|| {
            if after.is_some() {
                "since".to_string()
            } else {
                "recent".to_string()
            }
        });
        let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(100);
        let mob = self.mob_for_params(params, &mob_id).await?;
        if params.get("expected").is_some() {
            let expected=console_expected_target(params)?;
            if expected.identity != identity { return Err(GatewayError::invalid("Timeline identity differs from expected target",None)); }
            mob.validate_console_incarnation(&expected).await.map_err(|error|GatewayError::conflict("Console agent incarnation changed",Some(json!({"error":error}))))?;
        }
        // The stdio JSON-RPC dispatcher never served console methods; the
        // registered aggregator on the mob record is the real surface.
        let Some(console) = mob.console.as_ref() else {
            return Err(GatewayError::policy(
                "MobKit console is unavailable for this mob",
                Some(json!({"mobId": mob_id})),
            ));
        };
        let query = meerkat_mobkit::ConsoleTimelineWindowQuery {
            identity: Some(identity.clone()),
            conversation_id: None,
            after: after
                .as_ref()
                .and_then(Value::as_str)
                .map(|cursor| meerkat_mobkit::ConsoleCursor::from(cursor.to_string())),
            before,
            mode: if mode == "since" {
                meerkat_mobkit::ConsoleTimelineMode::Since
            } else {
                meerkat_mobkit::ConsoleTimelineMode::Recent
            },
            limit: usize::try_from(limit).unwrap_or(100),
        };
        let page = console
            .query_timeline_windowed(query)
            .await
            .map_err(|error| {
                GatewayError::policy(
                    "Failed to query MobKit console timeline",
                    Some(json!({"error": error.to_string()})),
                )
            })?;
        let result = serde_json::to_value(&page).map_err(|error| {
            GatewayError::policy(
                "Failed to serialize MobKit console timeline",
                Some(json!({"error": error.to_string()})),
            )
        })?;
        Ok(json!({ "mobId": mob_id, "identity": identity, "timeline": result }))
    }

    async fn mobs_console_send(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let expected = console_expected_target(params)?;
        let mob_id = required_nonempty_string(params, "mobId")?;
        let content = media::parse_content(params, "content")?;
        let skill_references = native_skills::references(params)?;
        let idempotency_key = required_nonempty_string(params, "idempotencyKey")?;
        let handling_mode = required_nonempty_string(params, "handlingMode")?;
        if !matches!(handling_mode.as_str(), "queue" | "steer") {
            return Err(GatewayError::invalid(
                "handlingMode must be queue or steer",
                None,
            ));
        }
        native_skills::validate_handling(&skill_references, handling_mode == "steer")?;
        let mob = self.mob_for_params(params, &mob_id).await?;
        let project_handle = self.project_runtime_handle_for_mob_params(params).await?;
        let admission_lock = {
            let mut state = project_handle.state.lock().await;
            Arc::clone(state.member_turn_locks.entry(format!("console-send:{}:{}:{}", mob_id, expected.runtime_key, expected.identity))
                .or_insert_with(|| Arc::new(Mutex::new(()))))
        };
        // Serialize only request admission so queue/steer cannot reuse one key
        // through different native ingress routes. Work itself stays concurrent.
        let _admission_guard = admission_lock.lock().await;
        mob.validate_console_target(&expected)
            .await
            .map_err(|error| {
                GatewayError::conflict(
                    "Console agent target is not current",
                    Some(json!({"error": error})),
                )
            })?;
        let image_store = mob.console.as_ref().ok_or_else(||GatewayError::policy("Native console unavailable",None))?.binary_blob_store_for_identity(&expected.identity).await.map_err(|error|GatewayError::policy("Native image storage unavailable",Some(json!({"error":error.to_string()}))))?;
        media::validate_content(image_store, &content).await?;
        let console = mob
            .console
            .as_ref()
            .ok_or_else(|| GatewayError::policy("MobKit console is unavailable", None))?;
        if handling_mode == "steer" && has_turn_llm_identity_override(params) {
            return Err(GatewayError::invalid("Steering cannot change the agent model", None));
        }
        let steering_key = native_steering::native_key(&mob_id, &expected, &idempotency_key)?;
        if handling_mode == "queue" {
            use meerkat_runtime::SessionServiceRuntimeExt;
            if let (Some(machine), Some(session)) = (&mob.session_runtime, &expected.session_id) {
                let session = meerkat_core::SessionId::parse(session).map_err(|error| GatewayError::invalid(error.to_string(), None))?;
                if machine.input_state_by_idempotency_key(&session, &steering_key).await
                    .map_err(|error| GatewayError::policy(error.to_string(), None))?.is_some() {
                    return Err(GatewayError::conflict("This request was already admitted as steering", None));
                }
            }
        } else {
            // Preserve legacy receipts on retries. A previously queued or
            // failed console dispatch must never become a second native input.
            let legacy_key = format!("send:{}:{}:meerkat-app:{}", expected.runtime_key, expected.identity, idempotency_key);
            let legacy = console.store().frame_by_dedupe_key(&legacy_key).await
                .map_err(|error| GatewayError::policy(error.to_string(), None))?;
            if legacy.is_none() {
                use meerkat_runtime::SessionServiceRuntimeExt;
                let machine = mob.session_runtime.as_ref().ok_or_else(|| GatewayError::policy("Native runtime is unavailable", None))?;
                let session = meerkat_core::SessionId::parse(expected.session_id.as_deref().ok_or_else(|| GatewayError::conflict("Native session is unavailable", None))?)
                    .map_err(|error| GatewayError::invalid(error.to_string(), None))?;
                let replay = machine.input_state_by_idempotency_key(&session, &steering_key).await
                    .map_err(|error| GatewayError::policy(error.to_string(), None))?.is_some();
                if !replay && !mob.console_target_busy(&expected).await.map_err(|error| GatewayError::conflict(error, None))? {
                    return Err(GatewayError::conflict("The agent's work ended; send this as a new message", None));
                }
                let admission = native_steering::admit(&mob, &expected, content, steering_key.clone()).await?;
                let receipt = native_steering::receipt(&expected, &admission, &idempotency_key, &steering_key);
                return Ok(json!({"mobId":mob_id,"identity":expected.identity,"receipt":receipt}));
            }
        }
        if has_turn_llm_identity_override(params) || !skill_references.is_empty() {
            // Read the canonical admission record before applying current
            // configuration. A retry preserves the original native receipt.
            // Console send still owns fingerprint validation and replay.
            let key = format!("send:{}:{}:meerkat-app:{}", expected.runtime_key, expected.identity, idempotency_key);
            let admitted = console.store().frame_by_dedupe_key(&key).await
                .map_err(|error| GatewayError::policy("Could not verify native message admission", Some(json!({"error":error.to_string()}))))?;
            if admitted.is_none() {
                if !skill_references.is_empty() {
                    let realm = load_effective_realm_config(&mob.checkpoint_project_path, &mob.config_state_root)
                        .await.map_err(|error| GatewayError::policy("Could not load workspace skills configuration", Some(json!({"error":error}))))?;
                    if realm.realm_id.as_str() != mob.realm_id {
                        return Err(GatewayError::conflict("Skill workspace realm does not match the agent runtime", None));
                    }
                    native_skills::validate_enabled(&realm.effective, &skill_references)?;
                }
                if has_turn_llm_identity_override(params) {
                    let catalog = self.inner.provider_auth.selection_catalog(
                        &mob.checkpoint_project_path, &mob.config_state_root,
                    ).await?;
                    native_model::apply_with_catalog(&mob, &expected, params, Some(&catalog)).await?;
                }
            }
        }
        let receipt = console
            .send(meerkat_mobkit::ConsoleSendRequest {
                identity: expected.identity.clone(),
                content: serde_json::to_value(content).expect("native content serializes"),
                origin: "meerkat-app".to_string(),
                // Preserve the legacy admission fingerprint across upgrades.
                origin_kind: None,
                idempotency_key,
                handling_mode: Some(handling_mode),
                skill_refs: native_skills::console_references(skill_references),
            })
            .await
            .map_err(|error| {
                GatewayError::policy(
                    "MobKit console send failed",
                    Some(json!({"error": error.to_string()})),
                )
            })?;
        Ok(json!({"mobId": mob_id, "identity": expected.identity, "receipt": receipt}))
    }

    async fn mobs_console_stop(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let expected = console_expected_target(params)?;
        let mob_id = required_nonempty_string(params, "mobId")?;
        let native_run_id = required_nonempty_string(params, "nativeRunId")?;
        let expected_run = serde_json::from_value(json!(native_run_id)).map_err(|error| {
            GatewayError::invalid("nativeRunId must identify the observed native run", Some(json!({"error":error.to_string()})))
        })?;
        let mob = self.mob_for_params(params, &mob_id).await?;
        let receipt = mob.stop_console_target(&expected, expected_run).await.map_err(|error| {
            GatewayError::conflict("MobKit console stop failed", Some(json!({"error": error})))
        })?;
        let accepted = matches!(&receipt, meerkat_contracts::WireRunStopReceipt::Stopped { .. });
        Ok(json!({"mobId": mob_id, "identity": expected.identity, "nativeRunId":native_run_id,"accepted":accepted,"receipt":receipt}))
    }

    async fn mobs_console_status(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let expected = console_expected_target(params)?;
        let mob_id = required_nonempty_string(params, "mobId")?;
        let mob = self.mob_for_params(params, &mob_id).await?;
        let busy = mob.console_target_busy(&expected).await.map_err(|error| {
            GatewayError::conflict(
                "MobKit console status is unavailable",
                Some(json!({"error":error})),
            )
        })?;
        let mut status = native_work::read(&mob, &expected, busy, Some(&self.inner.provider_auth)).await?;
        mob.validate_console_incarnation(&expected).await.map_err(|error| GatewayError::conflict(error, None))?;
        status.extend(serde_json::from_value::<serde_json::Map<String, Value>>(json!({"mobId":mob_id,"identity":expected.identity,"sessionId":expected.session_id,"busy":busy})).expect("status fields"));
        Ok(Value::Object(status))
    }

    async fn mobs_member_send(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let mob_id = required_mob_id(params)?;
        let agent_identity = optional_string(params, "agent_identity")
            .or_else(|| optional_string(params, "agentIdentity"))
            .unwrap_or_else(|| "ingress".to_string());
        let content = optional_string(params, "content")
            .or_else(|| optional_string(params, "message"))
            .ok_or_else(|| GatewayError::invalid("Missing content", None))?;
        let mob = self.mob_for_params(params, &mob_id).await?;
        let Some(runtime) = mob.runtime.as_ref() else {
            return Err(GatewayError::policy(
                "Cannot send to a remote mob without a MobKit TCP client binding yet",
                Some(json!({"mobId": mob_id})),
            ));
        };
        let handling_mode = parse_handling_mode(params)?;
        wait_for_member_kickoff_quiescence(runtime, &agent_identity, Duration::from_secs(45))
            .await
            .map_err(|error| {
                GatewayError::policy(
                    "MobKit member is not ready for a user message",
                    Some(json!({"error": error})),
                )
            })?;
        let runtime_receipt = send_to_member(runtime, &agent_identity, &content, handling_mode)
            .await
            .map_err(|error| {
                GatewayError::policy("MobKit send failed", Some(json!({"error": error})))
            })?;
        Ok(json!({
            "accepted": true,
            "mobId": mob_id,
            "agentIdentity": agent_identity,
            "sessionId": runtime_receipt,
        }))
    }

    async fn mobs_peer_message(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let mob_id = required_mob_id(params)?;
        let source_agent_identity = optional_string(params, "source_agent_identity")
            .or_else(|| optional_string(params, "sourceAgentIdentity"))
            .or_else(|| optional_string(params, "agent_identity"))
            .or_else(|| optional_string(params, "agentIdentity"))
            .unwrap_or_else(|| "ingress".to_string());
        let target_peer_id = optional_string(params, "target_peer_id")
            .or_else(|| optional_string(params, "targetPeerId"))
            .or_else(|| optional_string(params, "peer_id"))
            .or_else(|| optional_string(params, "peerId"))
            .ok_or_else(|| GatewayError::invalid("Missing target peer id", None))?;
        let target_display_name = optional_string(params, "target_display_name")
            .or_else(|| optional_string(params, "targetDisplayName"))
            .or_else(|| optional_string(params, "display_name"))
            .or_else(|| optional_string(params, "displayName"));
        let content = optional_string(params, "content")
            .or_else(|| optional_string(params, "message"))
            .or_else(|| optional_string(params, "body"))
            .ok_or_else(|| GatewayError::invalid("Missing content", None))?;
        let mob = self.mob_for_params(params, &mob_id).await?;
        let Some(runtime) = mob.runtime.as_ref() else {
            return Err(GatewayError::policy(
                "Cannot send a peer message from a remote mob without a local MobKit runtime",
                Some(json!({"mobId": mob_id})),
            ));
        };
        let handling_mode = parse_handling_mode(params)?;
        let receipt = send_peer_message(
            runtime,
            &source_agent_identity,
            &target_peer_id,
            target_display_name.as_deref(),
            &content,
            handling_mode,
        )
        .await
        .map_err(|error| {
            GatewayError::policy("MobKit peer message failed", Some(json!({"error": error})))
        })?;
        Ok(json!({
            "accepted": true,
            "mobId": mob_id,
            "sourceAgentIdentity": source_agent_identity,
            "targetPeerId": target_peer_id,
            "receipt": receipt,
        }))
    }

    async fn mobs_member_ask(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let mob_id = required_mob_id(params)?;
        let agent_identity = optional_string(params, "agent_identity")
            .or_else(|| optional_string(params, "agentIdentity"))
            .unwrap_or_else(|| "ingress".to_string());
        let prompt = optional_string(params, "input")
            .or_else(|| optional_string(params, "content"))
            .or_else(|| optional_string(params, "message"))
            .ok_or_else(|| GatewayError::invalid("Missing input", None))?;
        let timeout_ms = params
            .get("timeoutMs")
            .or_else(|| params.get("timeout_ms"))
            .and_then(Value::as_u64)
            .unwrap_or(180_000);
        let mob = self.mob_for_params(params, &mob_id).await?;
        let Some(runtime) = mob.runtime.as_ref() else {
            return Err(GatewayError::policy(
                "Cannot ask a remote mob without a local MobKit runtime",
                Some(json!({"mobId": mob_id})),
            ));
        };
        let result = ask_member_for_response(
            runtime.clone(),
            agent_identity.clone(),
            prompt.clone(),
            Duration::from_millis(timeout_ms),
        )
        .await
        .map_err(|error| {
            GatewayError::policy("MobKit member ask failed", Some(json!({"error": error})))
        })?;
        Ok(json!({
            "accepted": true,
            "mobId": mob_id,
            "agentIdentity": agent_identity,
            "sessionId": result.session_id,
            "answerText": result.answer_text,
            "messages": result.messages,
        }))
    }

    async fn mobs_force_cancel(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let thread_id = optional_string(params, "threadId");
        let run_id = optional_string(params, "runId");
        let mob_id = required_mob_id(params)?;
        let agent_identity = optional_string(params, "agent_identity")
            .or_else(|| optional_string(params, "agentIdentity"))
            .unwrap_or_else(|| "ingress".to_string());
        let handle = self.project_runtime_handle_for_mob_params(params).await?;
        let project_path = optional_string(params, "projectPath").unwrap_or_default();
        let execution_path =
            optional_string(params, "executionPath").unwrap_or_else(|| project_path.clone());
        let execution_mode =
            optional_string(params, "executionMode").unwrap_or_else(|| "local".to_string());
        // Seal new steering admission while native cancellation is pending.
        // Each concurrent cancellation owns a reservation, so one rejected
        // request cannot reopen ingress while another request is in flight.
        let mut state = handle.state.lock().await;
        let active_run = if let Some(thread_id) = thread_id.as_deref() {
            state.active_runs.get(thread_id)
        } else if let Some(run_id) = run_id.as_deref() {
            state
                .active_runs
                .values()
                .find(|active| active.run_id == run_id)
        } else {
            None
        }
        .cloned();
        if let Some(active) = active_run.as_ref() {
            if active.deliveries.finalizing {
                return Err(GatewayError::conflict("Execution has ended and its final result is still being saved. Refresh its status before continuing.", Some(json!({"runId":active.run_id}))));
            }
            if run_id
                .as_deref()
                .is_some_and(|requested| requested != active.run_id)
                || active.mob_id != mob_id
                || active.agent_identity != agent_identity
            {
                return Err(GatewayError::conflict(
                    "Cancellation target does not match the active run",
                    Some(json!({
                        "threadId": thread_id,
                        "runId": run_id,
                        "activeRunId": active.run_id,
                        "activeMobId": active.mob_id,
                        "activeAgentIdentity": active.agent_identity,
                    })),
                ));
            }
        } else if thread_id.is_some() || run_id.is_some() {
            return Err(GatewayError::not_found(
                "Requested run is not active",
                Some(json!({"threadId": thread_id, "runId": run_id})),
            ));
        }
        let mob = state.mobkit.get(&mob_id).await.ok_or_else(|| {
            GatewayError::not_found("Unknown mob", Some(json!({"mobId": mob_id})))
        })?;
        let runtime = mob.runtime.as_ref().ok_or_else(|| {
            GatewayError::policy(
                "Cannot cancel a remote mob without a runtime client binding",
                Some(json!({"mobId": mob_id})),
            )
        })?;
        let runtime = Arc::clone(runtime);
        let active_thread_id = active_run.as_ref().and_then(|active| {
            state
                .active_runs
                .iter()
                .find(|(_, current)| current.run_id == active.run_id)
                .map(|(thread_id, _)| thread_id.clone())
        });
        if let Some(active) = active_run.as_ref() {
            if let Some(current) = state
                .active_runs
                .values_mut()
                .find(|current| current.run_id == active.run_id)
            {
                current.deliveries.cancellation_requests_pending += 1;
                // Keep this run reserved until cancellation admission
                // returns, so it cannot accidentally target a successor.
                current.deliveries.pending += 1;
            }
        }
        // Do not hold application state across a native boundary wait. An
        // already-reserved delivery may need the same state to settle.
        drop(state);
        let cancelled = if let Some(active) = active_run.as_ref() {
            let (session, native_run) = observed_native_run(&active.projection).await;
            async {
                let session = session.ok_or_else(|| GatewayError::conflict(
                    "The application run has no observed native session yet; refresh before stopping",
                    Some(json!({"kind":"native_run_unobserved","runId":active.run_id})),
                ))?;
                let native_run = native_run.ok_or_else(|| GatewayError::conflict(
                    "The application run has no observed native run yet; refresh before stopping",
                    Some(json!({"kind":"native_run_unobserved","runId":active.run_id})),
                ))?;
                let member = meerkat_mobkit::member_comms_id::mob_member_id(&agent_identity);
                if runtime.mob_handle().resolve_bridge_session_id_observation(&member).await
                    .map(|current| current.to_string()).as_deref() != Some(session.as_str()) {
                    return Err(GatewayError::conflict(
                        "The application run's native member session changed; refresh before stopping",
                        Some(json!({"kind":"native_session_changed","runId":active.run_id,"sessionId":session})),
                    ));
                }
                // This run id comes from this application's owned event stream.
                // Never replace it with whatever run the member has now.
                let receipt = runtime.mob_handle().stop_member_run(
                    meerkat_mob::MobControlPrincipal::Owner,
                    member,
                    native_run,
                    "Stopped from thread conversation",
                ).await.map_err(|error| GatewayError::policy(
                    "MobKit did not accept cancellation",
                    Some(json!({"kind":"native_run_stop_failed","mobId":mob_id,"error":error.to_string()})),
                ))?;
                match receipt {
                    meerkat_contracts::WireRunStopReceipt::Stopped { .. } => Ok(()),
                    receipt @ meerkat_contracts::WireRunStopReceipt::NotCurrent { .. } => Err(GatewayError::conflict(
                        "The selected native run has ended; no newer work was stopped",
                        Some(json!({"kind":"native_run_not_current","runId":active.run_id,"receipt":receipt})),
                    )),
                    receipt @ meerkat_contracts::WireRunStopReceipt::NotStoppable { .. } => Err(GatewayError::conflict(
                        "Native runtime cleanup owns the selected run; no stop was admitted",
                        Some(json!({"kind":"native_run_not_stoppable","runId":active.run_id,"receipt":receipt})),
                    )),
                }
            }.await
        } else {
            // Retain the legacy maintenance verb outside application runs.
            runtime.mob_handle().force_cancel_member(AgentIdentity::from(agent_identity.as_str()))
                .await.map_err(|error| GatewayError::policy(
                    "MobKit did not accept cancellation",
                    Some(json!({"mobId":mob_id,"error":error.to_string()})),
                ))
        };
        if let Some(active) = active_run.as_ref() {
            let mut state = handle.state.lock().await;
            if let Some(current) = state
                .active_runs
                .values_mut()
                .find(|current| current.run_id == active.run_id)
            {
                current.deliveries.cancellation_requests_pending -= 1;
                current.deliveries.cancellation_requested |= cancelled.is_ok();
            }
        }
        // Native run Stop owns contributor terminalization. Application
        // delivery projections still settle through their own committed receipts.
        if let Some(active) = active_run.as_ref().filter(|_| cancelled.is_ok()) {
            self.inner.host_tools.cancel_run(&active.run_id).await;
        }
        if let Some((active, active_thread_id)) =
            active_run.as_ref().zip(active_thread_id.as_deref())
        {
            finish_run(
                &self.inner.events_tx,
                &handle,
                active_thread_id,
                &active.run_id,
                &mob_id,
                &agent_identity,
                &project_path,
                &execution_path,
                &execution_mode,
                self.inner.host_tools.as_ref(),
                Ok(()),
            )
            .await;
        }
        if let Err(error) = cancelled {
            return Err(error);
        }
        Ok(json!({
            "status": "cancelling",
            "mobId": mob_id,
            "agentIdentity": agent_identity,
            "cancelled": false,
            "runtimeCancelled": false,
            "cancellationRequested": true,
            "runtimeRestarted": false,
            "projectPath": project_path,
            "executionPath": execution_path,
            "executionMode": execution_mode,
        }))
    }

    async fn mobs_destroy(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let mob_id = required_mob_id(params)?;
        let handle = self.project_runtime_handle_for_mob_params(params).await?;
        let (registry, state_root, run_ids) = {
            let state = handle.state.lock().await;
            (Arc::clone(&state.mobkit), state.locator.state_root.clone(),
             state.active_runs.values().filter(|run| run.mob_id == mob_id).map(|run| run.run_id.clone()).collect::<Vec<_>>())
        };
        for run_id in &run_ids {
            self.inner.host_tools.cancel_run(run_id).await;
        }
        let removed = registry.remove(&mob_id).await.map_err(|error| {
            GatewayError::policy("Native runtime cleanup did not complete", Some(json!({"mobId":mob_id,"error":error})))
        })?;
        retry_run_finalizations(&self.inner.events_tx, &handle).await;
        if handle.state.lock().await.active_runs.values().any(|run|
            run.mob_id == mob_id && run.deliveries.finalization_error.is_some()) {
            return Err(GatewayError::policy("Native cleanup completed but saving the final result failed. Refresh to retry delivery.", Some(json!({"mobId":mob_id,"cleanupCompleted":true,"deliveryStatus":"needs_recovery"}))));
        }
        // Native cleanup ends execution. Wait separately for application
        // projections to commit their terminal receipt before releasing it.
        tokio::time::timeout(Self::shutdown_horizon(), async {
            loop {
                let settled = handle.runs_settled.notified();
                tokio::pin!(settled);
                settled.as_mut().enable();
                if !handle.state.lock().await.active_runs.values().any(|run| run.mob_id == mob_id)
                    && run_ids.iter().all(|run_id| lookup_terminal_run(&state_root, run_id).is_some()) {
                    break;
                }
                settled.await;
            }
        }).await.map_err(|_| GatewayError::conflict("Native cleanup completed but run receipts are still settling", Some(json!({"mobId":mob_id}))))?;
        Ok(json!({ "mobId": mob_id, "destroyed": removed, "cleanupCompleted": true }))
    }

    async fn mobs_create_thread_mob(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let include_native_workers = include_native_workers_param(params)?;
        let thread_id = required_string(params, "threadId")?;
        let model = optional_string(params, "model").unwrap_or_else(|| "gpt-5.6-sol".to_string());
        let mob_id = optional_string(params, "mobId")
            .unwrap_or_else(|| format!("thread-{}", stable_slug(&thread_id)));
        let ingress_agent_identity = optional_string(params, "ingressAgentIdentity")
            .unwrap_or_else(|| "ingress".to_string());
        let title = optional_string(params, "title").unwrap_or_else(|| "Thread mob".to_string());
        // The thread title is UI metadata ONLY — never inject it into the
        // agent's instructions. Titles are lossy truncations of the first
        // prompt (observed live: a request for `ttt.html` truncated to
        // "...create ttt.h" and the agent built a C header). The user's actual
        // prompt is the sole task authority.
        let instructions = "You are Meerkat, the coordinator for this thread, running on Meerkat MobKit. \
Answer directly and begin requested work in the same turn. Handle simple questions and edits yourself. \
Use the native MobKit tools listed in your tool definitions for independent helper work or reusable teams: \
`delegate` starts a helper, `mob_check_member` checks its result, and `mob_create` with `mob_spawn_member` creates an explicit team. \
Follow the tools' schemas and use returned mob and member identities. Tell the user when you delegate and incorporate the actual results."
            .to_string();
        let mob = self
            .create_local_mob(
                params,
                CreateMobRequest {
                    mob_id: mob_id.clone(),
                    kind: "thread".to_string(),
                    label: title.clone(),
                    role: "ingress".to_string(),
                    coordinator_identity: ingress_agent_identity.clone(),
                    model,
                    instructions,
                    include_native_workers,
                },
            )
            .await?;
        let members = match mob.runtime.as_ref() {
            Some(runtime) => mobkit_registry::list_members(runtime).await,
            None => Vec::new(),
        };
        Ok(json!({
            "threadId": thread_id,
            "backingKind": "mob",
            "accessMode": mob.access_mode,
            "backingRef": {
                "kind": "mob",
                "mobId": mob.mob_id,
                "ingressAgentIdentity": ingress_agent_identity,
                "stateRoot": mob.state_root_string()
            },
            "mob": {
                "mobId": mob.mob_id,
                "kind": "thread",
                "label": title,
                "ingressAgentIdentity": ingress_agent_identity,
                "members": members
            }
        }))
    }

    async fn mobs_create_domain_mob(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let include_native_workers = include_native_workers_param(params)?;
        let model = optional_string(params, "model").unwrap_or_else(|| "gpt-5.6-sol".to_string());
        let label = optional_string(params, "label").unwrap_or_else(|| "Domain agent".to_string());
        let role = optional_string(params, "role").unwrap_or_else(|| "domain".to_string());
        let agent_identity =
            optional_string(params, "agentIdentity").unwrap_or_else(|| stable_slug(&role));
        let instructions = optional_string(params, "instructions").unwrap_or_else(|| {
            format!(
                "You are the {label} domain agent for this project. Stay focused on your domain, explain tradeoffs clearly, and make concrete changes when asked. \
When a decision genuinely needs the user's input, use the `ui_multiple_choice` tool to present the options as a native dialog instead of asking in prose."
            )
        });
        let suffix = Uuid::new_v4().simple().to_string();
        let mob_id = optional_string(params, "mobId").unwrap_or_else(|| {
            format!(
                "domain-{}-{}",
                stable_slug(&label),
                suffix.chars().take(8).collect::<String>()
            )
        });
        let mob = self
            .create_local_mob(
                params,
                CreateMobRequest {
                    mob_id: mob_id.clone(),
                    kind: "domain".to_string(),
                    label: label.clone(),
                    role: role.clone(),
                    coordinator_identity: agent_identity.clone(),
                    model,
                    instructions,
                    include_native_workers,
                },
            )
            .await?;
        let members = match mob.runtime.as_ref() {
            Some(runtime) => mobkit_registry::list_members(runtime).await,
            None => Vec::new(),
        };
        Ok(json!({
            "backingKind": "mob",
            "mob": {
                "mobId": mob.mob_id,
                "kind": "domain",
                "label": label,
                "role": role,
                "ingressAgentIdentity": agent_identity,
                "stateRoot": mob.state_root_string(),
                "members": members
            }
        }))
    }

    async fn mobs_create_sub_mob(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let parent_mob_id = required_string(params, "parentMobId")?;
        let model = optional_string(params, "model").unwrap_or_else(|| "gpt-5.6-sol".to_string());
        let label = optional_string(params, "label").unwrap_or_else(|| "Sub-mob".to_string());
        let role = optional_string(params, "role").unwrap_or_else(|| "worker".to_string());
        let agent_identity =
            optional_string(params, "agentIdentity").unwrap_or_else(|| stable_slug(&role));
        let mob_id = optional_string(params, "mobId")
            .unwrap_or_else(|| format!("sub-{}-{}", stable_slug(&label), Uuid::new_v4().simple()));
        let instructions = optional_string(params, "instructions").unwrap_or_else(|| {
            format!("You are {label}, a sub-mob working under parent mob {parent_mob_id}.")
        });
        let mob = self
            .create_local_mob(
                params,
                CreateMobRequest {
                    mob_id: mob_id.clone(),
                    kind: "submob".to_string(),
                    label: label.clone(),
                    role,
                    coordinator_identity: agent_identity.clone(),
                    model,
                    instructions,
                    include_native_workers: false,
                },
            )
            .await?;
        Ok(json!({
            "mob": {
                "mobId": mob.mob_id,
                "kind": "submob",
                "label": label,
                "parentMobId": parent_mob_id,
                "ingressAgentIdentity": agent_identity
            }
        }))
    }

    async fn mobs_register_remote_tcp(
        &self,
        params: Option<&Value>,
    ) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let mob_id = required_string(params, "mobId").or_else(|_| required_mob_id(params))?;
        let label = optional_string(params, "label").unwrap_or_else(|| mob_id.clone());
        let endpoint = required_string(params, "endpoint")?;
        let pubkey_b64 =
            optional_string(params, "pubkeyB64").or_else(|| optional_string(params, "pubkey_b64"));
        let handle = self.project_runtime_handle_for_mob_params(params).await?;
        {
            let state = handle.state.lock().await;
            state
                .mobkit
                .insert_remote_tcp(
                    mob_id.clone(),
                    label.clone(),
                    endpoint.clone(),
                    pubkey_b64.clone(),
                )
                .await.map_err(|error| GatewayError::conflict(error, None))?;
        }
        Ok(json!({
            "mob": {
                "mobId": mob_id,
                "kind": "remote",
                "label": label,
                "placement": {
                    "kind": "remote_tcp",
                    "endpoint": endpoint,
                    "pubkeyB64": pubkey_b64,
                    "status": "registered"
                }
            }
        }))
    }

    /// Return the principal-shaped MobKit snapshot for one authority pair.
    ///
    /// This is intentionally pair-scoped: every snapshot carries the exact two
    /// authority revisions that must be supplied back on mutation. The desktop
    /// renderer may add labels, but it must not infer topology or permissions
    /// from its persisted thread projection.
    async fn mobs_topology_pair(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let source_project_path = required_string(params, "sourceProjectPath")?;
        let target_project_path = required_string(params, "targetProjectPath")?;
        let source_execution_path = optional_string(params, "sourceExecutionPath")
            .unwrap_or_else(|| source_project_path.clone());
        let target_execution_path = optional_string(params, "targetExecutionPath")
            .unwrap_or_else(|| target_project_path.clone());
        let source_execution_mode =
            optional_string(params, "sourceExecutionMode").unwrap_or_else(|| "local".to_string());
        let target_execution_mode =
            optional_string(params, "targetExecutionMode").unwrap_or_else(|| "local".to_string());
        let source_state_root = optional_string(params, "sourceStateRoot");
        let target_state_root = optional_string(params, "targetStateRoot");
        let source_mob_id = required_string(params, "sourceMobId")?;
        let target_mob_id = required_string(params, "targetMobId")?;
        let source_agent_identity = optional_string(params, "sourceAgentIdentity")
            .unwrap_or_else(|| "project-agent".to_string());
        let target_agent_identity = optional_string(params, "targetAgentIdentity")
            .unwrap_or_else(|| "project-agent".to_string());

        let source_mob = self
            .mob_for_project(
                &source_project_path,
                &source_execution_path,
                source_execution_mode,
                source_state_root.as_deref(),
                &source_mob_id,
            )
            .await?;
        let target_mob = self
            .mob_for_project(
                &target_project_path,
                &target_execution_path,
                target_execution_mode,
                target_state_root.as_deref(),
                &target_mob_id,
            )
            .await?;
        let Some(source_runtime) = source_mob.runtime.as_ref() else {
            return Err(GatewayError::policy(
                "Source mob is not local",
                Some(json!({"mobId": source_mob_id})),
            ));
        };
        let Some(target_runtime) = target_mob.runtime.as_ref() else {
            return Err(GatewayError::policy(
                "Target mob is not local",
                Some(json!({"mobId": target_mob_id})),
            ));
        };
        let coordinator = self
            .topology_coordinator_for_pair(&source_mob, &target_mob)
            .await?;
        let snapshot = coordinator
            .query(source_runtime, target_runtime, Some(DESKTOP_TOPOLOGY_ACTOR))
            .await
            .map_err(topology_gateway_error)?;
        let snapshot = serde_json::to_value(snapshot).map_err(|error| {
            GatewayError::policy(
                "Failed to serialize MobKit topology",
                Some(json!({"error": error.to_string()})),
            )
        })?;

        Ok(json!({
            "principal": DESKTOP_TOPOLOGY_ACTOR,
            "source": {
                "projectPath": source_project_path,
                "mobId": source_mob_id,
                "agentIdentity": source_agent_identity,
            },
            "target": {
                "projectPath": target_project_path,
                "mobId": target_mob_id,
                "agentIdentity": target_agent_identity,
            },
            "snapshot": snapshot,
        }))
    }

    async fn mobs_peer_local(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let source_project_path = required_string(params, "sourceProjectPath")?;
        let target_project_path = required_string(params, "targetProjectPath")?;
        let source_execution_path = optional_string(params, "sourceExecutionPath")
            .unwrap_or_else(|| source_project_path.clone());
        let target_execution_path = optional_string(params, "targetExecutionPath")
            .unwrap_or_else(|| target_project_path.clone());
        let source_execution_mode =
            optional_string(params, "sourceExecutionMode").unwrap_or_else(|| "local".to_string());
        let target_execution_mode =
            optional_string(params, "targetExecutionMode").unwrap_or_else(|| "local".to_string());
        let source_state_root = optional_string(params, "sourceStateRoot");
        let target_state_root = optional_string(params, "targetStateRoot");
        let source_mob_id = required_string(params, "sourceMobId")?;
        let target_mob_id = required_string(params, "targetMobId")?;
        let source_agent_identity = optional_string(params, "sourceAgentIdentity")
            .unwrap_or_else(|| "project-agent".to_string());
        let target_agent_identity = optional_string(params, "targetAgentIdentity")
            .unwrap_or_else(|| "project-agent".to_string());
        let idempotency_key = optional_string(params, "idempotencyKey")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let expected_revisions = optional_authority_revisions(params)?;
        let action = match optional_string(params, "action").as_deref() {
            None | Some("connect") => TopologyAction::Connect,
            Some("reconnect") => TopologyAction::Reconnect,
            Some(value) => {
                return Err(GatewayError::invalid(
                    "Peer action must be 'connect' or 'reconnect'",
                    Some(json!({"action": value})),
                ));
            }
        };

        let source_mob = self
            .mob_for_project(
                &source_project_path,
                &source_execution_path,
                source_execution_mode,
                source_state_root.as_deref(),
                &source_mob_id,
            )
            .await?;
        let target_mob = self
            .mob_for_project(
                &target_project_path,
                &target_execution_path,
                target_execution_mode,
                target_state_root.as_deref(),
                &target_mob_id,
            )
            .await?;
        let Some(source_runtime) = source_mob.runtime.as_ref() else {
            return Err(GatewayError::policy(
                "Source mob is not local",
                Some(json!({"mobId": source_mob_id})),
            ));
        };
        let Some(target_runtime) = target_mob.runtime.as_ref() else {
            return Err(GatewayError::policy(
                "Target mob is not local",
                Some(json!({"mobId": target_mob_id})),
            ));
        };

        let coordinator = self
            .topology_coordinator_for_pair(&source_mob, &target_mob)
            .await?;
        let receipt = apply_bilateral_topology(
            &coordinator,
            source_runtime,
            &source_agent_identity,
            target_runtime,
            &target_agent_identity,
            action,
            "Meerkat desktop connection picker",
            idempotency_key,
            expected_revisions,
        )
        .await?;
        let peer = local_member_pair_metadata(
            source_runtime,
            &source_agent_identity,
            target_runtime,
            &target_agent_identity,
        )
        .await
        .map_err(|error| {
            GatewayError::policy(
                "Failed to project local MobKit peer metadata",
                Some(json!({"error": error})),
            )
        })?;

        Ok(json!({
            "status": "peered",
            "source": {
                "projectPath": source_project_path,
                "mobId": source_mob_id,
                "agentIdentity": source_agent_identity,
            },
            "target": {
                "projectPath": target_project_path,
                "mobId": target_mob_id,
                "agentIdentity": target_agent_identity,
            },
            "action": match action {
                TopologyAction::Connect => "connect",
                TopologyAction::Reconnect => "reconnect",
                TopologyAction::Disconnect => unreachable!("peer endpoint cannot disconnect"),
            },
            "receipt": receipt,
            "peer": peer,
        }))
    }

    async fn mobs_unpeer_local(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let source_project_path = required_string(params, "sourceProjectPath")?;
        let target_project_path = required_string(params, "targetProjectPath")?;
        let source_execution_path = optional_string(params, "sourceExecutionPath")
            .unwrap_or_else(|| source_project_path.clone());
        let target_execution_path = optional_string(params, "targetExecutionPath")
            .unwrap_or_else(|| target_project_path.clone());
        let source_execution_mode =
            optional_string(params, "sourceExecutionMode").unwrap_or_else(|| "local".to_string());
        let target_execution_mode =
            optional_string(params, "targetExecutionMode").unwrap_or_else(|| "local".to_string());
        let source_state_root = optional_string(params, "sourceStateRoot");
        let target_state_root = optional_string(params, "targetStateRoot");
        let source_mob_id = required_string(params, "sourceMobId")?;
        let target_mob_id = required_string(params, "targetMobId")?;
        let source_agent_identity = optional_string(params, "sourceAgentIdentity")
            .unwrap_or_else(|| "project-agent".to_string());
        let target_agent_identity = optional_string(params, "targetAgentIdentity")
            .unwrap_or_else(|| "project-agent".to_string());
        let idempotency_key = optional_string(params, "idempotencyKey")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let expected_revisions = optional_authority_revisions(params)?;

        let source_mob = self
            .mob_for_project(
                &source_project_path,
                &source_execution_path,
                source_execution_mode,
                source_state_root.as_deref(),
                &source_mob_id,
            )
            .await?;
        let target_mob = self
            .mob_for_project(
                &target_project_path,
                &target_execution_path,
                target_execution_mode,
                target_state_root.as_deref(),
                &target_mob_id,
            )
            .await?;
        let Some(source_runtime) = source_mob.runtime.as_ref() else {
            return Err(GatewayError::policy(
                "Source mob is not local",
                Some(json!({"mobId": source_mob_id})),
            ));
        };
        let Some(target_runtime) = target_mob.runtime.as_ref() else {
            return Err(GatewayError::policy(
                "Target mob is not local",
                Some(json!({"mobId": target_mob_id})),
            ));
        };

        let coordinator = self
            .topology_coordinator_for_pair(&source_mob, &target_mob)
            .await?;
        let receipt = apply_bilateral_topology(
            &coordinator,
            source_runtime,
            &source_agent_identity,
            target_runtime,
            &target_agent_identity,
            TopologyAction::Disconnect,
            "Meerkat desktop connection picker",
            idempotency_key,
            expected_revisions,
        )
        .await?;
        let mut unpeer = local_member_pair_metadata(
            source_runtime,
            &source_agent_identity,
            target_runtime,
            &target_agent_identity,
        )
        .await
        .map_err(|error| {
            GatewayError::policy(
                "Failed to project local MobKit peer metadata",
                Some(json!({"error": error})),
            )
        })?;
        unpeer["status"] = json!("unpeered");

        Ok(json!({
            "status": "unpeered",
            "source": {
                "projectPath": source_project_path,
                "mobId": source_mob_id,
                "agentIdentity": source_agent_identity,
            },
            "target": {
                "projectPath": target_project_path,
                "mobId": target_mob_id,
                "agentIdentity": target_agent_identity,
            },
            "receipt": receipt,
            "unpeer": unpeer,
        }))
    }

    async fn topology_coordinator_for_pair(
        &self,
        source: &MobkitMobRuntime,
        target: &MobkitMobRuntime,
    ) -> Result<Arc<SameProcessTopologyCoordinator>, GatewayError> {
        let path = topology_pair_journal_path(source, target);
        let mut coordinators = self.inner.topology_coordinators.lock().await;
        // Keep one coordinator per concurrently active pair without pinning a
        // file lock for every pair ever touched by a large roster.
        coordinators.retain(|_, coordinator| coordinator.strong_count() > 0);
        if let Some(coordinator) = coordinators.get(&path).and_then(Weak::upgrade) {
            return Ok(coordinator);
        }
        let coordinator = Arc::new(SameProcessTopologyCoordinator::open(&path).map_err(
            |error| {
                GatewayError::policy(
                    "Failed to open MobKit topology coordinator",
                    Some(json!({"error": error.to_string(), "path": path})),
                )
            },
        )?);
        coordinators.insert(path, Arc::downgrade(&coordinator));
        Ok(coordinator)
    }

    async fn mobkit_runtime_rpc(
        &self,
        method: &str,
        params: Option<&Value>,
    ) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let mob_id = required_mob_id(params)?;
        let mob = self.mob_for_params(params, &mob_id).await?;
        let Some(runtime) = mob.runtime.as_ref() else {
            return Err(GatewayError::policy(
                "MobKit RPC requires a local mob runtime",
                Some(json!({"mobId": mob_id, "method": method})),
            ));
        };
        mobkit_rpc(runtime, method, Value::Object(params.clone()))
            .await
            .map_err(|error| {
                GatewayError::policy(
                    "MobKit RPC failed",
                    Some(json!({"method": method, "mobId": mob_id, "error": error})),
                )
            })
    }

    async fn mobs_turn_start(&self, params: Option<&Value>) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let thread_id = required_string(params, "threadId")?;
        let project_path = required_string(params, "projectPath")?;
        let execution_path =
            optional_string(params, "executionPath").unwrap_or_else(|| project_path.clone());
        let execution_mode =
            optional_string(params, "executionMode").unwrap_or_else(|| "local".to_string());
        let mob_id = required_string(params, "mobId")?;
        let agent_identity =
            optional_string(params, "agentIdentity").unwrap_or_else(|| "ingress".to_string());
        let prompt = media::parse_content(params, "input")?;
        let skill_references = native_skills::references(params)?;
        let restored_transcript = restored_transcript_from_params(params);
        let handling_mode = parse_handling_mode(params)?;
        native_skills::validate_handling(&skill_references, matches!(handling_mode, HandlingMode::Steer))?;
        let expected_run_id = match params.get("expectedRunId") {
            None => None,
            Some(Value::String(value)) if !value.trim().is_empty() => Some(value.as_str()),
            Some(_) => {
                return Err(GatewayError::invalid(
                    "expectedRunId must be a nonempty string",
                    None,
                ));
            }
        };
        if expected_run_id.is_some() && !matches!(handling_mode, HandlingMode::Steer) {
            return Err(GatewayError::invalid(
                "expectedRunId is only supported for steering",
                None,
            ));
        }
        let has_llm_identity_override = has_turn_llm_identity_override(params);
        if matches!(handling_mode, HandlingMode::Steer) && has_llm_identity_override {
            return Err(GatewayError::invalid(
                "Steering cannot change model, provider, or providerParams; submit a queued turn",
                Some(json!({"handlingMode": "steer"})),
            ));
        }
        let desktop_interactive_turn = match params.get("ingressKind") {
            None => false,
            Some(Value::String(value)) if value == DESKTOP_INTERACTIVE_TURN_INGRESS_KIND => true,
            Some(_) => {
                return Err(GatewayError::invalid(
                    "ingressKind is not a supported desktop ingress",
                    None,
                ));
            }
        };
        let agent =
            optional_string(params, "agent").unwrap_or_else(|| "meerkat-mobkit".to_string());
        let state_root_override = optional_string(params, "stateRoot");
        let handle = self
            .project_runtime_handle_for_paths(
                &project_path,
                &execution_path,
                execution_mode.clone(),
                state_root_override.as_deref(),
            )
            .await?;
        let mob = self.mob_for_params(params, &mob_id).await?;
        let Some(runtime) = mob.runtime.clone() else {
            return Err(GatewayError::policy(
                "Remote TCP send is not wired to a local MobKit client yet",
                Some(json!({"mobId": mob_id})),
            ));
        };
        media::validate_content(runtime.mob_runtime().binary_blob_store(), &prompt).await?;
        let runtime_project_path = {
            let state = handle.state.lock().await;
            state.locator.project_path.clone()
        };
        if let Some(requested_config_state_root) = optional_string(params, "configStateRoot") {
            let requested_locator =
                derive_project_locator(&project_path, Some(&requested_config_state_root))?;
            if requested_locator.state_root != mob.config_state_root {
                return Err(GatewayError::conflict(
                    "Turn configStateRoot does not match the mob runtime",
                    Some(json!({
                        "requestedConfigStateRoot": requested_locator.state_root,
                        "runtimeConfigStateRoot": mob.config_state_root,
                        "mobId": mob_id,
                    })),
                ));
            }
        }

        if matches!(handling_mode, HandlingMode::Steer) {
            let (run_id, projection) = {
                let mut state = handle.state.lock().await;
                let active = state.active_runs.get_mut(&thread_id).ok_or_else(|| {
                    GatewayError::conflict(
                        "Steering requires an active application run",
                        Some(json!({"threadId": thread_id, "expectedRunId": expected_run_id})),
                    )
                })?;
                if active.deliveries.is_cancelling() || active.deliveries.finalizing {
                    return Err(GatewayError::conflict(
                        "The application run is cancelling and cannot accept steering",
                        Some(json!({"runId": active.run_id})),
                    ));
                }
                if expected_run_id.is_some_and(|expected| expected != active.run_id)
                    || active.mob_id != mob_id
                    || active.agent_identity != agent_identity
                {
                    return Err(GatewayError::conflict(
                        "Steering target does not match the active run",
                        Some(
                            json!({"threadId": thread_id, "expectedRunId": expected_run_id,
                            "runId": active.run_id, "mobId": active.mob_id,
                            "agentIdentity": active.agent_identity}),
                        ),
                    ));
                }
                // Reserve before awaiting native admission. The original
                // executor may finish at that boundary, while this delivery
                // continues the same application work run.
                active.deliveries.pending += 1;
                (active.run_id.clone(), Arc::clone(&active.projection))
            };
            return self
                .submit_run_steering(
                    handle,
                    runtime,
                    mob,
                    thread_id,
                    run_id,
                    mob_id,
                    agent_identity,
                    project_path,
                    execution_path,
                    execution_mode,
                    prompt,
                    projection,
                )
                .await;
        }
        {
            let state = handle.state.lock().await;
            if let Some(active_run) = state.active_runs.get(&thread_id) {
                return Err(GatewayError::conflict(
                    "Thread already has an active mob run",
                    Some(json!({"threadId": thread_id, "mobId": mob_id,
                        "runId": active_run.run_id, "startedAt": active_run.started_at})),
                ));
            }
        }

        let member_turn_options = if has_llm_identity_override || !skill_references.is_empty() {
            let realm_config =
                load_effective_realm_config(&runtime_project_path, &mob.config_state_root)
                    .await
                    .map_err(|error| {
                        GatewayError::policy(
                            "Failed to load the mob's workspace configuration",
                            Some(json!({"mobId": mob_id, "error": error})),
                        )
                    })?;
            if realm_config.realm_id.as_str() != mob.realm_id {
                return Err(GatewayError::conflict(
                    "Turn workspace realm does not match the mob runtime",
                    Some(json!({
                        "requestedRealmId": realm_config.realm_id.to_string(),
                        "runtimeRealmId": mob.realm_id,
                        "mobId": mob_id,
                    })),
                ));
            }
            let options = if has_llm_identity_override {
                let current_provider = member_llm_identity(&runtime, &agent_identity)
                    .await
                    .map_err(|error| {
                        GatewayError::policy(
                            "Failed to read the member's current LLM identity",
                            Some(json!({"mobId": mob_id, "error": error})),
                        )
                    })?
                    .map(|identity| identity.provider);
                let catalog = self.inner.provider_auth.selection_catalog(
                    &runtime_project_path, &mob.config_state_root,
                ).await?;
                member_turn_options_with_catalog(
                    params,
                    &realm_config.effective,
                    current_provider,
                    Some(&realm_config.realm_id),
                    &catalog,
                )?
            } else {
                MemberTurnOptions::new()
            };
            native_skills::turn_options(options, &realm_config.effective, skill_references)?
        } else {
            MemberTurnOptions::new()
        };

        let run_id = match params.get("runId") {
            None => Uuid::new_v4().to_string(),
            Some(Value::String(value)) if !value.trim().is_empty() && value.len() <= 200 => value.clone(),
            Some(_) => return Err(GatewayError::invalid("runId must be a nonempty string of at most 200 characters", None)),
        };
        let run_projection = Arc::new(Mutex::new(RunEventProjection::default()));
        let projection_for_task = Arc::clone(&run_projection);
        // Reserve original presentation before exposing ActiveRun. Even a
        // steering request that races the initial RPC receipt stays behind it.
        let original_presentation = run_presentation_guard(&run_projection).await;
        // Only the trusted renderer's top-level sendPrompt path adds the exact
        // ingress marker. Internal peer/helper/scheduled sends call startRun
        // without it, and a turn addressed to any member other than this
        // mob's configured ingress member is likewise ineligible.
        let turn_tool_witness =
            if desktop_interactive_turn && agent_identity == mob.coordinator_identity {
                let (realm_id, runtime_instance_id) = {
                    let state = handle.state.lock().await;
                    (state.locator.realm_id.clone(), state.instance_id.clone())
                };
                Some(DesktopHostInvocationWitnessV1::for_foreground_turn(
                    realm_id,
                    runtime_instance_id,
                    thread_id.clone(),
                    mob_id.clone(),
                    agent_identity.clone(),
                    run_id.clone(),
                    self.inner.host_tools.connection_id().to_string(),
                ))
            } else {
                None
            };
        let turn_tool_overlay = turn_tool_witness
            .as_ref()
            .map(DesktopHostInvocationWitnessV1::turn_tool_overlay)
            .transpose()
            .map_err(GatewayError::host_tools)?;
        let (member_turn_lock, realm_id, instance_id, state_root, context_root) = {
            let mut state = handle.state.lock().await;
            let member_turn_key = format!("{mob_id}::{agent_identity}");
            let member_turn_lock = state
                .member_turn_locks
                .entry(member_turn_key)
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone();
            (
                member_turn_lock,
                state.locator.realm_id.clone(),
                state.instance_id.clone(),
                state.locator.state_root.to_string_lossy().to_string(),
                state.execution_path.to_string_lossy().to_string(),
            )
        };
        let run_started_payload = json!({
            "agent": agent,
            "realmId": realm_id,
            "instanceId": instance_id,
            "stateRoot": state_root,
            "contextRoot": context_root,
            "projectPath": project_path,
            "executionPath": execution_path,
            "executionMode": execution_mode,
            "backingKind": "mob",
            "mobId": mob_id,
            "agentIdentity": agent_identity,
        });
        let (applied_identity_tx, applied_identity_rx) =
            oneshot::channel::<Result<Option<SessionLlmIdentity>, String>>();
        let events_tx = self.inner.events_tx.clone();
        let handle_for_task = handle.clone();
        let thread_id_for_task = thread_id.clone();
        let run_id_for_task = run_id.clone();
        let mob_id_for_task = mob_id.clone();
        let agent_identity_for_task = agent_identity.clone();
        let project_path_for_task = project_path.clone();
        let execution_path_for_task = execution_path.clone();
        let execution_mode_for_task = execution_mode.clone();
        let host_tools_for_task = Arc::clone(&self.inner.host_tools);
        let recovery_root_for_task = PathBuf::from(&state_root);
        let turn_task = async move {
            // Ordinary turns serialize per member. Steering uses its separate
            // reserved delivery and can reach an active executor boundary.
            let _member_turn_guard = member_turn_lock.lock().await;
            let prompt_for_send = restored_prompt_for_send(
                &runtime,
                &agent_identity_for_task,
                &prompt,
                &restored_transcript,
            )
            .await;
            let attribution_result = async {
                let session = runtime.mob_handle().resolve_bridge_session_id(&meerkat_mobkit::member_comms_id::mob_member_id(&agent_identity_for_task)).await
                    .ok_or_else(|| "Target member has no native session".to_string())?;
                let attribution = thread_followups::Attribution {
                    state_root: handle_for_task.state.lock().await.locator.state_root.clone(),
                    thread_id: thread_id_for_task.clone(), mob_id: mob_id_for_task.clone(),
                    session_id: session.to_string(), run_id: run_id_for_task.clone(),
                };
                projection_for_task.lock().await.bind_input_attribution(&agent_identity_for_task, attribution)
                    .map_err(|error|error.to_string())
            }.await;
            if let Err(error) = attribution_result {
                let _ = applied_identity_tx.send(Err(error.clone()));
                // Terminal publication can release the shutdown waiter on a
                // different worker. Drop this task's native owner first.
                drop(runtime);
                finish_run(&events_tx,&handle_for_task,&thread_id_for_task,&run_id_for_task,&mob_id_for_task,&agent_identity_for_task,&project_path_for_task,&execution_path_for_task,&execution_mode_for_task,&host_tools_for_task,Err(RunFailure::Failed(error))).await;
                return;
            }
            let completed = send_to_member_and_emit_events(
                runtime,
                agent_identity_for_task.clone(),
                prompt_for_send,
                thread_id_for_task.clone(),
                run_id_for_task.clone(),
                events_tx.clone(),
                turn_tool_overlay,
                member_turn_options,
                run_started_payload,
                applied_identity_tx,
                projection_for_task,
                original_presentation,
                recovery_root_for_task,
            )
            .await;
            finish_run(
                &events_tx,
                &handle_for_task,
                &thread_id_for_task,
                &run_id_for_task,
                &mob_id_for_task,
                &agent_identity_for_task,
                &project_path_for_task,
                &execution_path_for_task,
                &execution_mode_for_task,
                &host_tools_for_task,
                completed,
            )
            .await;
        };

        // Recheck admission, spawn the turn, and register the ActiveRun
        // under one state lock. The initial active-run lookup
        // above can race with another request; the vacant entry here is the
        // definitive admission decision. `run.started` is emitted by the turn
        // task only after the canonical executor boundary acknowledges the
        // applied LLM identity, and before that task consumes any live events.
        let witness_registered = if let Some(witness) = turn_tool_witness.as_ref() {
            self.inner
                .host_tools
                .register_turn_witness(witness)
                .map_err(GatewayError::host_tools)?;
            true
        } else {
            false
        };
        {
            let mut state = handle.state.lock().await;
            if !state.active_runs.contains_key(&thread_id) {
                if let Err(error) = thread_recovery::reserve(&state.locator.state_root, params, &run_id, &thread_recovery::gateway_owner(self)) {
                    if witness_registered { self.inner.host_tools.revoke_turn_witness(&run_id); }
                    return Err(error);
                }
            }
            let admission = admit_active_run_locked(&mut state, &thread_id, || {
                tokio::spawn(turn_task);
                ActiveRun {
                    run_id: run_id.clone(),
                    mob_id: mob_id.clone(),
                    agent_identity: agent_identity.clone(),
                    started_at: Utc::now(),
                    deliveries: AppRunDeliveries::default(),
                    projection: run_projection,
                }
            });
            if let Err(active_run) = admission {
                if witness_registered {
                    self.inner.host_tools.revoke_turn_witness(&run_id);
                }
                return Err(GatewayError::conflict(
                    "Thread already has an active mob run",
                    Some(json!({
                        "threadId": thread_id,
                        "mobId": active_run.mob_id,
                        "runId": active_run.run_id,
                        "startedAt": active_run.started_at,
                    })),
                ));
            }
        }

        let applied_identity = applied_identity_rx
            .await
            .map_err(|_| {
                GatewayError::policy(
                    "MobKit turn ended before LLM identity acknowledgement",
                    Some(json!({"runId": run_id, "mobId": mob_id})),
                )
            })?
            .map_err(|error| {
                GatewayError::policy(
                    "MobKit could not apply the requested LLM identity",
                    Some(json!({"runId": run_id, "mobId": mob_id, "error": error})),
                )
            })?;

        Ok(json!({
            "runId": run_id,
            "threadId": thread_id,
            "status": "running",
            "agent": agent,
            "realmId": realm_id,
            "instanceId": instance_id,
            "stateRoot": state_root,
            "contextRoot": context_root,
            "projectPath": project_path,
            "executionPath": execution_path,
            "executionMode": execution_mode,
            "backingKind": "mob",
            "mobId": mob_id,
            "agentIdentity": agent_identity,
            "mode": "started",
            "appliedModel": applied_identity.as_ref().map(|identity| identity.model.clone()),
            "appliedProvider": applied_identity
                .as_ref()
                .map(|identity| identity.provider.as_str()),
        }))
    }

    async fn create_local_mob(
        &self,
        params: &serde_json::Map<String, Value>,
        request: CreateMobRequest,
    ) -> Result<Arc<mobkit_registry::MobkitMobRuntime>, GatewayError> {
        let project_path = required_string(params, "projectPath")?;
        let execution_path =
            optional_string(params, "executionPath").unwrap_or_else(|| project_path.clone());
        let execution_mode =
            optional_string(params, "executionMode").unwrap_or_else(|| "local".to_string());
        let state_root_override = optional_string(params, "stateRoot");
        let config_state_root_override = optional_string(params, "configStateRoot");
        let handle = self
            .project_runtime_handle_for_paths(
                &project_path,
                &execution_path,
                execution_mode,
                state_root_override.as_deref(),
            )
            .await?;
        let (locator, execution_path) = {
            let state = handle.state.lock().await;
            (state.locator.clone(), state.execution_path.clone())
        };
        let config_state_root = match config_state_root_override.as_deref() {
            Some(config_state_root) => {
                derive_project_locator(&project_path, Some(config_state_root))?.state_root
            }
            None => locator.state_root.clone(),
        };
        let initial_llm = if request.kind == "domain"
            && (params.contains_key("provider") || params.contains_key("providerParams"))
        {
            let catalog = self.inner.provider_auth.selection_catalog(
                &locator.project_path, &config_state_root,
            ).await?;
            Some(native_model::InitialAgentLlmRequest { params: params.iter()
                .filter(|(key, _)| matches!(key.as_str(), "model" | "provider" | "providerParams"))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(), catalog })
        } else {
            None
        };
        let state = handle.state.lock().await;
        state
            .mobkit
            .create_local(CreateMobInput {
                mob_id: request.mob_id,
                kind: request.kind,
                label: request.label,
                role: request.role,
                coordinator_identity: request.coordinator_identity,
                model: request.model,
                initial_llm,
                instructions: request.instructions,
                thread_id: optional_string(params, "threadId"),
                include_native_workers: request.include_native_workers,
                access_mode: native_execution_modes::requested_mode(params)?,
                config_project_path: locator.project_path,
                project_path: execution_path,
                state_root: locator.state_root,
                config_state_root,
            })
            .await
            .map_err(|error| {
                GatewayError::policy("Failed to create MobKit mob", Some(json!({"error": error})))
            })
    }

    async fn submit_run_steering(
        &self,
        handle: Arc<ProjectRuntimeHandle>,
        runtime: Arc<meerkat_mobkit::UnifiedRuntime>,
        mob: Arc<mobkit_registry::MobkitMobRuntime>,
        thread_id: String,
        run_id: String,
        mob_id: String,
        agent_identity: String,
        project_path: String,
        execution_path: String,
        execution_mode: String,
        prompt: ContentInput,
        projection: Arc<Mutex<RunEventProjection>>,
    ) -> Result<Value, GatewayError> {
        let (receipt_tx, receipt_rx) = oneshot::channel();
        let events_tx = self.inner.events_tx.clone();
        let host_tools = Arc::clone(&self.inner.host_tools);
        let response_run_id = run_id.clone();
        let response_thread_id = thread_id.clone();
        // The task owns the reservation even if the requesting connection
        // disconnects. Never abandon an admitted input or replay it implicitly.
        tokio::spawn(async move {
            let typed = async {
                let console = mob.console.as_ref().ok_or_else(|| GatewayError::policy("Native console is unavailable", None))?;
                let record = console.inspect_identity(&agent_identity).await
                    .map_err(|error| GatewayError::policy(error.to_string(), None))?
                    .ok_or_else(|| GatewayError::conflict("Native steering member is unavailable", None))?.identity;
                let expected = mobkit_registry::ConsoleExpectedTarget {
                    identity: record.identity, runtime_key: record.runtime_key,
                    runtime_member_id: record.runtime_member_id, session_id: record.session_id,
                    source_mob_id: record.labels.get("source_mob_id").cloned(),
                };
                let original_session = {
                    let state = projection.lock().await;
                    state.delivery_scope.as_ref().map(|value| value.session_id.clone())
                        .or_else(|| state.assembler.native_session_id.clone())
                };
                if original_session.is_some() && original_session != expected.session_id {
                    return Err(GatewayError::conflict("The active application run belongs to another native session", None));
                }
                if !mob.console_target_busy(&expected).await.map_err(|error| GatewayError::conflict(error, None))? {
                    return Ok::<_, GatewayError>(None);
                }
                let request = Uuid::new_v4().to_string();
                let key = native_steering::native_key(&mob_id, &expected, &request)?;
                let admission = native_steering::admit(&mob, &expected, prompt.clone(), key.clone()).await?;
                let receipt = native_steering::receipt(&expected, &admission, &request, &key);
                Ok(Some((admission, receipt)))
            }.await;
            match typed {
                Ok(Some((admission, receipt))) => {
                    let cancelling = handle.state.lock().await.active_runs.get(&thread_id)
                        .is_some_and(|run| run.run_id == run_id && run.deliveries.is_cancelling());
                    if cancelling {
                        if let Some(machine) = &mob.session_runtime {
                            if let Err(error) = machine.cancel_input_if_present(&admission.session, &admission.input_id, "Application run stopped").await {
                                warn!(run_id, %error, "reserved steering cancellation was not accepted");
                            }
                        }
                    }
                    let _ = receipt_tx.send(Ok(receipt));
                    emit_named_event(&events_tx, "run.steering_submitted", &thread_id, Some(&run_id), json!({"handlingMode":"steer"}));
                    // The original turn already owns the run stream. This
                    // input joins it and only adds a completion reservation.
                    let result = native_steering::wait(admission).await;
                    // The detached task can outlive the RPC that admitted it.
                    // Release its owners before finish_run publishes terminality.
                    drop(mob);
                    drop(runtime);
                    finish_run(&events_tx, &handle, &thread_id, &run_id, &mob_id, &agent_identity,
                        &project_path, &execution_path, &execution_mode, &host_tools, result).await;
                    return;
                }
                Err(error) => {
                    let _ = receipt_tx.send(Err(error.to_string()));
                    drop(mob);
                    drop(runtime);
                    finish_run(&events_tx, &handle, &thread_id, &run_id, &mob_id, &agent_identity,
                        &project_path, &execution_path, &execution_mode, &host_tools, Ok(())).await;
                    return;
                }
                Ok(None) => {},
            }
            // If the previous executor already finished while the app is
            // draining its output, keep the existing tracked idle continuation.
            let (event_tx, event_rx) = tokio::sync::mpsc::channel(256);
            let event_rx = buffer_member_events(event_rx);
            let admission = runtime
                .start_member_turn(
                    &agent_identity,
                    prompt,
                    HandlingMode::Steer,
                    MemberTurnOptions::new(),
                    Some(event_tx),
                )
                .await;
            let result = match admission {
                Ok(admission) => {
                    // Cancellation may have crossed an already-reserved
                    // admission. Apply it to this accepted continuation too.
                    let cancelling = handle
                        .state
                        .lock()
                        .await
                        .active_runs
                        .get(&thread_id)
                        .is_some_and(|run| run.run_id == run_id && run.deliveries.is_cancelling());
                    if cancelling {
                        if let Err(error) = runtime
                            .mob_handle()
                            .force_cancel_member(AgentIdentity::from(agent_identity.as_str()))
                            .await
                        {
                            warn!(run_id, %error, "reserved steering cancellation was not accepted");
                        }
                    }
                    let receipt = serde_json::to_value(admission.turn.receipt())
                        .expect("native delivery receipt serialization");
                    let _ = receipt_tx.send(Ok(receipt));
                    emit_named_event(
                        &events_tx,
                        "run.steering_submitted",
                        &thread_id,
                        Some(&run_id),
                        json!({"handlingMode": "steer"}),
                    );
                    drain_tracked_member_turn(
                        admission.turn,
                        event_rx,
                        projection,
                        &events_tx,
                        &thread_id,
                        &run_id,
                        true,
                        None,
                    )
                    .await
                }
                Err(error) => {
                    let _ = receipt_tx.send(Err(error.to_string()));
                    // Rejection removes only this reservation. It cannot
                    // change the original run's eventual native outcome.
                    Ok(())
                }
            };
            // The idle continuation's turn and event stream have settled.
            // Drop both remaining owners before waking process shutdown.
            drop(mob);
            drop(runtime);
            finish_run(
                &events_tx,
                &handle,
                &thread_id,
                &run_id,
                &mob_id,
                &agent_identity,
                &project_path,
                &execution_path,
                &execution_mode,
                &host_tools,
                result,
            )
            .await;
        });
        let receipt = receipt_rx
            .await
            .map_err(|_| {
                GatewayError::policy(
                    "Steering delivery ended before native admission could be observed",
                    Some(json!({"runId": response_run_id, "deliveryOutcome": "unknown"})),
                )
            })?
            .map_err(|error| {
                GatewayError::policy(
                    "MobKit rejected steering admission",
                    Some(json!({"runId": response_run_id, "error": error})),
                )
            })?;
        Ok(json!({
            "runId": response_run_id, "threadId": response_thread_id,
            "mode": "steering_submitted", "handlingMode": "steer",
            "status": "running", "runtimeReceipt": receipt,
        }))
    }

    async fn mob_for_params(
        &self,
        params: &serde_json::Map<String, Value>,
        mob_id: &str,
    ) -> Result<Arc<mobkit_registry::MobkitMobRuntime>, GatewayError> {
        let handle = self.project_runtime_handle_for_mob_params(params).await?;
        let state = handle.state.lock().await;
        state
            .mobkit
            .get(mob_id)
            .await
            .ok_or_else(|| GatewayError::not_found("Unknown mob", Some(json!({"mobId": mob_id}))))
    }

    async fn mob_for_project(
        &self,
        project_path: &str,
        execution_path: &str,
        execution_mode: String,
        state_root_override: Option<&str>,
        mob_id: &str,
    ) -> Result<Arc<mobkit_registry::MobkitMobRuntime>, GatewayError> {
        let handle = self
            .project_runtime_handle_for_paths(
                project_path,
                execution_path,
                execution_mode,
                state_root_override,
            )
            .await?;
        let state = handle.state.lock().await;
        state
            .mobkit
            .get(mob_id)
            .await
            .ok_or_else(|| GatewayError::not_found("Unknown mob", Some(json!({"mobId": mob_id}))))
    }

    async fn project_runtime_handle_for_mob_params(
        &self,
        params: &serde_json::Map<String, Value>,
    ) -> Result<Arc<ProjectRuntimeHandle>, GatewayError> {
        let project_path = required_string(params, "projectPath")?;
        let execution_path =
            optional_string(params, "executionPath").unwrap_or_else(|| project_path.clone());
        let execution_mode =
            optional_string(params, "executionMode").unwrap_or_else(|| "local".to_string());
        let state_root_override = optional_string(params, "stateRoot");
        self.project_runtime_handle_for_paths(
            &project_path,
            &execution_path,
            execution_mode,
            state_root_override.as_deref(),
        )
        .await
    }

    async fn project_runtime_handle_for_paths(
        &self,
        project_path: &str,
        execution_path: &str,
        execution_mode: String,
        state_root_override: Option<&str>,
    ) -> Result<Arc<ProjectRuntimeHandle>, GatewayError> {
        let locator = derive_project_locator(project_path, state_root_override)?;
        let execution_path = normalize_project_path(execution_path)?;
        let key = project_runtime_key(&locator, &execution_path);
        let mut runtimes = self.inner.project_runtimes.lock().await;
        if self.inner.shutting_down.load(Ordering::SeqCst) {
            return Err(GatewayError::conflict("Gateway is shutting down", None));
        }
        if let Some(existing) = runtimes.get(&key) {
            return Ok(existing.clone());
        }
        // A MobKit runtime's exclusive topology controller is owned by the
        // durable state root, not by the app's project/execution projection.
        // A cold restore and a foreground send may reach the same state
        // through different execution handles (for example a workspace and a
        // worktree). Reusing one registry per canonical state root makes that
        // physical ownership explicit and prevents a second bootstrap from
        // contending with the first runtime already held by this gateway.
        let mobkit = {
            let mut registries = self.inner.mobkit_registries.lock().await;
            Arc::clone(
                registries
                    .entry(locator.state_root.clone())
                    .or_insert_with(|| {
                        Arc::new(ProjectMobkitRegistry::with_shared_tools(
                            Arc::clone(&self.inner.host_tools),
                            Arc::clone(&self.inner.shared_tools),
                        ))
                    }),
            )
        };
        let handle = Arc::new(ProjectRuntimeHandle {
            runs_settled: tokio::sync::Notify::new(),
            state: Mutex::new(ProjectRuntimeState {
                locator,
                execution_path,
                execution_mode,
                instance_id: project_runtime_instance_id(&key),
                mobkit,
                active_runs: HashMap::new(),
                member_turn_locks: HashMap::new(),
                dirty: false,
            }),
        });
        runtimes.insert(key, handle.clone());
        Ok(handle)
    }
}

struct CreateMobRequest {
    mob_id: String,
    kind: String,
    label: String,
    role: String,
    coordinator_identity: String,
    model: String,
    instructions: String,
    include_native_workers: bool,
}

/// Hold a send until any legacy autonomous spawn-kickoff has resolved.
///
/// A prompt submitted mid-kickoff queues behind it. The runtime's kickoff
/// state machine is the authority for whether that initial turn is still in
/// flight; transcript shape is not. In particular, an empty/not-yet-persisted
/// history or an intermediate non-user message must not make this barrier
/// return early and let the kickoff reply masquerade as the user's answer.
async fn wait_for_member_kickoff_quiescence(
    runtime: &meerkat_mobkit::UnifiedRuntime,
    agent_identity: &str,
    max_wait: Duration,
) -> Result<(), String> {
    let member_id = meerkat_mobkit::member_comms_id::mob_member_id(agent_identity);
    let snapshots = runtime
        .mob_handle()
        .wait_for_members_kickoff_complete(&[member_id], Some(max_wait))
        .await
        .map_err(|error| {
            format!(
                "member '{agent_identity}' kickoff did not resolve before the user turn: {error}"
            )
        })?;

    let Some((_, snapshot)) = snapshots.first() else {
        return Err(format!(
            "member '{agent_identity}' disappeared before its kickoff resolved"
        ));
    };
    let phase = snapshot.kickoff.as_ref().map(|kickoff| kickoff.phase);
    if !member_kickoff_phase_is_quiescent(phase) {
        return Err(format!(
            "member '{agent_identity}' kickoff resolved as {phase:?}: {}",
            snapshot
                .kickoff
                .as_ref()
                .and_then(|kickoff| kickoff.error.as_deref())
                .unwrap_or("no kickoff error was reported")
        ));
    }
    Ok(())
}

fn member_kickoff_phase_is_quiescent(phase: Option<meerkat_mob::MobMemberKickoffPhase>) -> bool {
    // Turn-driven members have no autonomous kickoff. A failed/cancelled
    // legacy autonomous kickoff owns a dead session and must fail promptly;
    // admitting a user turn there causes a multi-minute wait with no events.
    matches!(
        phase,
        None | Some(meerkat_mob::MobMemberKickoffPhase::Started)
    )
}

async fn send_to_member_and_emit_events(
    runtime: Arc<meerkat_mobkit::UnifiedRuntime>,
    agent_identity: String,
    prompt: ContentInput,
    thread_id: String,
    run_id: String,
    events_tx: broadcast::Sender<EventEmit>,
    turn_tool_overlay: Option<TurnToolOverlay>,
    mut member_turn_options: MemberTurnOptions,
    mut run_started_payload: Value,
    applied_identity_tx: oneshot::Sender<Result<Option<SessionLlmIdentity>, String>>,
    projection: Arc<Mutex<RunEventProjection>>,
    presentation: tokio::sync::OwnedMutexGuard<()>,
    recovery_root: PathBuf,
) -> Result<(), RunFailure> {
    if let Err(error) =
        wait_for_member_kickoff_quiescence(&runtime, &agent_identity, Duration::from_secs(45)).await
    {
        let _ = applied_identity_tx.send(Err(error.clone()));
        return Err(error.into());
    }
    if let Some(overlay) = turn_tool_overlay {
        member_turn_options = member_turn_options.with_turn_tool_overlay(overlay);
    }
    let native_session = match runtime.mob_handle()
        .resolve_bridge_session_id(&meerkat_mobkit::member_comms_id::mob_member_id(&agent_identity)).await {
        Some(session) => Some(session.to_string()),
        None => {
            let message = "Cannot bind the native session before dispatch".to_string();
            let _ = applied_identity_tx.send(Err(message.clone()));
            return Err(message.into());
        }
    };
    if let Err(error) = thread_recovery::dispatching(&recovery_root, &run_id, native_session) {
        let message = error.to_string();
        let _ = applied_identity_tx.send(Err(message.clone()));
        return Err(message.into());
    }
    let (event_tx, event_rx) = tokio::sync::mpsc::channel(256);
    let event_rx = buffer_member_events(event_rx);
    let started = match start_mobkit_member_turn(
        &runtime,
        &agent_identity,
        prompt,
        HandlingMode::Queue,
        member_turn_options,
        Some(event_tx),
    )
    .await
    {
        Ok(started) => started,
        Err(error) => {
            let _ = applied_identity_tx.send(Err(error.clone()));
            return Err(error.into());
        }
    };
    let admission = thread_recovery::admitted(&recovery_root, &run_id,
        started.turn.session_id().map(ToString::to_string),
        serde_json::to_value(started.turn.receipt()).unwrap_or(Value::Null));
    let identity = started.applied_llm_identity;
    if let Some(payload) = run_started_payload.as_object_mut() {
        payload.insert(
            "appliedModel".into(),
            identity
                .as_ref()
                .map(|identity| Value::String(identity.model.clone()))
                .unwrap_or(Value::Null),
        );
        payload.insert(
            "appliedProvider".into(),
            identity
                .as_ref()
                .map(|identity| Value::String(identity.provider.as_str().to_string()))
                .unwrap_or(Value::Null),
        );
    }
    emit_named_event(
        &events_tx,
        "run.started",
        &thread_id,
        Some(&run_id),
        run_started_payload,
    );
    let admission_error = admission.err().map(|error|error.to_string());
    let _ = applied_identity_tx.send(match &admission_error { Some(error) => Err(error.clone()), None => Ok(identity) });
    let result = drain_tracked_member_turn(
        started.turn,
        event_rx,
        projection,
        &events_tx,
        &thread_id,
        &run_id,
        false,
        Some(presentation),
    )
    .await;
    // An admission journal failure must not drop a native turn that has already
    // started. Drain its exact completion before reporting the persistence fault.
    result?;
    if let Some(error) = admission_error { return Err(error.into()); }
    Ok(())
}

async fn run_presentation_guard(
    projection: &Arc<Mutex<RunEventProjection>>,
) -> tokio::sync::OwnedMutexGuard<()> {
    let presentation = Arc::clone(&projection.lock().await.presentation);
    presentation.lock_owned().await
}

fn buffer_member_events(
    mut events: tokio::sync::mpsc::Receiver<EventEnvelope<AgentEvent>>,
) -> tokio::sync::mpsc::UnboundedReceiver<EventEnvelope<AgentEvent>> {
    let (buffer_tx, buffer_rx) = tokio::sync::mpsc::unbounded_channel();
    // Native batched inputs can fan out one event to several bounded
    // observers. Always drain those observers independently of presentation,
    // or a later stream can block an earlier stream's committed terminal.
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = buffer_tx.closed() => break,
                event = events.recv() => {
                    let Some(event) = event else { break };
                    if buffer_tx.send(event).is_err() { break; }
                }
            }
        }
    });
    buffer_rx
}

async fn project_run_event(
    projection: &Arc<Mutex<RunEventProjection>>,
    event: &EventEnvelope<AgentEvent>,
    thread_id: &str,
    run_id: &str,
    events_tx: &broadcast::Sender<EventEmit>,
) -> Result<bool, RunFailure> {
    let mut state = projection.lock().await;
    if state.seen.contains(&event.event_id) {
        return Ok(matches!(
            &event.payload,
            AgentEvent::RunCompleted { .. } | AgentEvent::InteractionComplete { .. }
        ));
    }
    if let AgentEvent::RunStarted { session_id, identity, .. } = &event.payload {
        state.assembler = LiveEventAssembler::default();
        state.assembler.native_session_id = Some(session_id.to_string());
        state.assembler.native_run_id = identity.run_id.clone();
        state.assembler.native_segment_id = Some(event.event_id.to_string());
        state.native_identity_ready.notify_waiters();
    }
    state.assembler.delivery_scope = state.delivery_scope.clone();
    state.assembler.followup_scope = state.followup.clone();
    if state.assembler.native_session_id.is_none() {
        state.assembler.native_session_id = state.delivery_scope.as_ref().map(|value|value.session_id.clone());
    }
    let result = {
        let state = &mut *state;
        process_agent_event_envelope(
        event,
        thread_id,
        run_id,
        &mut state.assembler,
        events_tx,
        &mut state.emitted,
        )
    };
    if result.is_err() {
        if !matches!(&event.payload, AgentEvent::RunFailed { .. } | AgentEvent::InteractionFailed { .. }) {
            state.followup_failed = true;
            if !state.pending_events.iter().any(|pending| pending.event_id == event.event_id) {
                state.pending_events.push(event.clone());
            }
        }
        return result;
    }
    if matches!(&event.payload, AgentEvent::RunCompleted { .. } | AgentEvent::InteractionComplete { .. }) {
        if let Some(attribution) = &state.followup {
            if let Err(error) = thread_followups::record(attribution, &format!("evt-agent-{}", event.event_id)) {
                state.followup_failed = true;
                if !state.pending_events.iter().any(|pending| pending.event_id == event.event_id) {
                    state.pending_events.push(event.clone());
                }
                return Err(RunFailure::Delivery(error.to_string()));
            }
        }
    }
    state.seen.insert(event.event_id);
    state.pending_events.retain(|pending| pending.event_id != event.event_id);
    state.followup_failed = !state.pending_events.is_empty();
    result
}

async fn observed_native_run(
    projection: &Arc<Mutex<RunEventProjection>>,
) -> (Option<String>, Option<meerkat_core::RunId>) {
    let ready = Arc::clone(&projection.lock().await.native_identity_ready);
    // A tool invocation can reach the host before the native event forwarder
    // presents RunStarted. Wait for that exact stream, never substitute the
    // member's current run (which might already belong to another input).
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let observed = ready.notified();
            tokio::pin!(observed);
            observed.as_mut().enable();
            let state = projection.lock().await;
            if state.assembler.native_session_id.is_some()
                && state.assembler.native_run_id.is_some()
            {
                return;
            }
            drop(state);
            observed.await;
        }
    })
    .await;
    let state = projection.lock().await;
    (
        state.assembler.native_session_id.clone(),
        state.assembler.native_run_id.clone(),
    )
}

/// The native per-input observer is the correlation authority. Live steering
/// completes without an executor stream; idle steering owns its exact stream.
/// Drain both the stream and committed completion before releasing app work.
async fn drain_tracked_member_turn(
    turn: meerkat_mob::MemberTurnHandle,
    events: tokio::sync::mpsc::UnboundedReceiver<EventEnvelope<AgentEvent>>,
    projection: Arc<Mutex<RunEventProjection>>,
    events_tx: &broadcast::Sender<EventEmit>,
    thread_id: &str,
    run_id: &str,
    is_steering: bool,
    presentation: Option<tokio::sync::OwnedMutexGuard<()>>,
) -> Result<(), RunFailure> {
    let observe = present_member_events(
        events,
        projection,
        events_tx,
        thread_id,
        run_id,
        presentation,
    );
    let ((failure, terminal_seen, any_event), completion) = tokio::join!(observe, turn.wait());
    if let Some(failure) = failure {
        return Err(failure);
    }
    completion.map_err(|error| RunFailure::Failed(error.to_string()))?;
    if !terminal_seen && !(is_steering && !any_event) {
        return Err(RunFailure::Failed(
            "MobKit delivery completed without its canonical terminal event".into(),
        ));
    }
    Ok(())
}

async fn present_member_events(
    mut events: tokio::sync::mpsc::UnboundedReceiver<EventEnvelope<AgentEvent>>,
    projection: Arc<Mutex<RunEventProjection>>,
    events_tx: &broadcast::Sender<EventEmit>,
    thread_id: &str,
    run_id: &str,
    presentation: Option<tokio::sync::OwnedMutexGuard<()>>,
) -> (Option<RunFailure>, bool, bool) {
    // This lock serializes presentation only. All native channels are being
    // drained concurrently by their independent buffer tasks.
    let _presentation = match presentation {
        Some(presentation) => presentation,
        None => run_presentation_guard(&projection).await,
    };
    let mut failure = None;
    let mut terminal_seen = false;
    let mut any_event = false;
    while let Some(event) = events.recv().await {
        any_event = true;
        match &event.payload {
            AgentEvent::RunCompleted { .. } | AgentEvent::InteractionComplete { .. } => {
                terminal_seen = true
            }
            AgentEvent::RunFailed { error_report, .. } => {
                failure = Some(RunFailure::from_report(error_report));
                terminal_seen = true;
            }
            AgentEvent::InteractionFailed { reason, .. } => {
                failure = Some(RunFailure::from_interaction(reason));
                terminal_seen = true;
            }
            _ => {}
        }
        if let Err(error) =
            project_run_event(&projection, &event, thread_id, run_id, events_tx).await
        {
            failure = Some(error);
        }
    }
    (failure, terminal_seen, any_event)
}

struct MemberAskResult {
    session_id: String,
    answer_text: String,
    messages: Vec<Value>,
}

async fn ask_member_for_response(
    runtime: Arc<meerkat_mobkit::UnifiedRuntime>,
    agent_identity: String,
    prompt: String,
    timeout: Duration,
) -> Result<MemberAskResult, String> {
    wait_for_member_kickoff_quiescence(&runtime, &agent_identity, Duration::from_secs(45)).await?;
    let session_id =
        send_to_member(&runtime, &agent_identity, &prompt, HandlingMode::Queue).await?;
    let started = std::time::Instant::now();
    loop {
        let session_is_active = read_session_is_active(&runtime, &session_id).await?;
        let messages = read_session_history_messages(&runtime, &session_id).await?;
        let history_window = history_window_after_latest_user_prompt(&messages, &prompt);
        let answer_text =
            terminal_assistant_index_for_history_recovery(&history_window, session_is_active)
                .and_then(|index| assistant_message_text(&history_window.messages[index]));
        if let Some(answer_text) = answer_text {
            return Ok(MemberAskResult {
                session_id,
                answer_text,
                messages: history_window.messages,
            });
        }
        if started.elapsed() >= timeout {
            return Err(format!(
                "Timed out waiting for MobKit member response after {}s (session_id={session_id})",
                timeout.as_secs()
            ));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn restored_prompt_for_send(
    runtime: &meerkat_mobkit::UnifiedRuntime,
    agent_identity: &str,
    prompt: &ContentInput,
    restored_transcript: &[RestoredTranscriptEntry],
) -> ContentInput {
    if restored_transcript.is_empty() || !should_seed_restored_transcript(runtime, agent_identity, restored_transcript).await {
        return prompt.clone();
    }
    let Some(seed) = render_restored_transcript_seed(restored_transcript) else { return prompt.clone(); };
    let mut blocks = vec![ContentBlock::Text { text: format!("{seed}\n\nCurrent user message:\n") }];
    blocks.extend(prompt.clone().into_blocks());
    ContentInput::Blocks(blocks)
}

async fn should_seed_restored_transcript(
    runtime: &meerkat_mobkit::UnifiedRuntime,
    agent_identity: &str,
    restored_transcript: &[RestoredTranscriptEntry],
) -> bool {
    let identity = AgentIdentity::from(agent_identity);
    let Some(session_id) = runtime
        .mob_handle()
        .resolve_bridge_session_id(&identity)
        .await
    else {
        return true;
    };
    match read_session_history_messages(runtime, &session_id.to_string()).await {
        Ok(messages) if !messages.is_empty() => {
            !session_history_contains_restored_tail(&messages, restored_transcript)
        }
        Ok(_) => true,
        Err(error) => {
            warn!(
                agent_identity,
                error, "could not inspect MobKit member history before restored transcript seed"
            );
            true
        }
    }
}

/// The desktop consumes Meerkat's effective model registry instead of
/// maintaining a second, inevitably stale model list. The app keeps its
/// existing outer contract-version string, while provider/model/profile
/// ownership comes directly from the pinned Meerkat release.
fn effective_models_catalog(config: &meerkat::Config) -> Result<Value, GatewayError> {
    let catalog = meerkat::surface::build_models_catalog_response(config).map_err(|error| {
        GatewayError::policy(
            "Failed to resolve the Meerkat model catalog",
            Some(json!({"error": error.to_string()})),
        )
    })?;
    serde_json::to_value(catalog).map_err(|error| {
        GatewayError::policy(
            "Failed to serialize the Meerkat model catalog",
            Some(json!({"error": error.to_string()})),
        )
    })
}

#[derive(Clone, Debug)]
pub(crate) struct EffectiveCatalogModel {
    id: String,
    provider: Provider,
    server_id: Option<String>,
    params_schema: Value,
}

fn effective_catalog_models(
    config: &meerkat::Config,
) -> Result<Vec<EffectiveCatalogModel>, GatewayError> {
    let catalog = effective_models_catalog(config)?;
    catalog_models(&catalog)
}

fn catalog_models(catalog: &Value) -> Result<Vec<EffectiveCatalogModel>, GatewayError> {
    let mut models = Vec::new();
    for provider_catalog in catalog
        .get("providers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let provider_name = provider_catalog
            .get("provider")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                GatewayError::policy("Meerkat model catalog has an invalid provider entry", None)
            })?;
        let provider = Provider::parse_strict(provider_name).ok_or_else(|| {
            GatewayError::policy(
                "Meerkat model catalog exposed an unsupported provider",
                Some(json!({"provider": provider_name})),
            )
        })?;
        for model in provider_catalog
            .get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let id = model
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    GatewayError::policy("Meerkat model catalog has an invalid model entry", None)
                })?
                .to_string();
            let params_schema = model
                .get("profile")
                .and_then(|profile| profile.get("params_schema"))
                .cloned()
                .unwrap_or_else(|| {
                    json!({
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {}
                    })
                });
            models.push(EffectiveCatalogModel {
                id,
                provider,
                server_id: model
                    .get("server_id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                params_schema,
            });
        }
    }
    Ok(models)
}

fn turn_identity_string(
    params: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<String>, GatewayError> {
    let Some(value) = params.get(key) else {
        return Ok(None);
    };
    let value = value.as_str().ok_or_else(|| {
        GatewayError::invalid(
            format!("{key} must be a non-empty string when provided"),
            Some(json!({"field": key, "value": value})),
        )
    })?;
    let value = value.trim();
    if value.is_empty() {
        return Err(GatewayError::invalid(
            format!("{key} must be a non-empty string when provided"),
            None,
        ));
    }
    Ok(Some(value.to_string()))
}

fn has_turn_llm_identity_override(params: &serde_json::Map<String, Value>) -> bool {
    ["model", "provider", "providerParams"]
        .iter()
        .any(|key| params.contains_key(*key))
}

fn member_turn_options_from_params(
    params: &serde_json::Map<String, Value>,
    config: &meerkat::Config,
    current_provider: Option<Provider>,
) -> Result<MemberTurnOptions, GatewayError> {
    member_turn_options_for_realm(params, config, current_provider, None)
}

fn member_turn_options_for_realm(
    params: &serde_json::Map<String, Value>,
    config: &meerkat::Config,
    current_provider: Option<Provider>,
    realm: Option<&meerkat_core::RealmId>,
) -> Result<MemberTurnOptions, GatewayError> {
    member_turn_options_with_catalog(
        params, config, current_provider, realm, &effective_catalog_models(config)?,
    )
}

fn member_turn_options_with_catalog(
    params: &serde_json::Map<String, Value>,
    config: &meerkat::Config,
    current_provider: Option<Provider>,
    realm: Option<&meerkat_core::RealmId>,
    catalog: &[EffectiveCatalogModel],
) -> Result<MemberTurnOptions, GatewayError> {
    let requested_model = turn_identity_string(params, "model")?;
    let requested_provider_name = turn_identity_string(params, "provider")?;
    if requested_provider_name.is_some() && requested_model.is_none() {
        return Err(GatewayError::invalid(
            "provider requires an exact model selection",
            Some(json!({"provider": requested_provider_name})),
        ));
    }
    let requested_provider = requested_provider_name
        .as_deref()
        .map(|provider| {
            Provider::parse_strict(provider).ok_or_else(|| {
                GatewayError::invalid(
                    "provider is not supported by Meerkat",
                    Some(json!({"provider": provider})),
                )
            })
        })
        .transpose()?;

    let catalog_model = if let Some(model_id) = requested_model.as_deref() {
        let matches = catalog
            .iter()
            .filter(|entry| entry.id == model_id)
            .cloned()
            .collect::<Vec<_>>();
        let selected = if let Some(provider) = requested_provider {
            matches
                .iter()
                .find(|entry| entry.provider == provider)
                .cloned()
                .ok_or_else(|| {
                    GatewayError::invalid(
                        "model does not belong to the requested provider",
                        Some(json!({
                            "model": model_id,
                            "provider": provider.as_str(),
                            "catalogProviders": matches
                                .iter()
                                .map(|entry| entry.provider.as_str())
                                .collect::<Vec<_>>(),
                        })),
                    )
                })?
        } else if matches.len() == 1 {
            matches[0].clone()
        } else if matches.is_empty() {
            return Err(GatewayError::invalid(
                "model is not present in the effective Meerkat catalog",
                Some(json!({"model": model_id})),
            ));
        } else {
            return Err(GatewayError::invalid(
                "model is ambiguous; provider is required",
                Some(json!({
                    "model": model_id,
                    "catalogProviders": matches
                        .iter()
                        .map(|entry| entry.provider.as_str())
                        .collect::<Vec<_>>(),
                })),
            ));
        };
        Some(selected)
    } else {
        None
    };

    let provider_params = match params.get("providerParams") {
        None => None,
        Some(Value::Null) => Some(TurnMetadataOverride::Clear),
        Some(value @ Value::Object(_)) => {
            let catalog_model = catalog_model.as_ref().ok_or_else(|| {
                GatewayError::invalid(
                    "providerParams requires an exact model selection",
                    Some(json!({"providerParams": value})),
                )
            })?;
            Some(TurnMetadataOverride::Set(typed_provider_params(
                catalog_model,
                value,
            )?))
        }
        Some(value) => {
            return Err(GatewayError::invalid(
                "providerParams must be an object or null",
                Some(json!({"providerParams": value})),
            ));
        }
    };
    let provider_params = match (provider_params, catalog_model.as_ref(), current_provider) {
        (None, Some(catalog_model), Some(current_provider))
            if catalog_model.provider != current_provider =>
        {
            // Core's Preserve semantics are deliberately literal and would
            // retain the old provider tag across a provider-family switch.
            // Clear that stale tag at this public boundary.
            Some(TurnMetadataOverride::Clear)
        }
        (None, Some(catalog_model), None) => {
            return Err(GatewayError::invalid(
                "providerParams must be an object or null when the current provider is unavailable",
                Some(json!({
                    "model": catalog_model.id,
                    "provider": catalog_model.provider.as_str(),
                })),
            ));
        }
        (provider_params, _, _) => provider_params,
    };

    let mut options = MemberTurnOptions::new();
    if let Some(catalog_model) = catalog_model {
        let auth_binding = if catalog_model.provider == Provider::SelfHosted {
            TurnMetadataOverride::Clear
        } else {
            let target = meerkat_core::resolve_auth_binding_or_default_for_provider(
                config, catalog_model.provider, None, realm, true,
            ).map_err(|error| GatewayError::policy(
                "Could not resolve the selected model account",
                Some(json!({"error": error.to_string()})),
            ))?;
            if target.auth_binding.is_env_default() {
                // Synthetic environment fallback is not a durable identity.
                TurnMetadataOverride::Clear
            } else {
                // Keep the account selected by native default resolution in
                // the reconfigured identity. Clearing it can release the
                // existing OAuth lease after a new client uses that same account.
                TurnMetadataOverride::Set(target.auth_binding)
            }
        };
        options = options
            .with_model(ModelId::new(catalog_model.id))
            .with_provider(catalog_model.provider)
            .with_auth_binding(auth_binding);
        if let Some(server_id) = catalog_model.server_id {
            options = options.with_self_hosted_server_id(server_id);
        }
    }
    if let Some(provider_params) = provider_params {
        options = options.with_provider_params(provider_params);
    }
    Ok(options)
}

fn typed_provider_params(
    catalog_model: &EffectiveCatalogModel,
    value: &Value,
) -> Result<ProviderParamsOverride, GatewayError> {
    let validator = jsonschema::draft202012::options()
        .build(&catalog_model.params_schema)
        .map_err(|error| {
            GatewayError::policy(
                "Meerkat published an invalid model parameter schema",
                Some(json!({
                    "model": catalog_model.id,
                    "provider": catalog_model.provider.as_str(),
                    "error": error.to_string(),
                })),
            )
        })?;
    if !validator.is_valid(value) {
        let errors = validator
            .iter_errors(value)
            .take(8)
            .map(|error| error.to_string())
            .collect::<Vec<_>>();
        return Err(GatewayError::invalid(
            "providerParams do not match the selected model",
            Some(json!({
                "model": catalog_model.id,
                "provider": catalog_model.provider.as_str(),
                "errors": errors,
            })),
        ));
    }

    let provider_tag = match catalog_model.provider {
        Provider::Anthropic => {
            let normalized = normalize_anthropic_provider_params(value.clone());
            let tag =
                serde_json::from_value::<AnthropicProviderTag>(normalized).map_err(|error| {
                    GatewayError::invalid(
                        "providerParams are not a valid typed Anthropic override",
                        Some(json!({"error": error.to_string()})),
                    )
                })?;
            ProviderTag::Anthropic(tag)
        }
        Provider::OpenAI => {
            let tag =
                serde_json::from_value::<OpenAiProviderTag>(value.clone()).map_err(|error| {
                    GatewayError::invalid(
                        "providerParams are not a valid typed OpenAI override",
                        Some(json!({"error": error.to_string()})),
                    )
                })?;
            ProviderTag::OpenAi(tag)
        }
        Provider::Gemini => {
            let tag =
                serde_json::from_value::<GeminiProviderTag>(value.clone()).map_err(|error| {
                    GatewayError::invalid(
                        "providerParams are not a valid typed Gemini override",
                        Some(json!({"error": error.to_string()})),
                    )
                })?;
            ProviderTag::Gemini(tag)
        }
        Provider::SelfHosted | Provider::Other => {
            return Err(GatewayError::invalid(
                "providerParams are not supported for this provider",
                Some(json!({"provider": catalog_model.provider.as_str()})),
            ));
        }
    };

    Ok(ProviderParamsOverride {
        provider_tag: Some(provider_tag),
        ..Default::default()
    })
}

/// Normalize the two legacy UI spellings that Meerkat's published Anthropic
/// schema intentionally continues to accept into the current typed carrier.
fn normalize_anthropic_provider_params(mut value: Value) -> Value {
    let Some(object) = value.as_object_mut() else {
        return value;
    };
    if let Some(thinking_budget) = object.remove("thinking_budget") {
        object.insert("thinking_budget_tokens".to_string(), thinking_budget);
    }
    if let Some(Value::String(effort)) = object.get_mut("effort") {
        if effort == "xhigh" {
            *effort = "x_high".to_string();
        }
    }
    if let Some(Value::String(inference_geo)) = object.get_mut("inference_geo") {
        let normalized = match inference_geo.as_str() {
            "us" => json!({"kind": "us"}),
            "global" => json!({"kind": "global"}),
            other => json!({"kind": "other", "region": other}),
        };
        object.insert("inference_geo".to_string(), normalized);
    }
    if let Some(compaction) = object.get_mut("compaction") {
        let normalized = match compaction {
            Value::String(mode) if mode == "auto" => Some(json!({"kind": "auto"})),
            Value::Object(_) => Some(json!({
                "kind": "custom",
                "edit": compaction.to_string(),
            })),
            _ => None,
        };
        if let Some(normalized) = normalized {
            object.insert("compaction".to_string(), normalized);
        }
    }
    value
}

fn session_history_contains_restored_tail(
    messages: &[Value],
    restored_transcript: &[RestoredTranscriptEntry],
) -> bool {
    let Some(last_user) = restored_transcript
        .iter()
        .rev()
        .find(|entry| entry.role == "user")
        .map(|entry| normalize_prompt_for_match(&entry.content))
    else {
        return false;
    };
    let Some(last_assistant) = restored_transcript
        .iter()
        .rev()
        .find(|entry| entry.role == "assistant")
        .map(|entry| normalize_prompt_for_match(&entry.content))
    else {
        return false;
    };
    let haystack = messages
        .iter()
        .map(message_text_for_matching)
        .map(|text| normalize_prompt_for_match(&text))
        .collect::<Vec<_>>()
        .join("\n");
    haystack.contains(&last_user) && haystack.contains(&last_assistant)
}

fn restored_transcript_from_params(
    params: &serde_json::Map<String, Value>,
) -> Vec<RestoredTranscriptEntry> {
    params
        .get("restoredTranscript")
        .or_else(|| params.get("restored_transcript"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let role = entry
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            if role != "user" && role != "assistant" {
                return None;
            }
            let content = entry
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if content.is_empty() {
                return None;
            }
            Some(RestoredTranscriptEntry {
                role,
                kind: entry
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("message")
                    .to_string(),
                content,
                created_at: entry
                    .get("createdAt")
                    .or_else(|| entry.get("created_at"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .take(80)
        .collect()
}

fn render_restored_transcript_seed(
    restored_transcript: &[RestoredTranscriptEntry],
) -> Option<String> {
    let mut output = String::from(
        "Authoritative restored Meerkat app thread transcript. Treat these prior user/assistant exchanges as conversation history for this thread after app restart or mob recreation. Use them for recall; do not say you cannot see prior messages if the answer is present here.\n",
    );
    let mut wrote = false;
    for entry in restored_transcript {
        let label = if entry.role == "user" {
            "User"
        } else {
            "Assistant"
        };
        let mut content = entry.content.trim().to_string();
        if content.len() > 4_000 {
            content.truncate(4_000);
            content.push_str("\n[truncated]");
        }
        let detail = match (entry.kind.as_str(), entry.created_at.as_deref()) {
            ("message", Some(created_at)) => format!(" ({created_at})"),
            ("message", None) => String::new(),
            (kind, Some(created_at)) => format!(" [{kind}, {created_at}]"),
            (kind, None) => format!(" [{kind}]"),
        };
        output.push_str(&format!("\n{label}{detail}: {content}\n"));
        wrote = true;
        if output.len() > 28_000 {
            output.push_str("\n[Older restored transcript omitted due to context budget.]\n");
            break;
        }
    }
    wrote.then_some(output)
}

fn process_agent_event_envelope(
    envelope: &EventEnvelope<AgentEvent>,
    thread_id: &str,
    run_id: &str,
    state: &mut LiveEventAssembler,
    events_tx: &broadcast::Sender<EventEmit>,
    emitted_live_events: &mut bool,
) -> Result<bool, RunFailure> {
    let created_at = Utc
        .timestamp_millis_opt(envelope.timestamp_ms as i64)
        .single()
        .unwrap_or_else(Utc::now);
    let mut events = Vec::new();
    match &envelope.payload {
        AgentEvent::SkillsResolved { .. } | AgentEvent::SkillResolutionFailed { .. } => {
            native_skill_events::emit(
                envelope,
                thread_id,
                run_id,
                state.delivery_scope.as_ref(),
                events_tx,
            )
            .map_err(|error| RunFailure::Delivery(error.to_string()))?;
            *emitted_live_events = true;
        }
        AgentEvent::TextDelta { delta, .. } => {
            if !delta.is_empty() {
                state.assistant_delta_emitted = true;
                state.assistant_delta_text.push_str(delta);
                events.push(DesktopLiveRunEvent::AssistantDelta {
                    thread_id: thread_id.to_string(),
                    run_id: run_id.to_string(),
                    created_at,
                    text_delta: delta.clone(),
                });
            }
        }
        AgentEvent::ReasoningDelta { delta, .. } => {
            if !delta.is_empty() {
                events.push(DesktopLiveRunEvent::ThinkingDelta {
                    thread_id: thread_id.to_string(),
                    run_id: run_id.to_string(),
                    created_at,
                    text_delta: delta.clone(),
                });
            }
        }
        AgentEvent::ReasoningComplete { content, .. } => {
            let text = normalize_summary_text(content);
            if !text.is_empty() {
                events.push(DesktopLiveRunEvent::ThinkingSummary {
                    thread_id: thread_id.to_string(),
                    run_id: run_id.to_string(),
                    created_at,
                    text,
                });
            }
        }
        AgentEvent::ToolCallRequested { id, name, args } => {
            // A completed model turn can contain planning text before it asks
            // for a tool. The next model turn owns a fresh final-text
            // candidate; never let the contentless run terminal concatenate
            // the pre-tool and post-tool delta buffers.
            state.assistant_delta_text.clear();
            events.extend(session_tool_call_to_live_events(
                &json!({ "id": id, "name": name, "args": args }),
                thread_id,
                run_id,
                created_at,
                state,
            ));
        }
        AgentEvent::ToolExecutionStarted { id, name } => {
            state.assistant_delta_text.clear();
            events.extend(session_tool_call_to_live_events(
                &json!({ "id": id, "name": name }),
                thread_id,
                run_id,
                created_at,
                state,
            ));
        }
        AgentEvent::ToolResultReceived {
            id,
            name,
            content,
            is_error,
        } => {
            state.assistant_delta_text.clear();
            events.extend(normalize_tool_execution_completed(
                thread_id,
                run_id,
                created_at,
                &json!({ "id": id, "name": name, "content": content, "is_error": is_error }),
                state,
            ));
        }
        AgentEvent::ToolExecutionCompleted {
            id,
            name,
            content,
            is_error,
            ..
        } => {
            state.assistant_delta_text.clear();
            events.extend(normalize_tool_execution_completed(
                thread_id,
                run_id,
                created_at,
                &json!({
                    "id": id,
                    "name": name,
                    "content": content,
                    "is_error": is_error,
                }),
                state,
            ));
        }
        AgentEvent::TextComplete { content, .. } => {
            // TextComplete is a per-model-turn boundary, not a run terminal.
            // It is emitted before tool calls are dispatched and may occur
            // several times during one agentic run. Finalizing the desktop
            // overlay here freezes pre-tool text and suppresses the true final.
            // Retain only this turn's completed candidate so a later
            // contentless run terminal can authorize it. A following tool
            // boundary clears it before the next model turn begins.
            if !content.is_empty() {
                state.assistant_delta_text.clear();
                state.assistant_delta_text.push_str(content);
            }
        }
        AgentEvent::RunCompleted {
            result: content, ..
        }
        | AgentEvent::InteractionComplete {
            result: content, ..
        } => {
            // The terminal result is authoritative even when text deltas were
            // already emitted. Emitting it before `run.completed` lets the
            // desktop replace the live tail in place; otherwise the client
            // persists whatever partial delta happened to arrive last and a
            // later console-history final appears as a second response.
            let authoritative_text = if content.is_empty() {
                state.assistant_delta_text.as_str()
            } else {
                content.as_str()
            };
            if !state.assistant_final_emitted && !authoritative_text.is_empty() {
                state.assistant_final_emitted = true;
                events.push(DesktopLiveRunEvent::AssistantFinal {
                    thread_id: thread_id.to_string(),
                    run_id: run_id.to_string(),
                    created_at,
                    text: authoritative_text.to_string(),
                });
            }
        }
        AgentEvent::RunFailed { error_report, .. } => {
            return Err(RunFailure::from_report(error_report));
        }
        AgentEvent::InteractionFailed { reason, .. } => {
            return Err(RunFailure::from_interaction(reason));
        }
        _ => {}
    }
    for event in events {
        *emitted_live_events = true;
        let native_source = if matches!(event, DesktopLiveRunEvent::AssistantFinal { .. }) {
            let session = match &envelope.payload {
                AgentEvent::RunCompleted {session_id,..} => Some(session_id.to_string()),
                _ => envelope.source.session_id().map(ToString::to_string).or_else(||state.native_session_id.clone()),
            };
            session.map(|session|(format!("evt-agent-{}",envelope.event_id),session))
        } else { None };
        let is_final = matches!(event, DesktopLiveRunEvent::AssistantFinal { .. });
        if let Err(error) = emit_live_event_with_native(events_tx, event, native_source, state.native_segment_id.as_deref(), state.delivery_scope.as_ref(), state.followup_scope.as_ref()) {
            if is_final { state.assistant_final_emitted = false; }
            return Err(RunFailure::Delivery(error.to_string()));
        }
    }
    let terminal = matches!(
        envelope.payload,
        AgentEvent::RunCompleted { .. } | AgentEvent::InteractionComplete { .. }
    );
    Ok(terminal)
}

async fn read_session_is_active(
    runtime: &meerkat_mobkit::UnifiedRuntime,
    session_id: &str,
) -> Result<bool, String> {
    let session_id =
        SessionId::parse(session_id).map_err(|error| format!("invalid session_id: {error}"))?;
    let service = runtime
        .mob_runtime()
        .session_service()
        .ok_or_else(|| "MobKit session state is unavailable for this runtime".to_string())?;
    service
        .read(&session_id)
        .await
        .map(|view| view.state.is_active)
        .map_err(|error| error.to_string())
}

async fn read_session_history_messages(
    runtime: &meerkat_mobkit::UnifiedRuntime,
    session_id: &str,
) -> Result<Vec<Value>, String> {
    let session_id =
        SessionId::parse(session_id).map_err(|error| format!("invalid session_id: {error}"))?;
    let service = runtime
        .mob_runtime()
        .session_service()
        .ok_or_else(|| "MobKit session history is unavailable for this runtime".to_string())?;
    let session_info = service
        .read(&session_id)
        .await
        .map_err(|error| error.to_string())?;
    let offset = session_info.state.message_count.saturating_sub(512);
    let history = SessionServiceHistoryExt::read_history(
        service.as_ref(),
        &session_id,
        SessionHistoryQuery {
            offset,
            limit: Some(512),
        },
    )
    .await
    .map_err(|error| error.to_string())?;
    history
        .messages
        .into_iter()
        .map(|message| serde_json::to_value(message).map_err(|error| error.to_string()))
        .collect()
}

struct PromptHistoryWindow {
    messages: Vec<Value>,
    /// A later user message proves this turn's persisted history is closed,
    /// even when that successor turn keeps the shared session active.
    bounded_by_next_user: bool,
}

fn history_window_after_latest_user_prompt(
    messages: &[Value],
    prompt: &str,
) -> PromptHistoryWindow {
    let prompt_normalized = normalize_prompt_for_match(prompt);
    let Some(prompt_index) = messages.iter().rposition(|message| {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if role != "user" {
            return false;
        }
        let text = message_text_for_matching(message);
        !text.is_empty() && normalize_prompt_for_match(&text) == prompt_normalized
    }) else {
        return PromptHistoryWindow {
            messages: Vec::new(),
            bounded_by_next_user: false,
        };
    };
    let messages_after_prompt = &messages[prompt_index + 1..];
    let next_user_offset = messages_after_prompt.iter().position(|message| {
        message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .eq_ignore_ascii_case("user")
    });
    let window_end = next_user_offset.unwrap_or(messages_after_prompt.len());
    PromptHistoryWindow {
        messages: messages_after_prompt[..window_end].to_vec(),
        bounded_by_next_user: next_user_offset.is_some(),
    }
}

fn terminal_assistant_index_for_history_recovery(
    history_window: &PromptHistoryWindow,
    session_is_active: bool,
) -> Option<usize> {
    // An active, unbounded window may contain a provider's pre-tool text turn;
    // it is not terminal evidence. A subsequent user message is a durable turn
    // boundary, however, so a successor run may keep the shared session active
    // without blocking recovery of this already-completed turn.
    if session_is_active && !history_window.bounded_by_next_user {
        return None;
    }
    history_window
        .messages
        .iter()
        .rposition(assistant_message_is_terminal_candidate)
}

fn assistant_message_is_terminal_candidate(message: &Value) -> bool {
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !role.eq_ignore_ascii_case("assistant") && !role.eq_ignore_ascii_case("block_assistant") {
        return false;
    }
    let has_direct_tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .is_some_and(|calls| !calls.is_empty());
    let has_tool_blocks = message
        .get("blocks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|block| {
            block
                .get("type")
                .or_else(|| block.get("block_type"))
                .or_else(|| block.get("kind"))
                .and_then(Value::as_str)
                .is_some_and(|kind| kind.to_ascii_lowercase().contains("tool"))
        });
    !has_direct_tool_calls && !has_tool_blocks && assistant_message_text(message).is_some()
}

fn assistant_message_text(message: &Value) -> Option<String> {
    if let Some(text) = message
        .get("content")
        .and_then(|content| extract_text_like(content, &["content", "text"]))
    {
        return Some(text);
    }
    let text = message
        .get("blocks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|block| {
            let block_type = block
                .get("type")
                .or_else(|| block.get("block_type"))
                .or_else(|| block.get("kind"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !block_type.eq_ignore_ascii_case("text") {
                return None;
            }
            extract_text_like(block.get("data").unwrap_or(block), &["text", "content"])
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    normalize_extracted_text(&text)
}

fn message_text_for_matching(message: &Value) -> String {
    message
        .get("content")
        .and_then(|content| extract_text_like(content, &["content", "text"]))
        .or_else(|| extract_text_like(message, &["content", "text"]))
        .unwrap_or_default()
}

fn normalize_prompt_for_match(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Append a durable terminal-run record to `<state_root>/runs.jsonl`. This is the
/// one piece of run lifecycle that is otherwise broadcast-only/in-memory: after a
/// restart the transcript survives in mob.sqlite but "did run X finish, and how"
/// does not. Recording it lets the client reconcile a run that was in flight at
/// restart to its true outcome instead of guessing. A failed write is returned
/// to the delivery boundary instead of being reported as successful cleanup.
fn record_terminal_run(
    state_root: &std::path::Path,
    run_id: &str,
    thread_id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), GatewayError> {
    use std::io::Write;
    let record = json!({
        "runId": run_id,
        "threadId": thread_id,
        "status": status,
        "error": error,
        "endedAt": Utc::now().to_rfc3339(),
    });
    let path = state_root.join("runs.jsonl");
    let write = (|| -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        writeln!(file, "{record}")?;
        file.sync_all()
    })();
    write.map_err(|error| GatewayError::policy("Native terminal receipt could not be saved", Some(json!({"error":error.to_string()}))))
}

/// Look up a run's durable terminal status (written by `record_terminal_run`).
/// Scans `<state_root>/runs.jsonl` for the newest record matching `run_id`.
fn lookup_terminal_run(state_root: &std::path::Path, run_id: &str) -> Option<Value> {
    let path = state_root.join("runs.jsonl");
    let contents = std::fs::read_to_string(&path).ok()?;
    let mut found: Option<Value> = None;
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(record) = serde_json::from_str::<Value>(line) {
            if record.get("runId").and_then(Value::as_str) == Some(run_id) {
                found = Some(record);
            }
        }
    }
    found
}

async fn finish_run(
    events_tx: &broadcast::Sender<EventEmit>,
    handle: &Arc<ProjectRuntimeHandle>,
    thread_id: &str,
    run_id: &str,
    mob_id: &str,
    agent_identity: &str,
    project_path: &str,
    execution_path: &str,
    execution_mode: &str,
    host_tools: &HostToolTransport,
    result: Result<(), RunFailure>,
) {
    let (attribution, followup, result) = {
        let mut state = handle.state.lock().await;
        let Some(active) = state
            .active_runs
            .get_mut(thread_id)
            .filter(|active| active.run_id == run_id)
        else {
            // Another terminal path already cleared this run, or the entry
            // belongs to a successor. Never emit a second terminal event.
            return;
        };
        if active.deliveries.finalizing { return; }
        if let Err(error) = result {
            // Any execution failure wins over cancellation; otherwise a
            // typed cancellation wins over successful deliveries.
            if active.deliveries.failure.is_none()
                || matches!(error, RunFailure::Failed(_))
                || (matches!(error, RunFailure::Cancelled)
                    && matches!(active.deliveries.failure, Some(RunFailure::Delivery(_))))
            {
                active.deliveries.failure = Some(error);
            }
        }
        active.deliveries.pending -= 1;
        if active.deliveries.pending != 0 {
            return;
        }
        active.deliveries.finalizing = true;
        let result = active.deliveries.failure.take().map_or(Ok(()), Err);
        let projection = active.projection.lock().await;
        let attribution = projection.delivery_scope.clone();
        let followup = projection.followup.clone();
        drop(projection);
        (attribution, followup, result)
    };
    host_tools.cancel_run(run_id).await;
    let (kind, status, message) = match &result {
        Ok(()) => ("run.completed", "completed", None),
        Err(RunFailure::Failed(error)) => ("run.failed", "failed", Some(error.clone())),
        Err(RunFailure::Delivery(_)) => ("run.completed", "completed", None),
        Err(RunFailure::Cancelled) => ("run.cancelled", "cancelled", Some("Run cancelled.".to_string())),
    };
    let mut payload = json!({
        "projectPath":project_path,"executionPath":execution_path,"executionMode":execution_mode,
        "backingKind":"mob","mobId":mob_id,"agentIdentity":agent_identity,
    });
    if let Some(message) = &message { payload["message"] = json!(message); }
    let event = EventEmit {
        event_id:format!("meerkat-terminal:{run_id}"), kind:kind.into(),timestamp:Utc::now(),
        thread_id:Some(thread_id.into()),run_id:Some(run_id.into()),payload,trace_id:run_id.into(),
    };
    {
        let mut state = handle.state.lock().await;
        if let Some(active) = state.active_runs.get_mut(thread_id).filter(|run| run.run_id == run_id) {
            active.deliveries.pending_finalization = Some(RunFinalization { event, status, message, attribution, followup });
        }
    }
    retry_run_finalizations(events_tx, handle).await;
    handle.runs_settled.notify_waiters();
}

/// Retain the original event identity and timestamp across write failures.
/// Execution is never replayed when the client retries status or delivery.
async fn retry_run_finalizations(events_tx: &broadcast::Sender<EventEmit>, handle: &Arc<ProjectRuntimeHandle>) {
    let mut state = handle.state.lock().await;
    let state_root = state.locator.state_root.clone();
    let mut completed = Vec::new();
    for (thread_id, active) in &mut state.active_runs {
        let Some(finalization) = &active.deliveries.pending_finalization else { continue; };
        let pending_events = active.projection.lock().await.pending_events.clone();
        let mut delivery_error = None;
        for event in pending_events {
            if let Err(error) = project_run_event(&active.projection, &event, thread_id, &active.run_id, events_tx).await {
                delivery_error = Some(error.to_string());
                break;
            }
        }
        // Save the result before releasing either admission or attribution.
        let persisted = (|| -> Result<(), GatewayError> {
            if let Some(error) = delivery_error {
                return Err(GatewayError::policy(error, None));
            }
            if let Some(attribution) = &finalization.attribution {
                thread_deliveries::persist(attribution, &finalization.event)?;
            }
            if let Some(followup) = &finalization.followup {
                thread_followups::finish(followup)?;
            }
            record_terminal_run(&state_root, &active.run_id, thread_id, finalization.status, finalization.message.as_deref())?;
            thread_recovery::terminal(&state_root, &active.run_id, finalization.status)?;
            Ok(())
        })();
        match persisted {
            Ok(()) => {
                completed.push(thread_id.clone());
                let _ = events_tx.send(finalization.event.clone());
            }
            Err(error) => {
                let message = format!("Execution ended, but saving its final result failed: {error}. Refresh to retry delivery.");
                if active.deliveries.finalization_error.as_ref() != Some(&message) {
                    emit_named_event(events_tx, "run.failed", thread_id, Some(&active.run_id), json!({
                        "message": message,"deliveryStatus":"needs_recovery","mobId":active.mob_id,"agentIdentity":active.agent_identity,
                    }));
                }
                active.deliveries.finalization_error = Some(message);
            }
        }
    }
    let changed = !completed.is_empty();
    for thread in completed { state.active_runs.remove(&thread); }
    drop(state);
    if changed { handle.runs_settled.notify_waiters(); }
}

fn session_tool_call_to_live_events(
    tool_call: &Value,
    thread_id: &str,
    run_id: &str,
    created_at: chrono::DateTime<Utc>,
    state: &mut LiveEventAssembler,
) -> Vec<DesktopLiveRunEvent> {
    let tool_id = tool_call
        .get("id")
        .or_else(|| tool_call.get("tool_call_id"))
        .or_else(|| tool_call.get("tool_use_id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let tool_name = tool_call
        .get("name")
        .or_else(|| tool_call.get("tool_name"))
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string();
    let args = tool_call
        .get("args")
        .or_else(|| tool_call.get("arguments"))
        .or_else(|| tool_call.get("input"));
    let command = args
        .and_then(|value| value.get("command"))
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(id) = tool_id.as_ref() {
        if !state.started_tool_ids.insert(id.clone()) {
            return Vec::new();
        }
        state.pending_tools.insert(
            id.clone(),
            PendingToolCall {
                name: tool_name.clone(),
                command: command.clone(),
            },
        );
    }
    if tool_name == "shell" {
        command
            .map(|command| {
                vec![DesktopLiveRunEvent::ToolCommandStarted {
                    thread_id: thread_id.to_string(),
                    run_id: run_id.to_string(),
                    created_at,
                    title: "Shell".to_string(),
                    caption: Some("Ran command".to_string()),
                    command,
                    tool_id,
                }]
            })
            .unwrap_or_default()
    } else {
        vec![DesktopLiveRunEvent::ToolSearchFinished {
            thread_id: thread_id.to_string(),
            run_id: run_id.to_string(),
            created_at,
            text: format_tool_event_text("Tool started", &tool_name, args),
            tool_id,
            tool_name: Some(tool_name),
            tool_phase: Some("started".to_string()),
            tool_arguments: args.cloned(),
            tool_result: None,
            is_error: None,
        }]
    }
}

fn normalize_tool_execution_completed(
    thread_id: &str,
    run_id: &str,
    created_at: chrono::DateTime<Utc>,
    event: &Value,
    state: &mut LiveEventAssembler,
) -> Vec<DesktopLiveRunEvent> {
    let tool_id = event
        .get("id")
        .or_else(|| event.get("tool_call_id"))
        .or_else(|| event.get("tool_use_id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let tool_name = event
        .get("name")
        .or_else(|| event.get("tool_name"))
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string();
    if let Some(id) = tool_id.as_ref() {
        if !state.finished_tool_ids.insert(id.clone()) {
            return Vec::new();
        }
    }
    let pending = tool_id
        .as_ref()
        .and_then(|id| state.pending_tools.remove(id))
        .unwrap_or_else(|| PendingToolCall {
            name: tool_name.clone(),
            command: None,
        });
    let is_error = event.get("is_error").and_then(Value::as_bool);
    if pending.name == "shell" || tool_name == "shell" {
        let command = pending.command.unwrap_or_else(|| "$ command".to_string());
        let result_value = event
            .get("result")
            .or_else(|| event.get("output"))
            .or_else(|| event.get("content"));
        let shell_result = result_value.and_then(shell_command_result);
        let exit_code = shell_result.as_ref().and_then(|result| result.exit_code);
        let timed_out = shell_result.as_ref().map(|result| result.timed_out);
        let failed = is_error == Some(true)
            || timed_out == Some(true)
            || exit_code.is_some_and(|code| code != 0);
        let status = if failed {
            Some("Error".to_string())
        } else if exit_code == Some(0) {
            Some("Success".to_string())
        } else {
            None
        };
        let output = shell_result
            .as_ref()
            .map(|result| format!("{}{}", result.stdout, result.stderr))
            .or_else(|| result_value.and_then(tool_result_text));
        return vec![DesktopLiveRunEvent::ToolCommandFinished {
            thread_id: thread_id.to_string(),
            run_id: run_id.to_string(),
            created_at,
            title: "Shell".to_string(),
            caption: Some("Ran command".to_string()),
            command,
            output,
            status,
            tool_id,
            is_error,
            exit_code,
            timed_out,
            tool_result: result_value.cloned(),
        }];
    }
    let result_value = event
        .get("result")
        .or_else(|| event.get("output"))
        .or_else(|| event.get("content"))
        .cloned();
    vec![DesktopLiveRunEvent::ToolSearchFinished {
        thread_id: thread_id.to_string(),
        run_id: run_id.to_string(),
        created_at,
        text: format!(
            "{}\n{}",
            format_tool_event_text(
                if is_error == Some(true) {
                    "Tool failed"
                } else {
                    "Tool finished"
                },
                &pending.name,
                None,
            ),
            result_value
                .as_ref()
                .and_then(tool_result_text)
                .unwrap_or_else(|| "completed".to_string())
        ),
        tool_id,
        tool_name: Some(pending.name),
        tool_phase: Some("finished".to_string()),
        tool_arguments: None,
        tool_result: result_value,
        is_error,
    }]
}

fn emit_named_event(
    events_tx: &broadcast::Sender<EventEmit>,
    kind: &str,
    thread_id: &str,
    run_id: Option<&str>,
    mut payload: Value,
) {
    media::reference_inline_images(&mut payload);
    let _ = events_tx.send(EventEmit {
        event_id: Uuid::new_v4().to_string(),
        kind: kind.to_string(),
        timestamp: Utc::now(),
        thread_id: Some(thread_id.to_string()),
        run_id: run_id.map(str::to_string),
        payload,
        trace_id: Uuid::new_v4().to_string(),
    });
}

fn emit_live_event_with_native(events_tx: &broadcast::Sender<EventEmit>, event: DesktopLiveRunEvent, native_source: Option<(String,String)>, segment: Option<&str>, scope: Option<&thread_followups::Attribution>, followup: Option<&thread_followups::Attribution>) -> Result<(), GatewayError> {
    let kind = live_event_kind(&event).to_string();
    let timestamp = live_event_timestamp(&event);
    let thread_id = Some(live_event_thread_id(&event).to_string());
    let run_id = Some(live_event_run_id(&event).to_string());
    let mut payload = live_event_payload(&event);
    let source_id = native_source.as_ref().map(|(source,_)| source.clone());
    let event_id = native_source.as_ref().map(|(source,session)|format!("meerkat-output:{}:{session}:{source}",run_id.as_deref().unwrap_or_default())).unwrap_or_else(||Uuid::new_v4().to_string());
    if let Some((source,session)) = native_source {
        payload["nativeSourceEventId"] = json!(source);
        payload["nativeSessionId"] = json!(session);
    }
    if let Some(segment) = segment { payload["nativeSegmentId"] = json!(segment); }
    media::reference_inline_images(&mut payload);
    let delivery = EventEmit {
        event_id: event_id.clone(),
        kind,
        timestamp,
        thread_id,
        run_id,
        payload,
        trace_id: event_id,
    };
    if delivery.kind == "run.output.complete" {
        if let Some(scope) = scope {
            thread_deliveries::persist(scope, &delivery)?;
        }
        if let (Some(followup), Some(source_id)) = (followup, source_id) {
            thread_followups::record(followup, &source_id)?;
        }
    }
    let _ = events_tx.send(delivery);
    Ok(())
}

fn live_event_payload(event: &DesktopLiveRunEvent) -> Value {
    match event {
        DesktopLiveRunEvent::ThinkingDelta { text_delta, .. } => json!({ "textDelta": text_delta }),
        DesktopLiveRunEvent::ThinkingSummary { text, .. } => json!({ "text": text }),
        DesktopLiveRunEvent::ToolCommandStarted {
            title,
            caption,
            command,
            tool_id,
            ..
        } => json!({
            "title": title,
            "caption": caption,
            "command": command,
            "toolId": tool_id,
        }),
        DesktopLiveRunEvent::ToolCommandFinished {
            title,
            caption,
            command,
            output,
            status,
            tool_id,
            is_error,
            exit_code,
            timed_out,
            tool_result,
            ..
        } => json!({
            "title": title,
            "caption": caption,
            "command": command,
            "output": output,
            "status": status,
            "toolId": tool_id,
            "isError": is_error,
            "exitCode": exit_code,
            "timedOut": timed_out,
            "toolResult": tool_result,
        }),
        DesktopLiveRunEvent::ToolSearchFinished {
            text,
            tool_id,
            tool_name,
            tool_phase,
            tool_arguments,
            tool_result,
            is_error,
            ..
        } => {
            let mut payload = json!({ "text": text });
            if let Some(tool_id) = tool_id {
                payload["toolId"] = json!(tool_id);
            }
            if let Some(tool_name) = tool_name {
                payload["toolName"] = json!(tool_name);
            }
            if let Some(tool_phase) = tool_phase {
                payload["toolPhase"] = json!(tool_phase);
            }
            if let Some(tool_arguments) = tool_arguments {
                payload["toolArguments"] = tool_arguments.clone();
            }
            if let Some(tool_result) = tool_result {
                payload["toolResult"] = tool_result.clone();
            }
            if let Some(is_error) = is_error {
                payload["isError"] = json!(is_error);
            }
            payload
        }
        DesktopLiveRunEvent::AssistantDelta { text_delta, .. } => {
            json!({ "textDelta": text_delta })
        }
        DesktopLiveRunEvent::AssistantFinal { text, .. } => json!({ "text": text }),
    }
}

fn live_event_kind(event: &DesktopLiveRunEvent) -> &'static str {
    match event {
        DesktopLiveRunEvent::ThinkingDelta { .. } => "thinking.delta",
        DesktopLiveRunEvent::ThinkingSummary { .. } => "thinking.summary",
        DesktopLiveRunEvent::ToolCommandStarted { .. } => "tool.command.started",
        DesktopLiveRunEvent::ToolCommandFinished { .. } => "tool.command.finished",
        DesktopLiveRunEvent::ToolSearchFinished { .. } => "tool.search.finished",
        DesktopLiveRunEvent::AssistantDelta { .. } => "run.output.delta",
        DesktopLiveRunEvent::AssistantFinal { .. } => "run.output.complete",
    }
}

fn live_event_timestamp(event: &DesktopLiveRunEvent) -> chrono::DateTime<Utc> {
    match event {
        DesktopLiveRunEvent::ThinkingDelta { created_at, .. }
        | DesktopLiveRunEvent::ThinkingSummary { created_at, .. }
        | DesktopLiveRunEvent::ToolCommandStarted { created_at, .. }
        | DesktopLiveRunEvent::ToolCommandFinished { created_at, .. }
        | DesktopLiveRunEvent::ToolSearchFinished { created_at, .. }
        | DesktopLiveRunEvent::AssistantDelta { created_at, .. }
        | DesktopLiveRunEvent::AssistantFinal { created_at, .. } => *created_at,
    }
}

fn live_event_thread_id(event: &DesktopLiveRunEvent) -> &str {
    match event {
        DesktopLiveRunEvent::ThinkingDelta { thread_id, .. }
        | DesktopLiveRunEvent::ThinkingSummary { thread_id, .. }
        | DesktopLiveRunEvent::ToolCommandStarted { thread_id, .. }
        | DesktopLiveRunEvent::ToolCommandFinished { thread_id, .. }
        | DesktopLiveRunEvent::ToolSearchFinished { thread_id, .. }
        | DesktopLiveRunEvent::AssistantDelta { thread_id, .. }
        | DesktopLiveRunEvent::AssistantFinal { thread_id, .. } => thread_id,
    }
}

fn live_event_run_id(event: &DesktopLiveRunEvent) -> &str {
    match event {
        DesktopLiveRunEvent::ThinkingDelta { run_id, .. }
        | DesktopLiveRunEvent::ThinkingSummary { run_id, .. }
        | DesktopLiveRunEvent::ToolCommandStarted { run_id, .. }
        | DesktopLiveRunEvent::ToolCommandFinished { run_id, .. }
        | DesktopLiveRunEvent::ToolSearchFinished { run_id, .. }
        | DesktopLiveRunEvent::AssistantDelta { run_id, .. }
        | DesktopLiveRunEvent::AssistantFinal { run_id, .. } => run_id,
    }
}

fn derive_project_locator(
    project_path: &str,
    state_root_override: Option<&str>,
) -> Result<ProjectLocator, GatewayError> {
    let project_path = normalize_project_path(project_path)?;
    let requested_state_root = match state_root_override {
        Some(value) if !value.trim().is_empty() => normalize_state_root_path(value)?,
        _ => project_path.join(".rkat"),
    };
    std::fs::create_dir_all(&requested_state_root).map_err(|error| {
        GatewayError::policy(
            "Failed to create project state root",
            Some(json!({"error": error.to_string(), "stateRoot": requested_state_root})),
        )
    })?;
    // Canonicalize only after creation. On macOS `/tmp` is a symlink to
    // `/private/tmp`; canonicalizing a not-yet-created child used to fail and
    // fall back to the lexical `/tmp/...` path. The next request, after the
    // directory existed, resolved `/private/tmp/...` and silently selected a
    // second runtime registry for the same durable mob state.
    let state_root = requested_state_root.canonicalize().map_err(|error| {
        GatewayError::policy(
            "Failed to resolve project state root",
            Some(json!({
                "error": error.to_string(),
                "stateRoot": requested_state_root,
            })),
        )
    })?;
    let realm_id = derive_workspace_realm_id(&project_path);
    Ok(ProjectLocator {
        project_path: project_path.clone(),
        state_root,
        context_root: project_path,
        realm_id,
    })
}

fn normalize_project_path(project_path: &str) -> Result<PathBuf, GatewayError> {
    let path = PathBuf::from(project_path);
    let absolute = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map_err(|error| {
                GatewayError::policy(
                    "Failed to resolve current directory",
                    Some(json!({"error": error.to_string()})),
                )
            })?
            .join(path)
    };
    let normalized = absolute
        .canonicalize()
        .unwrap_or_else(|_| clean_path(&absolute));
    if !normalized.exists() {
        return Err(GatewayError::invalid(
            "Project path does not exist",
            Some(json!({"projectPath": normalized})),
        ));
    }
    Ok(normalized)
}

fn normalize_state_root_path(state_root: &str) -> Result<PathBuf, GatewayError> {
    let path = PathBuf::from(state_root);
    let absolute = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map_err(|error| {
                GatewayError::policy(
                    "Failed to resolve current directory",
                    Some(json!({"error": error.to_string()})),
                )
            })?
            .join(path)
    };
    Ok(absolute
        .canonicalize()
        .unwrap_or_else(|_| clean_path(&absolute)))
}

fn clean_path(path: &Path) -> PathBuf {
    let mut cleaned = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                cleaned.pop();
            }
            other => cleaned.push(other.as_os_str()),
        }
    }
    cleaned
}

fn project_runtime_key(locator: &ProjectLocator, execution_path: &Path) -> String {
    format!(
        "{}::{}::{}",
        locator.project_path.to_string_lossy(),
        locator.state_root.to_string_lossy(),
        execution_path.to_string_lossy()
    )
}

fn project_runtime_instance_id(runtime_key: &str) -> String {
    format!("project-{:x}", Sha256::digest(runtime_key.as_bytes()))
}

const DESKTOP_TOPOLOGY_ACTOR: &str = "meerkat-app";

async fn apply_bilateral_topology(
    coordinator: &SameProcessTopologyCoordinator,
    source_runtime: &meerkat_mobkit::UnifiedRuntime,
    source_identity: &str,
    target_runtime: &meerkat_mobkit::UnifiedRuntime,
    target_identity: &str,
    action: TopologyAction,
    reason: &str,
    idempotency_key: String,
    expected_revisions: Option<BTreeMap<String, u64>>,
) -> Result<meerkat_mobkit::TopologyOperationReceipt, GatewayError> {
    let edge = TopologyEdge::new(
        TopologyEndpoint {
            authority: Some(source_runtime.mob_id()),
            identity: source_identity.to_string(),
        },
        TopologyEndpoint {
            authority: Some(target_runtime.mob_id()),
            identity: target_identity.to_string(),
        },
    )
    .map_err(|error| {
        GatewayError::invalid(
            "Invalid MobKit topology edge",
            Some(json!({"error": error.to_string()})),
        )
    })?;
    let expected_revisions = match expected_revisions {
        Some(expected_revisions) => expected_revisions,
        None => {
            coordinator
                .query(source_runtime, target_runtime, Some(DESKTOP_TOPOLOGY_ACTOR))
                .await
                .map_err(topology_gateway_error)?
                .authority_revisions
        }
    };
    coordinator
        .apply(
            source_runtime,
            target_runtime,
            TopologyBilateralApplyRequest {
                expected_revisions,
                idempotency_key,
                operations: vec![TopologyMutation { action, edge }],
                reason: Some(reason.to_string()),
                risk_tier: Some("r0".to_string()),
            },
            Some(DESKTOP_TOPOLOGY_ACTOR),
            DESKTOP_TOPOLOGY_ACTOR,
        )
        .await
        .map_err(|error| topology_gateway_error_with_action(error, action))
}

fn topology_gateway_error(error: TopologyControlError) -> GatewayError {
    let kind = error.kind();
    let details = Some(json!({
        "kind": kind,
        "error": error.to_string(),
        "receipt": error.receipt(),
    }));
    if matches!(error, TopologyControlError::RevisionConflict { .. }) {
        GatewayError::conflict("MobKit topology revision changed", details)
    } else {
        GatewayError::policy("MobKit topology operation was rejected", details)
    }
}

fn topology_gateway_error_with_action(
    error: TopologyControlError,
    action: TopologyAction,
) -> GatewayError {
    let kind = error.kind();
    let details = Some(json!({
        "kind": kind,
        "action": match action {
            TopologyAction::Connect => "connect",
            TopologyAction::Disconnect => "disconnect",
            TopologyAction::Reconnect => "reconnect",
        },
        "error": error.to_string(),
        "receipt": error.receipt(),
    }));
    if matches!(error, TopologyControlError::RevisionConflict { .. }) {
        GatewayError::conflict("MobKit topology revision changed", details)
    } else {
        GatewayError::policy("MobKit topology mutation was rejected", details)
    }
}

fn topology_pair_journal_path(source: &MobkitMobRuntime, target: &MobkitMobRuntime) -> PathBuf {
    let (first, second) = if source.mob_id <= target.mob_id {
        (source, target)
    } else {
        (target, source)
    };
    first
        .state_root
        .join("mobkit")
        .join("topology-pairs")
        .join(topology_pair_journal_filename(
            &first.mob_id,
            &second.mob_id,
        ))
}

fn topology_pair_journal_filename(first: &str, second: &str) -> String {
    let (first, second) = if first <= second {
        (first, second)
    } else {
        (second, first)
    };
    let legacy = format!(
        "{}--{}.json",
        path_hex_component(first),
        path_hex_component(second)
    );
    // Native persistence also creates .json.lock and .json.tmp siblings.
    // Retain every previously usable filename while reserving their suffixes
    // within the 255-byte filesystem component limit.
    if legacy.len() + ".lock".len() <= 255 {
        return legacy;
    }
    let mut digest = Sha256::new();
    digest.update(b"meerkat-desktop/topology-pair/v1\0");
    for identity in [first, second] {
        digest.update((identity.len() as u64).to_be_bytes());
        digest.update(identity.as_bytes());
    }
    format!("pair-v1-{:x}.json", digest.finalize())
}

fn path_hex_component(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(value.len() * 2);
    for byte in value.as_bytes() {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn stable_slug(value: &str) -> String {
    let slug = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        "mob".to_string()
    } else {
        slug
    }
}

fn required_nonempty_string(
    params: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<String, GatewayError> {
    required_string(params, key).and_then(|value| {
        if value.trim().is_empty() {
            Err(GatewayError::invalid(
                format!("{key} must not be empty"),
                None,
            ))
        } else {
            Ok(value)
        }
    })
}

fn include_native_workers_param(
    params: &serde_json::Map<String, Value>,
) -> Result<bool, GatewayError> {
    match params.get("includeNativeWorkers") {
        None => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(GatewayError::invalid(
            "includeNativeWorkers must be a boolean",
            None,
        )),
    }
}

fn console_expected_target(
    params: &serde_json::Map<String, Value>,
) -> Result<mobkit_registry::ConsoleExpectedTarget, GatewayError> {
    let expected = params
        .get("expected")
        .and_then(Value::as_object)
        .ok_or_else(|| GatewayError::invalid("Missing expected console target", None))?;
    let nullable = |key: &str| -> Result<Option<String>, GatewayError> {
        match expected.get(key) {
            Some(Value::Null) => Ok(None),
            Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.clone())),
            _ => Err(GatewayError::invalid(
                format!("expected.{key} must be a nonempty string or null"),
                None,
            )),
        }
    };
    Ok(mobkit_registry::ConsoleExpectedTarget {
        identity: required_nonempty_string(expected, "identity")?,
        runtime_key: required_nonempty_string(expected, "runtimeKey")?,
        runtime_member_id: required_nonempty_string(expected, "runtimeMemberId")?,
        session_id: nullable("sessionId")?,
        source_mob_id: nullable("sourceMobId")?,
    })
}

fn required_mob_id(params: &serde_json::Map<String, Value>) -> Result<String, GatewayError> {
    required_string(params, "mob_id").or_else(|_| required_string(params, "mobId"))
}

fn project_path_from_params(params: Option<&Value>) -> Result<String, GatewayError> {
    let params = object_params(params)?;
    required_string(params, "projectPath")
}

fn object_params(params: Option<&Value>) -> Result<&serde_json::Map<String, Value>, GatewayError> {
    params
        .and_then(Value::as_object)
        .ok_or_else(|| GatewayError::invalid("Missing params", None))
}

fn ensure_request_id(request: &RpcRequest) -> Result<(), GatewayError> {
    if request.id.is_none() {
        return Err(GatewayError::host_tools(
            HostToolTransportError::InvalidEnvelope,
        ));
    }
    Ok(())
}

fn parse_closed_params<T: serde::de::DeserializeOwned>(
    params: Option<&Value>,
) -> Result<T, GatewayError> {
    let params = params
        .cloned()
        .ok_or_else(|| GatewayError::host_tools(HostToolTransportError::InvalidEnvelope))?;
    serde_json::from_value(params)
        .map_err(|_| GatewayError::host_tools(HostToolTransportError::InvalidEnvelope))
}

fn required_string(
    params: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<String, GatewayError> {
    optional_string(params, key)
        .ok_or_else(|| GatewayError::invalid(format!("Missing {key}"), None))
}

fn optional_string(params: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
}

fn optional_generation(
    params: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<u64>, GatewayError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_u64().map(Some).ok_or_else(|| {
            GatewayError::invalid(
                format!("{key} must be a non-negative integer or null"),
                Some(json!({ "field": key, "value": value })),
            )
        }),
    }
}

/// Renderer-safe, closed projection of effective runtime configuration.
///
/// In particular, never serialize `Config::realm`: auth sources may contain
/// inline credentials or command environments. Provider discovery and auth
/// resolution remain inside the Rust runtime.
fn desktop_runtime_config_projection(config: &meerkat::Config) -> Value {
    json!({
        "agent": {
            "model": &config.agent.model,
            "provider_params": &config.agent.provider_params,
        },
        "shell": {
            "security_mode": config.shell.security_mode,
        },
        "tools": {
            "builtins_enabled": config.tools.builtins_enabled,
            "shell_enabled": config.tools.shell_enabled,
            "comms_enabled": config.tools.comms_enabled,
            "mob_enabled": config.tools.mob_enabled,
            "schedule_enabled": config.tools.schedule_enabled,
            "workgraph_enabled": config.tools.workgraph_enabled,
        },
    })
}

/// The desktop settings surface currently owns only shell policy and builtin
/// tool-family toggles. Keep this closed so a compromised renderer cannot use
/// the generic merge-patch transport to mutate realm auth, command credential
/// sources, MCP process environments, or other privileged runtime policy.
fn validate_desktop_config_patch(patch: &Value) -> Result<(), GatewayError> {
    let root = patch
        .as_object()
        .ok_or_else(|| GatewayError::invalid("patch must be a JSON merge-patch object", None))?;
    for (section, value) in root {
        let fields = value.as_object().ok_or_else(|| {
            GatewayError::invalid(
                format!("{section} patch must be an object"),
                Some(json!({"section": section})),
            )
        })?;
        match section.as_str() {
            "tools" => {
                for (field, value) in fields {
                    if !matches!(
                        field.as_str(),
                        "builtins_enabled"
                            | "shell_enabled"
                            | "comms_enabled"
                            | "mob_enabled"
                            | "schedule_enabled"
                            | "workgraph_enabled"
                    ) {
                        return Err(GatewayError::invalid(
                            "Unsupported desktop tools configuration field",
                            Some(json!({"section": section, "field": field})),
                        ));
                    }
                    if !value.is_boolean() {
                        return Err(GatewayError::invalid(
                            "Desktop tool toggles must be booleans",
                            Some(json!({"section": section, "field": field})),
                        ));
                    }
                }
            }
            "shell" => {
                for (field, value) in fields {
                    if field != "security_mode" {
                        return Err(GatewayError::invalid(
                            "Unsupported desktop shell configuration field",
                            Some(json!({"section": section, "field": field})),
                        ));
                    }
                    if !matches!(
                        value.as_str(),
                        Some("unrestricted" | "allow_list" | "deny_list")
                    ) {
                        return Err(GatewayError::invalid(
                            "shell.security_mode must be unrestricted, allow_list, or deny_list",
                            Some(json!({"section": section, "field": field, "value": value})),
                        ));
                    }
                }
            }
            _ => {
                return Err(GatewayError::invalid(
                    "Unsupported desktop configuration section",
                    Some(json!({"section": section})),
                ));
            }
        }
    }
    Ok(())
}

fn optional_authority_revisions(
    params: &serde_json::Map<String, Value>,
) -> Result<Option<BTreeMap<String, u64>>, GatewayError> {
    let Some(value) = params
        .get("expectedAuthorityRevisions")
        .or_else(|| params.get("expected_revisions"))
    else {
        return Ok(None);
    };
    let object = value.as_object().ok_or_else(|| {
        GatewayError::invalid(
            "expectedAuthorityRevisions must be an object",
            Some(json!({"expectedAuthorityRevisions": value})),
        )
    })?;
    let mut revisions = BTreeMap::new();
    for (authority, revision) in object {
        let revision = revision.as_u64().ok_or_else(|| {
            GatewayError::invalid(
                "Topology authority revisions must be non-negative integers",
                Some(json!({"authority": authority, "revision": revision})),
            )
        })?;
        revisions.insert(authority.clone(), revision);
    }
    if revisions.is_empty() {
        return Err(GatewayError::invalid(
            "expectedAuthorityRevisions must not be empty",
            None,
        ));
    }
    Ok(Some(revisions))
}

fn parse_handling_mode(
    params: &serde_json::Map<String, Value>,
) -> Result<HandlingMode, GatewayError> {
    let raw = optional_string(params, "handlingMode")
        .or_else(|| optional_string(params, "handling_mode"))
        .unwrap_or_else(|| "queue".to_string());
    match raw.trim().to_ascii_lowercase().as_str() {
        "queue" => Ok(HandlingMode::Queue),
        "steer" => Ok(HandlingMode::Steer),
        _ => Err(GatewayError::invalid(
            "handlingMode must be \"queue\" or \"steer\"",
            Some(json!({ "handlingMode": raw })),
        )),
    }
}

fn format_tool_event_text(prefix: &str, tool_name: &str, args: Option<&Value>) -> String {
    let name = if tool_name.trim().is_empty() {
        "tool"
    } else {
        tool_name.trim()
    };
    let Some(args) = args else {
        return format!("{prefix}: {name}");
    };
    let args_preview = compact_json_preview(args, 240);
    if args_preview.is_empty() {
        format!("{prefix}: {name}")
    } else {
        format!("{prefix}: {name}\n{args_preview}")
    }
}

fn tool_result_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        if let Ok(parsed) = serde_json::from_str::<Value>(text) {
            return tool_result_text(&parsed);
        }
    }
    extract_text_like(
        value,
        &["output", "stdout", "stderr", "text", "content", "result"],
    )
    .or_else(|| match value {
        Value::String(text) => normalize_extracted_text(text),
        _ => Some(compact_json_preview(value, 2_000)),
    })
}

fn compact_json_preview(value: &Value, max_chars: usize) -> String {
    let raw = match value {
        Value::String(text) => text.clone(),
        _ => serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()),
    };
    let trimmed = raw.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut preview = trimmed.chars().take(max_chars).collect::<String>();
    preview.push_str("...");
    preview
}

fn extract_text_like(event: &Value, keys: &[&str]) -> Option<String> {
    extract_text_like_inner(event, keys, 5)
}

fn extract_text_like_inner(value: &Value, keys: &[&str], depth: usize) -> Option<String> {
    if depth == 0 {
        return None;
    }
    match value {
        Value::String(text) => normalize_extracted_text(text),
        Value::Array(items) => items
            .iter()
            .find_map(|item| extract_text_like_inner(item, keys, depth.saturating_sub(1))),
        Value::Object(map) => {
            for key in keys {
                if let Some(found) = map
                    .iter()
                    .find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
                    .and_then(|(_, candidate)| {
                        extract_text_like_inner(candidate, keys, depth.saturating_sub(1))
                    })
                {
                    return Some(found);
                }
            }
            map.iter().find_map(|(key, candidate)| {
                if matches!(
                    key.as_str(),
                    "type" | "kind" | "role" | "stop_reason" | "stopReason"
                ) {
                    return None;
                }
                extract_text_like_inner(candidate, keys, depth.saturating_sub(1))
            })
        }
        _ => None,
    }
}

fn normalize_summary_text(text: &str) -> String {
    let normalized = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();
    if looks_like_opaque_reasoning_blob(&normalized) {
        String::new()
    } else {
        normalized
    }
}

fn looks_like_opaque_reasoning_blob(text: &str) -> bool {
    let compact = text.trim();
    compact.starts_with("gAAAAA")
        || (compact.len() > 120
            && compact
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '=')))
}

fn normalize_extracted_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "text" || trimmed.starts_with("call_") {
        return None;
    }
    Some(trimmed.to_string())
}

#[derive(Debug, Error)]
enum GatewayError {
    #[error("{message}")]
    Api {
        http_code: i64,
        typed_code: &'static str,
        message: String,
        details: Option<Value>,
    },
}

impl GatewayError {
    fn invalid(message: impl Into<String>, details: Option<Value>) -> Self {
        Self::Api {
            http_code: -32602,
            typed_code: "INVALID_PARAMS",
            message: message.into(),
            details,
        }
    }

    fn not_found(message: impl Into<String>, details: Option<Value>) -> Self {
        Self::Api {
            http_code: -32601,
            typed_code: "NOT_FOUND",
            message: message.into(),
            details,
        }
    }

    fn conflict(message: impl Into<String>, details: Option<Value>) -> Self {
        Self::Api {
            http_code: -32002,
            typed_code: "CONFLICT",
            message: message.into(),
            details,
        }
    }

    fn policy(message: impl Into<String>, details: Option<Value>) -> Self {
        Self::Api {
            http_code: -32000,
            typed_code: "POLICY_ERROR",
            message: message.into(),
            details,
        }
    }

    fn host_tools(error: HostToolTransportError) -> Self {
        let http_code = match error {
            HostToolTransportError::InvalidEnvelope | HostToolTransportError::SchemaMismatch => {
                -32602
            }
            HostToolTransportError::ResultExpired
            | HostToolTransportError::DeadlineExceeded
            | HostToolTransportError::Cancelled
            | HostToolTransportError::CapabilityUnavailable
            | HostToolTransportError::HostDisconnected
            | HostToolTransportError::ResourceLimit
            | HostToolTransportError::InternalUnavailable => -32000,
        };
        Self::Api {
            http_code,
            typed_code: error.code(),
            message: error.to_string(),
            details: None,
        }
    }
}

fn config_runtime_error(error: ConfigRuntimeError) -> GatewayError {
    match error {
        ConfigRuntimeError::GenerationConflict { expected, current } => GatewayError::conflict(
            "Workspace configuration generation conflict",
            Some(json!({
                "expectedGeneration": expected,
                "currentGeneration": current,
            })),
        ),
        ConfigRuntimeError::Config(
            error @ (meerkat_core::ConfigError::Json(_)
            | meerkat_core::ConfigError::InvalidValue(_)
            | meerkat_core::ConfigError::MissingField(_)
            | meerkat_core::ConfigError::Validation(_)),
        ) => GatewayError::invalid(
            "Workspace configuration patch is invalid",
            Some(json!({"error": error.to_string()})),
        ),
        error => GatewayError::policy(
            "Workspace configuration operation failed",
            Some(json!({"error": error.to_string()})),
        ),
    }
}

fn err_to_response(
    id: Option<meerkat_desktop_contracts::RpcId>,
    err: GatewayError,
    trace_id: String,
) -> RpcResponse {
    match err {
        GatewayError::Api {
            http_code,
            typed_code,
            message,
            details,
        } => RpcResponse::err(id, http_code, message, typed_code, trace_id, details),
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn credential_settlement_is_bounded_separately_from_runtime_shutdown() {
        use std::time::Duration;
        let deadline = tokio::time::Instant::now() + super::MeerkatGateway::shutdown_horizon();
        let observed = super::settle_credentials_with_deadline(deadline, |bound| async move {
            assert_eq!(bound, Duration::from_secs(10));
            super::CredentialSettlement::Unsettled { pending: 1 }
        }).await;
        assert_eq!(observed, super::CredentialSettlement::Unsettled { pending: 1 });
        let deadline = tokio::time::Instant::now() + Duration::from_millis(25);
        let observed = super::settle_credentials_with_deadline(deadline, |bound| async move {
            assert!(bound <= Duration::from_millis(25));
            super::CredentialSettlement::Settled
        }).await;
        assert_eq!(observed, super::CredentialSettlement::Settled);
        let observed = super::settle_credentials_with_deadline(tokio::time::Instant::now(), |bound| async move {
            assert_eq!(bound, Duration::ZERO);
            super::CredentialSettlement::Unsettled { pending: 2 }
        }).await;
        assert_eq!(observed, super::CredentialSettlement::Unsettled { pending: 2 });
    }

    fn fixture_assistant_message_id() -> meerkat_core::AssistantMessageId {
        // Fixture-only occurrence metadata; production IDs are minted by core.
        serde_json::from_value(serde_json::json!("00000000-0000-4000-8000-000000000001"))
            .expect("valid fixture assistant message ID")
    }
    use serde_json::{json, Value};
    use super::{console_expected_target, native_model, member_llm_identity,
        admit_active_run_locked, assistant_message_is_terminal_candidate, assistant_message_text,
        derive_project_locator, desktop_runtime_config_projection, effective_models_catalog,
        emit_named_event, finish_run, history_window_after_latest_user_prompt,
        member_kickoff_phase_is_quiescent, member_turn_options_from_params, path_hex_component,
        process_agent_event_envelope, project_runtime_instance_id, project_runtime_key,
        terminal_assistant_index_for_history_recovery, validate_desktop_config_patch, ActiveRun,
        AppRunDeliveries, DesktopHostToolNotificationV1, HostToolTransport, LiveEventAssembler,
        MeerkatGateway, ProjectLocator, ProjectMobkitRegistry, ProjectRuntimeHandle,
        ProjectRuntimeState, RunEventProjection,
    };
    use meerkat_core::event::{AgentEvent, EventEnvelope, EventSourceIdentity};
    use meerkat_core::lifecycle::run_primitive::{
        ProviderTag, ReasoningEffort, TurnMetadataOverride,
    };
    use meerkat_core::types::{SessionId, Usage};
    use meerkat_core::Provider;
    use meerkat_desktop_contracts::{RequestContext, RpcId, RpcRequest};
    use meerkat_mob::MobMemberKickoffPhase;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::{Barrier, Mutex};
    use uuid::Uuid;

    #[tokio::test]
    async fn team_snapshot_is_cold_read_only_and_scoped_to_loaded_project() {
        let fixture = std::env::temp_dir().join(format!("meerkat-team-cold-{}", Uuid::new_v4()));
        let project = fixture.join("project");
        let other_project = fixture.join("other-project");
        let state_root = fixture.join("absent-state");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&other_project).unwrap();
        let gateway = MeerkatGateway::new();
        let params = serde_json::json!({"projectPath": project, "stateRoot": state_root});
        let cold = gateway.mobs_team_snapshot(Some(&params)).await.unwrap();
        assert_eq!(
            cold,
            serde_json::json!({"observation":"loaded_runtimes","loaded":false,"mobs":[]})
        );
        assert!(
            !state_root.exists(),
            "Team must not create a state directory"
        );
        assert!(gateway.inner.project_runtimes.lock().await.is_empty());
        assert!(gateway.inner.mobkit_registries.lock().await.is_empty());

        let handle = gateway
            .project_runtime_handle_for_paths(
                project.to_str().unwrap(),
                project.to_str().unwrap(),
                "local".into(),
                Some(state_root.to_str().unwrap()),
            )
            .await
            .unwrap();
        let registry = Arc::clone(&handle.state.lock().await.mobkit);
        registry
            .insert_remote_tcp(
                "remote".into(),
                "Remote Team".into(),
                "127.0.0.1:1".into(),
                None,
            )
            .await.unwrap();
        let loaded = gateway.mobs_team_snapshot(Some(&params)).await.unwrap();
        assert_eq!(loaded["loaded"], true);
        assert_eq!(loaded["mobs"][0]["consoleStatus"], "unavailable");
        assert!(loaded["mobs"][0]["error"].is_string());
        assert!(loaded["mobs"][0].get("stateRoot").is_none());
        for foreign in [
            serde_json::json!({"projectPath":other_project,"stateRoot":state_root}),
            serde_json::json!({"projectPath":project,"stateRoot":fixture.join("other-state")}),
        ] {
            assert_eq!(
                gateway.mobs_team_snapshot(Some(&foreign)).await.unwrap()["loaded"],
                false
            );
        }
        assert!(!fixture.join("other-state").exists());
        assert_eq!(gateway.inner.project_runtimes.lock().await.len(), 1);
        let unavailable = serde_json::json!({"projectPath":project,"stateRoot":state_root,"mobId":"remote","identity":"ingress"});
        assert!(gateway
            .mobs_console_timeline(Some(&unavailable))
            .await
            .is_err());
        drop(gateway);
        let _ = std::fs::remove_dir_all(fixture);
    }

    struct ConsoleControlLlm {
        started: tokio::sync::Semaphore,
        release: tokio::sync::Semaphore,
        calls: AtomicUsize,
    }

    impl ConsoleControlLlm {
        fn new() -> Self {
            Self {
                started: tokio::sync::Semaphore::new(0),
                release: tokio::sync::Semaphore::new(0),
                calls: AtomicUsize::new(0),
            }
        }
        async fn wait_started(&self) {
            tokio::time::timeout(Duration::from_secs(10), self.started.acquire())
                .await
                .unwrap_or_else(|error| {
                    panic!(
                        "expected provider start after {} calls: {error}",
                        self.calls.load(Ordering::SeqCst)
                    )
                })
                .unwrap()
                .forget();
        }
    }

    #[async_trait::async_trait]
    impl meerkat::LlmClient for ConsoleControlLlm {
        fn project_replay_messages(
            &self,
            messages: &[meerkat_core::Message],
        ) -> Result<Vec<meerkat_core::Message>, meerkat::LlmError> {
            Ok(messages.to_vec())
        }
        fn stream<'a>(
            &'a self,
            _request: &'a meerkat::LlmRequest,
        ) -> std::pin::Pin<
            Box<
                dyn futures_util::Stream<Item = Result<meerkat::LlmEvent, meerkat::LlmError>>
                    + Send
                    + 'a,
            >,
        > {
            use futures_util::StreamExt;
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.started.add_permits(1);
            Box::pin(
                futures_util::stream::once(async move {
                    self.release.acquire().await.unwrap().forget();
                    Ok(meerkat::LlmEvent::TextDelta {
                        delta: "Console control proof completed.".into(),
                        meta: None,
                    })
                })
                .chain(futures_util::stream::once(async {
                    Ok(meerkat::LlmEvent::Done {
                        outcome: meerkat::LlmDoneOutcome::Success {
                            stop_reason: meerkat_core::StopReason::EndTurn,
                        },
                    })
                })),
            )
        }
        fn provider(&self) -> meerkat_core::Provider {
            meerkat_core::Provider::Other
        }
        async fn health_check(&self) -> Result<(), meerkat::LlmError> {
            Ok(())
        }
    }

    fn console_control_params(
        project_path: &str,
        state_root: &str,
        mob_id: &str,
        record: &meerkat_mobkit::ConsoleIdentityRecord,
    ) -> serde_json::Value {
        serde_json::json!({"projectPath":project_path,"stateRoot":state_root,"mobId":mob_id,"expected":{
            "identity":record.identity,"runtimeKey":record.runtime_key,"runtimeMemberId":record.runtime_member_id,
            "sessionId":record.session_id,"sourceMobId":record.labels.get("source_mob_id")
        },"content":"native console proof","handlingMode":"queue","idempotencyKey":"console-proof",
        "nativeRunId":Uuid::new_v4().to_string()})
    }

    async fn wait_console_frame(
        console: &meerkat_mobkit::MetaConsoleAggregator,
        identity: &str,
        kind: &str,
    ) -> meerkat_mobkit::ConsoleFrame {
        let mut events = console.subscribe();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let page = console
                    .query_timeline(meerkat_mobkit::ConsoleTimelineQuery {
                        identity: Some(identity.into()),
                        conversation_id: None,
                        after: None,
                        limit: 100,
                    })
                    .await
                    .unwrap();
                if let Some(frame) = page.frames.into_iter().find(|frame| {
                    frame.kind == kind
                        || kind == "terminal"
                            && matches!(
                                frame.kind.as_str(),
                                "interaction_complete" | "interaction_failed"
                            )
                }) {
                    return frame;
                }
                events.recv().await.expect("console frame event");
            }
        })
        .await
        .expect("expected native console frame")
    }

    #[test]
    fn console_controls_fence_stale_targets_resolve_children_and_preserve_domain_history() {
        std::thread::Builder::new()
            .name("console-control-proof".into())
            .stack_size(32 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .thread_stack_size(16 * 1024 * 1024)
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(console_control_proof());
            })
            .unwrap()
            .join()
            .unwrap();
    }

    async fn console_control_proof() {
        let fixture =
            std::env::temp_dir().join(format!("meerkat-console-control-{}", uuid::Uuid::new_v4()));
        let project_path = fixture.join("project");
        let state_root = fixture.join("state");
        std::fs::create_dir_all(&project_path).unwrap();
        let project_path = project_path.to_string_lossy().into_owned();
        let state_root = state_root.to_string_lossy().into_owned();
        let gateway = MeerkatGateway::new();
        let llm = Arc::new(ConsoleControlLlm::new());
        let handle = gateway
            .project_runtime_handle_for_paths(
                &project_path,
                &project_path,
                "local".into(),
                Some(&state_root),
            )
            .await
            .unwrap();
        handle.state.lock().await.mobkit = Arc::new(ProjectMobkitRegistry::new_with_test_llm(
            Arc::clone(&gateway.inner.host_tools),
            llm.clone(),
        ));
        let domain_params = serde_json::json!({"projectPath":project_path,"stateRoot":state_root,"mobId":"domain-controls","label":"Project specialist","role":"domain","agentIdentity":"specialist","model":"gpt-5.6-sol","instructions":"Preserve this project charter.","includeNativeWorkers":true});
        gateway
            .mobs_create_domain_mob(Some(&domain_params))
            .await
            .unwrap();
        let root = gateway
            .mob_for_params(domain_params.as_object().unwrap(), "domain-controls")
            .await
            .unwrap();
        let console = root.console.as_ref().unwrap();
        let record = console
            .list_identities()
            .await
            .unwrap()
            .into_iter()
            .find(|record| record.identity == "specialist")
            .unwrap();
        let params = console_control_params(&project_path, &state_root, "domain-controls", &record);
        for key in [
            "identity",
            "runtimeKey",
            "runtimeMemberId",
            "sessionId",
            "sourceMobId",
        ] {
            let mut stale = params.clone();
            stale["expected"][key] = serde_json::json!("wrong-target");
            assert!(
                gateway.mobs_console_send(Some(&stale)).await.is_err(),
                "stale {key}"
            );
            assert!(
                gateway.mobs_console_stop(Some(&stale)).await.is_err(),
                "stale stop {key}"
            );
            assert!(
                gateway.mobs_console_status(Some(&stale)).await.is_err(),
                "stale status {key}"
            );
        }
        let mut invalid = params.clone();
        invalid["expected"]
            .as_object_mut()
            .unwrap()
            .remove("sessionId");
        assert!(gateway.mobs_console_send(Some(&invalid)).await.is_err());
        invalid = params.clone();
        invalid["handlingMode"] = serde_json::json!("invented");
        assert!(gateway.mobs_console_send(Some(&invalid)).await.is_err());
        assert_eq!(llm.calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            gateway.mobs_console_status(Some(&params)).await.unwrap()["busy"],
            false
        );
        let accepted = gateway.mobs_console_send(Some(&params)).await.unwrap();
        llm.wait_started().await;
        assert_eq!(
            gateway.mobs_console_status(Some(&params)).await.unwrap()["busy"],
            true
        );
        let mut model_change = params.clone();
        model_change["model"] = json!("gpt-5.4");
        model_change["provider"] = json!("openai");
        model_change["providerParams"] = Value::Null;
        let expected = console_expected_target(params.as_object().unwrap()).unwrap();
        assert!(native_model::apply(&root, &expected, model_change.as_object().unwrap()).await.is_err(), "model changes must not interrupt active work");
        let replay = gateway.mobs_console_send(Some(&params)).await.unwrap();
        assert_eq!(
            accepted["receipt"]["interaction_id"],
            replay["receipt"]["interaction_id"]
        );
        let mut changed = params.clone();
        changed["content"] = serde_json::json!("conflicting duplicate");
        assert!(gateway.mobs_console_send(Some(&changed)).await.is_err());
        llm.release.add_permits(1);
        let completed = wait_console_frame(console, "specialist", "text_complete").await;
        wait_console_frame(console, "specialist", "interaction_complete").await;
        assert_eq!(
            llm.calls.load(Ordering::SeqCst),
            1,
            "native idempotency sends once"
        );

        let session_service = root.runtime.as_ref().unwrap().mob_runtime().session_service().unwrap();
        let settled_session: meerkat_core::SessionId = serde_json::from_value(json!(expected.session_id.as_ref().unwrap())).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if !session_service.read(&settled_session).await.unwrap().state.is_active { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("native session settles before changing model");
        native_model::apply(&root, &expected, model_change.as_object().unwrap()).await.unwrap();
        let identity = member_llm_identity(root.runtime.as_ref().unwrap(), "specialist").await.unwrap().unwrap();
        assert_eq!(identity.model.as_str(), "gpt-5.4");
        model_change["handlingMode"] = json!("steer");
        assert!(native_model::apply(&root, &expected, model_change.as_object().unwrap()).await.is_err(), "steering cannot reconfigure an agent model");

        gateway.mobs_destroy(Some(&domain_params)).await.unwrap();
        drop(root);
        gateway
            .mobs_create_domain_mob(Some(&domain_params))
            .await
            .unwrap();
        let restored = gateway
            .mob_for_params(domain_params.as_object().unwrap(), "domain-controls")
            .await
            .unwrap();
        let restored_console = restored.console.as_ref().unwrap();
        let persisted = wait_console_frame(restored_console, "specialist", "text_complete").await;
        assert_eq!(persisted.id, completed.id);
        let mut page_params = domain_params.clone();
        page_params["identity"] = serde_json::json!("specialist");
        page_params["limit"] = serde_json::json!(3);
        let recent = gateway
            .mobs_console_timeline(Some(&page_params))
            .await
            .unwrap();
        let cursor = recent["timeline"]["next_cursor"]
            .as_str()
            .expect("older frames exist");
        page_params["before"] = serde_json::json!(cursor);
        let earlier = gateway
            .mobs_console_timeline(Some(&page_params))
            .await
            .unwrap();
        let recent_ids: Vec<_> = recent["timeline"]["frames"]
            .as_array()
            .unwrap()
            .iter()
            .map(|frame| frame["id"].clone())
            .collect();
        let earlier_frames = earlier["timeline"]["frames"].as_array().unwrap();
        assert!(!earlier_frames.is_empty());
        assert!(earlier_frames
            .iter()
            .any(|frame| !recent_ids.contains(&frame["id"])));
        assert_ne!(
            recent["timeline"]["next_cursor"],
            earlier["timeline"]["next_cursor"]
        );
        let current = restored_console
            .list_identities()
            .await
            .unwrap()
            .into_iter()
            .find(|record| record.identity == "specialist")
            .unwrap();
        let restored_params =
            console_control_params(&project_path, &state_root, "domain-controls", &current);
        let durable_replay = gateway
            .mobs_console_send(Some(&restored_params))
            .await
            .unwrap();
        assert_eq!(
            durable_replay["receipt"]["interaction_id"],
            accepted["receipt"]["interaction_id"]
        );
        assert_eq!(
            llm.calls.load(Ordering::SeqCst),
            1,
            "durable replay must not dispatch after restore"
        );
        let mut fresh_params = restored_params.clone();
        fresh_params["idempotencyKey"] = serde_json::json!("after-restore-proof");
        fresh_params["handlingMode"] = serde_json::json!("queue");
        let fresh = gateway
            .mobs_console_send(Some(&fresh_params))
            .await
            .unwrap();
        llm.wait_started().await;
        let mut steer_params = fresh_params.clone();
        steer_params["idempotencyKey"] = serde_json::json!("active-steer-proof");
        steer_params["handlingMode"] = serde_json::json!("steer");
        steer_params["content"] = serde_json::json!("Apply this while the active turn is running.");
        let steer = gateway
            .mobs_console_send(Some(&steer_params))
            .await
            .unwrap();
        assert_eq!(
            llm.calls.load(Ordering::SeqCst),
            2,
            "steer acceptance does not wait for the active provider"
        );
        let steer_replay = gateway
            .mobs_console_send(Some(&steer_params))
            .await
            .unwrap();
        assert_eq!(steer["receipt"]["kind"], "runtime_input");
        assert_eq!(steer["receipt"], steer_replay["receipt"]);
        assert!(steer["receipt"].get("interaction_id").is_none());
        let cold = crate::native_steering::read_receipt(Some(&steer_params)).await.unwrap();
        assert_eq!(cold["receipt"], steer["receipt"]);
        let mut changed_steer = steer_params.clone();
        changed_steer["content"] = json!("Changed steering cannot replay the same key");
        assert!(gateway.mobs_console_send(Some(&changed_steer)).await.is_err());
        changed_steer = steer_params.clone();
        changed_steer["handlingMode"] = json!("queue");
        assert!(gateway.mobs_console_send(Some(&changed_steer)).await.is_err());
        // Each input owns its native terminal receipt. A raw run completion
        // need not retain the console interaction id after typed steering.
        // This restore test permits a later run boundary; the public steering
        // fixture separately proves application to the original active run.
        use meerkat_runtime::completion::CompletionOutcome;
        use meerkat_runtime::terminal_status::{InputTerminalReceiptRead, InteractionSelector};
        let session_id = SessionId::parse(current.session_id.as_deref().unwrap()).unwrap();
        assert_eq!(current.session_id, record.session_id, "restore preserves the native session");
        assert_eq!(steer["receipt"]["sessionId"], session_id.to_string());
        let fresh_interaction = fresh["receipt"]["interaction_id"].as_str().unwrap();
        let fresh_input_key = fresh["receipt"]["input_frame_id"].as_str().unwrap();
        let steer_input: meerkat_core::InputId = serde_json::from_value(steer["receipt"]["inputId"].clone()).unwrap();
        llm.release.add_permits(4);
        let mut last_observed_receipts = None;
        let (fresh_run, steer_run) = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let machine = restored.session_runtime.as_ref().unwrap();
                let fresh_terminal = machine.input_terminal_receipt(&session_id,
                    InteractionSelector::IdempotencyKey(fresh_input_key.into())).await.unwrap();
                let steer_terminal = machine.input_terminal_receipt(&session_id,
                    InteractionSelector::InputId(steer_input.clone())).await.unwrap();
                if let (Some(fresh_terminal), Some(steer_terminal)) = (&fresh_terminal, &steer_terminal) {
                    if let (InputTerminalReceiptRead::Finalized(fresh_receipt), InputTerminalReceiptRead::Finalized(steer_receipt)) = (&fresh_terminal.report, &steer_terminal.report) {
                        assert_eq!(steer_receipt.input_id(), &steer_input);
                        assert_ne!(fresh_receipt.input_id(), &steer_input, "original message and steering have distinct admissions");
                        assert!(matches!(fresh_receipt.outcome(), CompletionOutcome::Completed(result)
                            if result.session_id == session_id && result.extraction_error.is_none() && result.text == "Console control proof completed."), "original input must have its own successful native result: {fresh_receipt:?}");
                        let fresh_run = fresh_receipt.run_id().expect("original input completed in a native run").clone();
                        let steer_run = steer_receipt.run_id().expect("steering completed in a native run").clone();
                        match steer_receipt.outcome() {
                            CompletionOutcome::Completed(result) => {
                                assert_eq!(result.session_id, session_id);
                                assert!(result.extraction_error.is_none());
                                assert_eq!(result.text, "Console control proof completed.");
                            }
                            CompletionOutcome::CompletedWithoutResult => assert_eq!(steer_run, fresh_run, "a context append must belong to the original completed run"),
                            other => panic!("steering did not complete successfully: {other:?}"),
                        }
                        break (fresh_run, steer_run);
                    }
                }
                last_observed_receipts = Some((fresh_terminal, steer_terminal));
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|error| panic!("native input completion after restore: {error}; receipts={last_observed_receipts:?}"));
        let session_service = restored
            .runtime
            .as_ref()
            .unwrap()
            .mob_runtime()
            .session_service()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let state = session_service.read(&session_id).await.unwrap();
                let history = session_service.read_history(&session_id, meerkat_core::service::SessionHistoryQuery::default()).await.unwrap();
                let steering_count = history.messages.iter().filter(|message| {
                    matches!(message, meerkat_core::Message::User(user) if user.text_content() == "Apply this while the active turn is running.")
                }).count();
                let original_count = history.messages.iter().filter(|message| {
                    matches!(message, meerkat_core::Message::User(user)
                        if user.text_content() == "native console proof"
                            && user.identity.interaction_id.is_some_and(|identity| identity.to_string() == fresh_interaction)
                            && user.identity.run_id.as_ref() == Some(&fresh_run))
                }).count();
                let saved_answer_count = |run: &meerkat_core::lifecycle::RunId| history.messages.iter().filter(|message| {
                    matches!(message, meerkat_core::Message::BlockAssistant(assistant)
                        if assistant.identity.run_id.as_ref() == Some(run)
                            && assistant.text_blocks().collect::<String>() == "Console control proof completed."
                            && assistant.stop_reason == Some(meerkat_core::StopReason::EndTurn))
                }).count();
                if !state.state.is_active && steering_count == 1 && original_count == 1
                    && saved_answer_count(&fresh_run) == 1 && saved_answer_count(&steer_run) == 1 { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("both inputs and their successful native answers are saved exactly once and the session settled");
        llm.release.forget_permits(usize::MAX);
        llm.started.forget_permits(usize::MAX);
        assert_eq!(
            gateway
                .mobs_console_status(Some(&restored_params))
                .await
                .unwrap()["busy"],
            false
        );
        let calls_before_child = llm.calls.load(Ordering::SeqCst);
        assert!(calls_before_child >= 2);
        let runtime = restored.runtime.as_ref().unwrap();
        let console = restored_console;
        let native_state = runtime.mob_runtime().agent_mob_mcp_state().unwrap();
        let mut definition = runtime.mob_handle().definition().clone();
        let child_id = meerkat_mob::MobId::from("console-child");
        definition.id = child_id.clone();
        native_state
            .mob_create_definition(definition)
            .await
            .unwrap();
        native_state
            .mob_spawn_spec(
                &child_id,
                meerkat_mob::SpawnMemberSpec::new("domain", "worker-runtime")
                    .with_runtime_mode(meerkat_mob::MobRuntimeMode::TurnDriven)
                    .with_labels(std::collections::BTreeMap::from([(
                        "agent_identity".into(),
                        "worker-alias".into(),
                    )])),
            )
            .await
            .unwrap();
        let child = console
            .list_identities()
            .await
            .unwrap()
            .into_iter()
            .find(|record| record.identity == "worker-alias")
            .unwrap();
        let mut child_params =
            console_control_params(&project_path, &state_root, "domain-controls", &child);
        child_params["idempotencyKey"] = serde_json::json!("child-proof");
        let mut duplicate_definition = runtime.mob_handle().definition().clone();
        let duplicate_id = meerkat_mob::MobId::from("console-ambiguous-child");
        duplicate_definition.id = duplicate_id.clone();
        native_state
            .mob_create_definition(duplicate_definition)
            .await
            .unwrap();
        native_state
            .mob_spawn_spec(
                &duplicate_id,
                meerkat_mob::SpawnMemberSpec::new("domain", "duplicate-runtime")
                    .with_runtime_mode(meerkat_mob::MobRuntimeMode::TurnDriven)
                    .with_labels(std::collections::BTreeMap::from([(
                        "agent_identity".into(),
                        "worker-alias".into(),
                    )])),
            )
            .await
            .unwrap();
        assert!(
            gateway
                .mobs_console_send(Some(&child_params))
                .await
                .is_err(),
            "ambiguous aliases must fail before admission"
        );
        assert!(
            gateway
                .mobs_console_stop(Some(&child_params))
                .await
                .is_err(),
            "ambiguous aliases must not cancel either worker"
        );
        native_state.mob_destroy(&duplicate_id).await.unwrap();
        let child_receipt = gateway
            .mobs_console_send(Some(&child_params))
            .await
            .unwrap();
        assert_eq!(
            child_receipt["receipt"]["session_id"],
            serde_json::json!(child.session_id)
        );
        llm.wait_started().await;
        let child_work = gateway.mobs_console_status(Some(&child_params)).await.unwrap();
        assert_eq!(child_work["busy"], true);
        assert!(child_work["nativeRunId"].is_string());
        let stale_stop = gateway.mobs_console_stop(Some(&child_params)).await.unwrap();
        assert_eq!(stale_stop["accepted"], false);
        assert_eq!(stale_stop["receipt"]["outcome"], "not_current");
        assert_eq!(gateway.mobs_console_status(Some(&child_params)).await.unwrap()["busy"], true);
        child_params["nativeRunId"] = child_work["nativeRunId"].clone();
        assert_eq!(
            tokio::time::timeout(
                Duration::from_secs(5),
                gateway.mobs_console_stop(Some(&child_params))
            )
            .await
            .expect("native cancellation admission must settle")
            .unwrap()["accepted"],
            true
        );
        // The exact-run receipt waits for native contributors to terminalize.
        let stopped_work = gateway.mobs_console_status(Some(&child_params)).await.unwrap();
        assert_eq!(stopped_work["busy"], false);
        assert!(stopped_work.get("nativeRunId").is_none());
        wait_console_frame(console, "worker-alias", "terminal").await;
        assert_eq!(llm.calls.load(Ordering::SeqCst), calls_before_child + 1);
        gateway.mobs_destroy(Some(&domain_params)).await.unwrap();
        assert!(
            gateway
                .mobs_console_send(Some(&child_params))
                .await
                .is_err(),
            "unloaded child must not dispatch to another runtime"
        );
        drop(restored);
        drop(gateway);
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[tokio::test]
    async fn console_controls_preserve_thread_run_ownership_and_domain_worker_opt_in() {
        assert!(!super::include_native_workers_param(&serde_json::Map::new()).unwrap());
        for include_native_workers in [false, true] {
            let (fixture, project_path, state_root, gateway, llm) =
                setup_real_mobkit_host_tool_fixture_with_workers(
                    "console-thread-owner",
                    1,
                    include_native_workers,
                )
                .await;
            let mob_id = real_mobkit_fixture_mob_id(&project_path);
            let scope = serde_json::json!({"projectPath":project_path,"stateRoot":state_root});
            let root = gateway
                .mob_for_params(scope.as_object().unwrap(), &mob_id)
                .await
                .unwrap();
            let record = root
                .console
                .as_ref()
                .unwrap()
                .list_identities()
                .await
                .unwrap()
                .remove(0);
            let params = console_control_params(&project_path, &state_root, &mob_id, &record);
            assert!(gateway.mobs_console_send(Some(&params)).await.is_err());
            assert!(gateway.mobs_console_stop(Some(&params)).await.is_err());
            assert_eq!(llm.streams.load(Ordering::SeqCst), 0);
            for value in [
                serde_json::json!(null),
                serde_json::json!("true"),
                serde_json::json!(1),
            ] {
                let invalid = serde_json::json!({"includeNativeWorkers":value});
                assert!(gateway
                    .mobs_create_domain_mob(Some(&invalid))
                    .await
                    .is_err());
            }
            destroy_real_mobkit_host_tool_fixture(gateway, &fixture, &project_path, &state_root)
                .await;
        }
    }

    #[tokio::test]
    async fn team_snapshot_observes_native_children_only_when_opted_in() {
        for include_native_workers in [false, true] {
            let (fixture, project_path, state_root, gateway, llm) =
                setup_real_mobkit_host_tool_fixture_with_workers(
                    "team-native",
                    1,
                    include_native_workers,
                )
                .await;
            let mob_id = real_mobkit_fixture_mob_id(&project_path);
            let params = serde_json::json!({"projectPath":project_path,"stateRoot":state_root});
            let root = gateway
                .mob_for_params(params.as_object().unwrap(), &mob_id)
                .await
                .unwrap();
            let runtime = root.runtime.as_ref().unwrap();
            let native_state = runtime.mob_runtime().agent_mob_mcp_state().unwrap();
            let mut definition = runtime.mob_handle().definition().clone();
            let child_id = meerkat_mob::MobId::from(format!("{mob_id}-child"));
            definition.id = child_id.clone();
            native_state
                .mob_create_definition(definition)
                .await
                .unwrap();
            let labels = std::collections::BTreeMap::from([
                ("agent_identity".into(), "worker-alias".into()),
                ("spawned_by".into(), "unverified-parent".into()),
            ]);
            native_state
                .mob_spawn_spec(
                    &child_id,
                    meerkat_mob::SpawnMemberSpec::new("ingress", "worker-runtime")
                        .with_runtime_mode(meerkat_mob::MobRuntimeMode::TurnDriven)
                        .with_labels(labels),
                )
                .await
                .unwrap();
            let before_reads = llm.streams.load(Ordering::SeqCst);
            let expected = root
                .console
                .as_ref()
                .unwrap()
                .list_identities()
                .await
                .unwrap();
            let snapshot = gateway.mobs_team_snapshot(Some(&params)).await.unwrap();
            assert_eq!(snapshot["loaded"], true);
            assert_eq!(snapshot["mobs"][0]["consoleStatus"], "ready");
            assert_eq!(
                snapshot["mobs"][0]["identities"],
                serde_json::to_value(expected).unwrap()
            );
            let records = snapshot["mobs"][0]["identities"].as_array().unwrap();
            let child = records
                .iter()
                .find(|record| record["runtime_member_id"] == "worker-runtime");
            assert_eq!(child.is_some(), include_native_workers);
            if let Some(child) = child {
                assert_eq!(child["identity"], "worker-alias");
                assert_eq!(child["labels"]["source_mob_id"], child_id.as_str());
                assert!(
                    child["labels"].get("spawned_by").is_none(),
                    "native lineage sanitization must be preserved"
                );
                assert!(child["session_id"].is_string());
            }
            assert_eq!(
                llm.streams.load(Ordering::SeqCst),
                before_reads,
                "Team reads must not admit turns"
            );
            assert_eq!(before_reads, 0, "turn-driven fixture must not run a model");
            let root_members = super::mobkit_registry::list_members(runtime).await;
            assert_eq!(
                root_members.len(),
                1,
                "fixture child must be native, outside the root roster"
            );

            let handle = gateway
                .project_runtime_handle_for_mob_params(params.as_object().unwrap())
                .await
                .unwrap();
            let registry = Arc::clone(&handle.state.lock().await.mobkit);
            registry
                .insert_remote_tcp(
                    "remote".into(),
                    "Unavailable sibling".into(),
                    "127.0.0.1:1".into(),
                    None,
                )
                .await.unwrap();
            let mixed = gateway.mobs_team_snapshot(Some(&params)).await.unwrap();
            let mobs = mixed["mobs"].as_array().unwrap();
            assert_eq!(mobs.len(), 2);
            assert_eq!(
                mobs.iter().find(|mob| mob["mobId"] == mob_id).unwrap()["consoleStatus"],
                "ready"
            );
            assert_eq!(
                mobs.iter().find(|mob| mob["mobId"] == "remote").unwrap()["consoleStatus"],
                "unavailable"
            );
            native_state.mob_destroy(&child_id).await.unwrap();
            destroy_real_mobkit_host_tool_fixture(gateway, &fixture, &project_path, &state_root)
                .await;
        }
    }

    #[test]
    fn normalized_tool_events_preserve_runtime_identity_and_failure() {
        let mut assembler = LiveEventAssembler::default();
        let started = super::session_tool_call_to_live_events(
            &serde_json::json!({"id":"shell-1","name":"shell","args":{"command":"exit 7"}}),
            "thread-tools",
            "run-tools",
            chrono::Utc::now(),
            &mut assembler,
        );
        assert_eq!(super::live_event_payload(&started[0])["toolId"], "shell-1");
        let completed = super::normalize_tool_execution_completed(
            "thread-tools",
            "run-tools",
            chrono::Utc::now(),
            &serde_json::json!({"id":"shell-1","name":"shell","content":"exit status 7","is_error":true}),
            &mut assembler,
        );
        let payload = super::live_event_payload(&completed[0]);
        assert_eq!(payload["toolId"], "shell-1");
        assert_eq!(payload["command"], "exit 7");
        assert_eq!(payload["isError"], true);
        assert_eq!(payload["status"], "Error");
        assert!(
            super::normalize_tool_execution_completed(
                "thread-tools",
                "run-tools",
                chrono::Utc::now(),
                &serde_json::json!({"id":"shell-1","name":"shell","is_error":true}),
                &mut assembler,
            )
            .is_empty(),
            "duplicate runtime completion must not produce another tool item"
        );

        let generic = super::normalize_tool_execution_completed(
            "thread-tools",
            "run-tools",
            chrono::Utc::now(),
            &serde_json::json!({"id":"read-1","name":"read_file","content":"not found","is_error":true}),
            &mut assembler,
        );
        let payload = super::live_event_payload(&generic[0]);
        assert_eq!(payload["toolId"], "read-1");
        assert_eq!(payload["isError"], true);
        assert_eq!(payload["toolName"], "read_file");
        assert!(payload["text"].as_str().unwrap().starts_with("Tool failed"));

        let command_failure = super::normalize_tool_execution_completed(
            "thread-tools",
            "run-tools",
            chrono::Utc::now(),
            &serde_json::json!({"id":"shell-exit","name":"shell","content":[{
                "type":"structured","data":{"exit_code":7,"stdout":"","stderr":"","timed_out":false,
                    "placement":{"working_root":"must-not-become-output"}}
            }],"is_error":false}),
            &mut assembler,
        );
        let payload = super::live_event_payload(&command_failure[0]);
        assert_eq!(payload["exitCode"], 7);
        assert_eq!(payload["status"], "Error");
        assert_eq!(
            payload["isError"], false,
            "runtime invocation truth stays separate from command outcome"
        );
        assert_eq!(
            payload["output"], "",
            "empty command output must not fall through to placement metadata"
        );
        assert!(payload["toolResult"].is_array());

        let unknown = super::normalize_tool_execution_completed(
            "thread-tools",
            "run-tools",
            chrono::Utc::now(),
            &serde_json::json!({"id":"shell-unknown","name":"shell","content":"legacy output"}),
            &mut assembler,
        );
        let payload = super::live_event_payload(&unknown[0]);
        assert!(
            payload["status"].is_null(),
            "missing runtime success evidence must not become Success"
        );
        assert!(payload["isError"].is_null());
    }

    #[tokio::test]
    async fn run_projection_retains_only_explicit_native_run_authority() {
        let projection = Arc::new(Mutex::new(RunEventProjection::default()));
        let (events, _) = tokio::sync::broadcast::channel(8);
        let session = SessionId::new();
        let run: meerkat_core::RunId = serde_json::from_value(json!(Uuid::new_v4())).unwrap();
        let started = |identity| AgentEvent::RunStarted {
            session_id: session.clone(),
            identity,
            input: meerkat_core::types::RunInput::Content {
                content: meerkat_core::ContentInput::Text("Do this work".into()),
            },
            request_reasoning: None,
        };
        let observed = EventEnvelope::new_session(session.clone(), 1, None, started(
            meerkat_core::types::TranscriptMessageIdentity {
                run_id: Some(run.clone()),
                ..Default::default()
            },
        ));
        let (identity, projected) = tokio::join!(
            super::observed_native_run(&projection),
            super::project_run_event(&projection, &observed, "thread", "app-run", &events),
        );
        projected.unwrap();
        assert_eq!(identity, (Some(session.to_string()), Some(run.clone())));
        assert_eq!(projection.lock().await.assembler.native_run_id.as_ref(), Some(&run));
        let legacy = EventEnvelope::new_session(session.clone(), 2, None, started(Default::default()));
        super::project_run_event(&projection, &legacy, "thread", "app-run", &events).await.unwrap();
        assert!(projection.lock().await.assembler.native_run_id.is_none(), "an absent native run never reuses the previous run or event id");
    }

    #[tokio::test]
    async fn interleaved_member_streams_present_both_finals_without_native_backpressure() {
        let projection = Arc::new(Mutex::new(RunEventProjection::default()));
        let original_presentation = super::run_presentation_guard(&projection).await;
        let (original_tx, original_rx) = tokio::sync::mpsc::channel(2);
        let (fallback_tx, fallback_rx) = tokio::sync::mpsc::channel(2);
        let original_rx = super::buffer_member_events(original_rx);
        let fallback_rx = super::buffer_member_events(fallback_rx);
        let (events_tx, mut events_rx) = tokio::sync::broadcast::channel(1024);
        let session_id = SessionId::new();
        let envelope =
            |seq, payload| EventEnvelope::new_session(session_id.clone(), seq, None, payload);
        let started = |prompt: &str| AgentEvent::RunStarted {
            identity: Default::default(),
            session_id: session_id.clone(),
            input: meerkat_core::types::RunInput::Content {
                content: meerkat_core::ContentInput::Text(prompt.into()),
            },
            request_reasoning: None,
        };
        let completed = |text: &str| AgentEvent::RunCompleted {
            identity: Default::default(),
            assistant_message_id: Some(fixture_assistant_message_id()),
            session_id: session_id.clone(),
            result: text.into(),
            structured_output: None,
            extraction_required: false,
            usage: Usage::default().into(),
            terminal_cause_kind: None,
        };
        let original_projection = Arc::clone(&projection);
        let original_events = events_tx.clone();
        let original = tokio::spawn(async move {
            super::present_member_events(
                original_rx,
                original_projection,
                &original_events,
                "thread",
                "run",
                Some(original_presentation),
            )
            .await
        });
        let fallback_projection = Arc::clone(&projection);
        let fallback_events = events_tx.clone();
        let fallback = tokio::spawn(async move {
            super::present_member_events(
                fallback_rx,
                fallback_projection,
                &fallback_events,
                "thread",
                "run",
                None,
            )
            .await
        });
        original_tx
            .send(envelope(1, started("original")))
            .await
            .unwrap();
        original_tx
            .send(envelope(
                2,
                AgentEvent::TextDelta {
                    assistant_message_id: Some(fixture_assistant_message_id()),
                    delta: "original draft".into(),
                },
            ))
            .await
            .unwrap();
        assert_eq!(
            events_rx.recv().await.unwrap().payload["textDelta"],
            "original draft"
        );
        // More than a native observer's capacity must drain while its
        // presentation waits for the original committed terminal.
        tokio::time::timeout(Duration::from_secs(5), async {
            fallback_tx
                .send(envelope(10, started("fallback")))
                .await
                .unwrap();
            for seq in 11..311 {
                fallback_tx
                    .send(envelope(seq, AgentEvent::TextDelta { assistant_message_id: Some(fixture_assistant_message_id()), delta: "f".into() }))
                    .await
                    .unwrap();
            }
            fallback_tx
                .send(envelope(311, completed("fallback authoritative")))
                .await
                .unwrap();
        })
        .await
        .expect("fallback native stream must drain independently");
        drop(fallback_tx);
        assert!(
            events_rx.try_recv().is_err(),
            "fallback must not overwrite original live segment"
        );
        original_tx
            .send(envelope(3, completed("original authoritative")))
            .await
            .unwrap();
        drop(original_tx);
        let (original_outcome, fallback_outcome) =
            tokio::time::timeout(Duration::from_secs(5), async {
                tokio::join!(original, fallback)
            })
            .await
            .unwrap();
        assert!(matches!(original_outcome.unwrap(), (None, true, true)));
        assert!(matches!(fallback_outcome.unwrap(), (None, true, true)));
        let mut finals = Vec::new();
        let mut fallback_delta_count = 0;
        while let Ok(event) = events_rx.try_recv() {
            if event.kind == "run.output.complete" {
                finals.push(event.payload["text"].as_str().unwrap().to_owned());
            } else if event.kind == "run.output.delta" {
                assert_eq!(finals, ["original authoritative"]);
                fallback_delta_count += 1;
            }
        }
        assert_eq!(finals, ["original authoritative", "fallback authoritative"]);
        assert_eq!(fallback_delta_count, 300);
    }

    #[tokio::test]
    async fn rejected_cancellation_preserves_active_run_and_durable_status() {
        let fixture =
            std::env::temp_dir().join(format!("meerkat-cancel-rejected-{}", Uuid::new_v4()));
        let project_path = fixture.join("project");
        let state_root = fixture.join("state");
        std::fs::create_dir_all(&project_path).unwrap();
        let gateway = MeerkatGateway::new();
        let handle = gateway
            .project_runtime_handle_for_paths(
                project_path.to_str().unwrap(),
                project_path.to_str().unwrap(),
                "local".to_string(),
                Some(state_root.to_str().unwrap()),
            )
            .await
            .unwrap();
        let forwarding_task = tokio::spawn(std::future::pending::<()>());
        {
            let mut state = handle.state.lock().await;
            state
                .mobkit
                .insert_remote_tcp(
                    "remote-mob".into(),
                    "Remote".into(),
                    "127.0.0.1:1".into(),
                    None,
                )
                .await.unwrap();
            state.active_runs.insert(
                "thread-cancel".into(),
                ActiveRun {
                    run_id: "run-cancel".into(),
                    mob_id: "remote-mob".into(),
                    agent_identity: "ingress".into(),
                    started_at: chrono::Utc::now(),
                    deliveries: AppRunDeliveries::default(),
                    projection: Arc::new(Mutex::new(RunEventProjection::default())),
                },
            );
        }
        let mut events = gateway.subscribe_events();
        let response = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".into(),
                    id: Some(RpcId::String("cancel".into())),
                    method: "mobs.v1.forceCancel".into(),
                    params: Some(serde_json::json!({
                        "projectPath":project_path,"stateRoot":state_root,
                        "threadId":"thread-cancel","runId":"run-cancel","mobId":"remote-mob",
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert!(
            response.error.is_some(),
            "unbound remote runtime cannot confirm cancellation"
        );
        assert!(handle
            .state
            .lock()
            .await
            .active_runs
            .contains_key("thread-cancel"));
        assert!(
            !forwarding_task.is_finished(),
            "failed cancellation must preserve event forwarding"
        );
        assert!(
            events.try_recv().is_err(),
            "failed cancellation must not emit terminal events"
        );
        assert!(super::lookup_terminal_run(&state_root, "run-cancel").is_none());
        forwarding_task.abort();
        let _ = forwarding_task.await;
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[tokio::test]
    async fn app_run_waits_for_all_deliveries_and_deduplicates_native_events() {
        let fixture = std::env::temp_dir().join(format!("meerkat-deliveries-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&fixture).unwrap();
        let gateway = MeerkatGateway::new();
        let handle = gateway
            .project_runtime_handle_for_paths(
                fixture.to_str().unwrap(),
                fixture.to_str().unwrap(),
                "local".into(),
                Some(fixture.join("state").to_str().unwrap()),
            )
            .await
            .unwrap();
        let projection = Arc::new(Mutex::new(RunEventProjection::default()));
        handle.state.lock().await.active_runs.insert(
            "thread".into(),
            ActiveRun {
                run_id: "run".into(),
                mob_id: "mob".into(),
                agent_identity: "ingress".into(),
                started_at: chrono::Utc::now(),
                deliveries: AppRunDeliveries {
                    pending: 2,
                    ..Default::default()
                },
                projection: Arc::clone(&projection),
            },
        );
        let (tx, mut rx) = tokio::sync::broadcast::channel(16);
        let delta = EventEnvelope::new_session(
            SessionId::new(),
            1,
            None,
            AgentEvent::TextDelta {
                assistant_message_id: Some(fixture_assistant_message_id()),
                delta: "one native delta".into(),
            },
        );
        super::project_run_event(&projection, &delta, "thread", "run", &tx)
            .await
            .unwrap();
        super::project_run_event(&projection, &delta, "thread", "run", &tx)
            .await
            .unwrap();
        assert_eq!(rx.try_recv().unwrap().kind, "run.output.delta");
        assert!(rx.try_recv().is_err());
        finish_run(
            &tx,
            &handle,
            "thread",
            "run",
            "mob",
            "ingress",
            fixture.to_str().unwrap(),
            fixture.to_str().unwrap(),
            "local",
            gateway.inner.host_tools.as_ref(),
            Ok(()),
        )
        .await;
        assert!(
            rx.try_recv().is_err(),
            "original completion cannot close pending steering"
        );
        assert!(super::lookup_terminal_run(&fixture.join("state"), "run").is_none());
        assert_eq!(
            handle.state.lock().await.active_runs["thread"]
                .deliveries
                .pending,
            1
        );
        finish_run(
            &tx,
            &handle,
            "thread",
            "run",
            "mob",
            "ingress",
            fixture.to_str().unwrap(),
            fixture.to_str().unwrap(),
            "local",
            gateway.inner.host_tools.as_ref(),
            Err(super::RunFailure::Cancelled),
        )
        .await;
        assert_eq!(rx.try_recv().unwrap().kind, "run.cancelled");
        assert!(rx.try_recv().is_err());
        assert!(handle.state.lock().await.active_runs.is_empty());
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[tokio::test]
    async fn finalization_write_failure_fences_admission_and_retries_without_execution() {
        let fixture = std::env::temp_dir().join(format!("meerkat-finalization-{}", Uuid::new_v4()));
        let root = fixture.join("state");
        std::fs::create_dir_all(root.join("runs.jsonl")).unwrap();
        let gateway = MeerkatGateway::new();
        let handle = gateway.project_runtime_handle_for_paths(fixture.to_str().unwrap(), fixture.to_str().unwrap(), "local".into(), Some(root.to_str().unwrap())).await.unwrap();
        handle.state.lock().await.active_runs.insert("thread".into(), ActiveRun {
            run_id: "run".into(), mob_id: "mob".into(), agent_identity: "ingress".into(), started_at: chrono::Utc::now(),
            deliveries: AppRunDeliveries::default(), projection: Arc::new(Mutex::new(RunEventProjection::default())),
        });
        let mut events = gateway.subscribe_events();
        finish_run(&gateway.inner.events_tx, &handle, "thread", "run", "mob", "ingress", fixture.to_str().unwrap(), fixture.to_str().unwrap(), "local", gateway.inner.host_tools.as_ref(), Ok(())).await;
        assert_eq!(events.try_recv().unwrap().payload["deliveryStatus"], "needs_recovery");
        let original_event = handle.state.lock().await.active_runs["thread"].deliveries.pending_finalization.as_ref().unwrap().event.clone();
        assert!(admit_active_run_locked(&mut *handle.state.lock().await, "thread", || panic!("must not start new work")).is_err());
        let params = serde_json::json!({"projectPath":fixture,"stateRoot":root,"threadId":"thread","mobId":"mob","runId":"run"});
        let status = gateway.mobs_run_status(Some(&params)).await.unwrap();
        assert_eq!(status["status"], "unknown");
        assert_eq!(status["canRecover"], false);
        assert!(gateway.mobs_force_cancel(Some(&params)).await.is_err());
        assert!(events.try_recv().is_err(), "repeated failure is not another terminal");
        assert!(!gateway.shutdown().await.is_empty(), "delivery failure cannot become a successful shutdown receipt");
        std::fs::remove_dir(root.join("runs.jsonl")).unwrap();
        let status = gateway.mobs_run_status(Some(&params)).await.unwrap();
        assert_eq!(status["status"], "completed");
        let terminal = events.try_recv().unwrap();
        assert_eq!(terminal.kind, "run.completed");
        assert_eq!(terminal.event_id, original_event.event_id);
        assert_eq!(terminal.timestamp, original_event.timestamp);
        assert!(handle.state.lock().await.active_runs.is_empty());
        assert_eq!(gateway.mobs_run_status(Some(&params)).await.unwrap()["status"], "completed");
        assert!(events.try_recv().is_err());
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[tokio::test]
    async fn finalization_cancellation_wins_over_delivery_failure_in_either_order() {
        for cancel_first in [false, true] {
            let fixture = std::env::temp_dir().join(format!("meerkat-final-status-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&fixture).unwrap();
            let gateway = MeerkatGateway::new();
            let root = fixture.join("state");
            let handle = gateway.project_runtime_handle_for_paths(fixture.to_str().unwrap(), fixture.to_str().unwrap(), "local".into(), Some(root.to_str().unwrap())).await.unwrap();
            handle.state.lock().await.active_runs.insert("thread".into(), ActiveRun {
                run_id: "run".into(), mob_id: "mob".into(), agent_identity: "ingress".into(), started_at: chrono::Utc::now(),
                deliveries: AppRunDeliveries { pending: 2, ..Default::default() }, projection: Arc::new(Mutex::new(RunEventProjection::default())),
            });
            let failures = if cancel_first {
                [super::RunFailure::Cancelled, super::RunFailure::Delivery("disk".into())]
            } else {
                [super::RunFailure::Delivery("disk".into()), super::RunFailure::Cancelled]
            };
            let mut events = gateway.subscribe_events();
            for failure in failures {
                finish_run(&gateway.inner.events_tx, &handle, "thread", "run", "mob", "ingress", fixture.to_str().unwrap(), fixture.to_str().unwrap(), "local", gateway.inner.host_tools.as_ref(), Err(failure)).await;
            }
            assert_eq!(events.try_recv().unwrap().kind, "run.cancelled");
            assert_eq!(super::lookup_terminal_run(&root, "run").unwrap()["status"], "cancelled");
            assert!(events.try_recv().is_err());
            std::fs::remove_dir_all(fixture).unwrap();
        }
    }

    #[tokio::test]
    async fn native_steering_failure_cannot_complete_a_run_in_either_delivery_order() {
        use meerkat_runtime::completion::{CompletionOutcome, CompletionWaitError};
        let session = SessionId::new();
        let wrong_session_result = serde_json::from_value(json!({
            "session_id": SessionId::new(), "text": "Done", "usage": Usage::default(),
            "turns": 1, "tool_calls": 0,
        })).unwrap();
        let mut failures = vec![
            ("wrong_session", super::native_steering::completion_result(&session, Ok(CompletionOutcome::Completed(Box::new(wrong_session_result))))),
            ("native_finalization", super::native_steering::completion_result(&session, Ok(CompletionOutcome::CompletedWithFinalizationFailure {
                error: meerkat_core::TurnErrorMetadata::runtime_apply_failure("native durable commit failed"),
            }))),
            ("callback", super::native_steering::completion_result(&session, Ok(CompletionOutcome::CallbackPending {
                tool_use_id: "callback".into(), tool_name: "external_tool".into(), args: json!({}),
            }))),
            ("callback_batch", super::native_steering::completion_result(&session, Ok(CompletionOutcome::CallbackBatchPending { pending_tool_calls: vec![] }))),
            ("channel_closed", super::native_steering::completion_result(&session, Err(CompletionWaitError::ChannelClosed))),
            ("attachment_replaced", super::native_steering::completion_result(&session, Err(CompletionWaitError::AttachmentReplaced))),
            ("authority_unavailable", super::native_steering::completion_result(&session, Err(CompletionWaitError::AuthorityUnavailable("completion authority missing".into())))),
        ];
        failures.push(("missing_witness", super::native_steering::wait(super::native_steering::Admission {
            session: session.clone(), input_id: meerkat_core::InputId::new(), completion: None,
        }).await));
        for (case, result) in failures {
            let failure = result.expect_err(case);
            assert!(matches!(&failure, super::RunFailure::Failed(_)), "{case}: native failure must not be a repairable projection delivery");
            for steer_first in [false, true] {
                let fixture = std::env::temp_dir().join(format!("meerkat-steering-terminal-{}", Uuid::new_v4()));
                std::fs::create_dir_all(&fixture).unwrap();
                let gateway = MeerkatGateway::new();
                let root = fixture.join("state");
                let handle = gateway.project_runtime_handle_for_paths(fixture.to_str().unwrap(), fixture.to_str().unwrap(), "local".into(), Some(root.to_str().unwrap())).await.unwrap();
                handle.state.lock().await.active_runs.insert("thread".into(), ActiveRun {
                    run_id: "run".into(), mob_id: "mob".into(), agent_identity: "ingress".into(), started_at: chrono::Utc::now(),
                    deliveries: AppRunDeliveries { pending: 2, ..Default::default() }, projection: Arc::new(Mutex::new(RunEventProjection::default())),
                });
                let deliveries = if steer_first { [Err(failure.clone()), Ok(())] } else { [Ok(()), Err(failure.clone())] };
                let mut events = gateway.subscribe_events();
                for (index, result) in deliveries.into_iter().enumerate() {
                    finish_run(&gateway.inner.events_tx, &handle, "thread", "run", "mob", "ingress", fixture.to_str().unwrap(), fixture.to_str().unwrap(), "local", gateway.inner.host_tools.as_ref(), result).await;
                    if index == 0 {
                        assert!(events.try_recv().is_err(), "{case}: first delivery must retain the other reservation");
                        assert!(super::lookup_terminal_run(&root, "run").is_none());
                        assert_eq!(handle.state.lock().await.active_runs["thread"].deliveries.pending, 1);
                    }
                }
                let terminal = events.try_recv().unwrap();
                assert_eq!(terminal.kind, "run.failed", "{case}, steer_first={steer_first}");
                assert_eq!(terminal.run_id.as_deref(), Some("run"));
                assert_eq!(super::lookup_terminal_run(&root, "run").unwrap()["status"], "failed", "{case}, steer_first={steer_first}");
                assert!(handle.state.lock().await.active_runs.is_empty());
                assert!(events.try_recv().is_err(), "{case}: exactly one application terminal");
                std::fs::remove_dir_all(fixture).unwrap();
            }
        }
    }

    #[tokio::test]
    async fn final_output_write_failure_retries_delivery_without_replaying_native_work() {
        let fixture = std::env::temp_dir().join(format!("meerkat-output-retry-{}", Uuid::new_v4()));
        let root = fixture.join("state");
        std::fs::create_dir_all(&root).unwrap();
        let gateway = MeerkatGateway::new();
        let handle = gateway.project_runtime_handle_for_paths(fixture.to_str().unwrap(), fixture.to_str().unwrap(), "local".into(), Some(root.to_str().unwrap())).await.unwrap();
        let session = SessionId::new();
        let attribution = super::thread_followups::Attribution {
            state_root: root.clone(), thread_id: "thread".into(), mob_id: "mob".into(),
            session_id: session.to_string(), run_id: "run".into(),
        };
        super::thread_followups::begin(&attribution).unwrap();
        let projection = Arc::new(Mutex::new(RunEventProjection { delivery_scope: Some(attribution.clone()), followup: Some(attribution), ..Default::default() }));
        handle.state.lock().await.active_runs.insert("thread".into(), ActiveRun {
            run_id: "run".into(), mob_id: "mob".into(), agent_identity: "ingress".into(), started_at: chrono::Utc::now(),
            deliveries: AppRunDeliveries::default(), projection: Arc::clone(&projection),
        });
        std::fs::write(root.join("thread-deliveries"), "fault injection").unwrap();
        let mut events = gateway.subscribe_events();
        let event = EventEnvelope::new_session(session.clone(), 1, None, AgentEvent::RunCompleted {
            identity: Default::default(),
            assistant_message_id: Some(fixture_assistant_message_id()),
            session_id: session, result: "The exact native final result".into(), structured_output: None,
            extraction_required: false, usage: Default::default(), terminal_cause_kind: None,
        });
        let failed = super::project_run_event(&projection, &event, "thread", "run", &gateway.inner.events_tx).await.unwrap_err();
        assert!(matches!(&failed, super::RunFailure::Delivery(_)));
        finish_run(&gateway.inner.events_tx, &handle, "thread", "run", "mob", "ingress", fixture.to_str().unwrap(), fixture.to_str().unwrap(), "local", gateway.inner.host_tools.as_ref(), Err(failed)).await;
        assert_eq!(events.try_recv().unwrap().payload["deliveryStatus"], "needs_recovery");
        assert!(events.try_recv().is_err(), "an unpersisted answer cannot be published");
        assert_eq!(projection.lock().await.pending_events.len(), 1);
        assert!(super::lookup_terminal_run(&root, "run").is_none());
        assert!(admit_active_run_locked(&mut *handle.state.lock().await, "thread", || panic!("must not execute again")).is_err());
        std::fs::remove_file(root.join("thread-deliveries")).unwrap();
        let params = serde_json::json!({"projectPath":fixture,"stateRoot":root,"threadId":"thread","mobId":"mob"});
        let replay = gateway.mobs_thread_deliveries(Some(&params), false).await.unwrap();
        assert_eq!(replay["events"].as_array().unwrap().len(), 2);
        assert_eq!(replay["events"][0]["kind"], "run.output.complete");
        assert_eq!(replay["events"][0]["payload"]["text"], "The exact native final result");
        assert_eq!(replay["events"][0]["payload"]["nativeSourceEventId"], format!("evt-agent-{}", event.event_id));
        assert_eq!(replay["events"][1]["kind"], "run.completed");
        assert_eq!(events.try_recv().unwrap().kind, "run.output.complete");
        assert_eq!(events.try_recv().unwrap().kind, "run.completed");
        assert!(handle.state.lock().await.active_runs.is_empty());
        assert!(projection.lock().await.pending_events.is_empty());
        assert_eq!(gateway.mobs_thread_deliveries(Some(&params), false).await.unwrap(), replay);
        assert!(events.try_recv().is_err(), "delivery retries do not publish another live terminal");
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[tokio::test]
    async fn only_typed_runtime_cancellation_writes_cancelled_terminal() {
        let fixture =
            std::env::temp_dir().join(format!("meerkat-cancel-terminal-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&fixture).unwrap();
        let gateway = MeerkatGateway::new();
        let handle = gateway
            .project_runtime_handle_for_paths(
                fixture.to_str().unwrap(),
                fixture.to_str().unwrap(),
                "local".to_string(),
                Some(fixture.join("state").to_str().unwrap()),
            )
            .await
            .unwrap();
        let forwarding_task = tokio::spawn(std::future::pending::<()>());
        handle.state.lock().await.active_runs.insert(
            "thread-cancel".into(),
            ActiveRun {
                run_id: "run-cancel".into(),
                mob_id: "mob-cancel".into(),
                agent_identity: "ingress".into(),
                started_at: chrono::Utc::now(),
                deliveries: AppRunDeliveries::default(),
                projection: Arc::new(Mutex::new(RunEventProjection::default())),
            },
        );
        let (events_tx, mut events) = tokio::sync::broadcast::channel(4);
        let envelope = EventEnvelope::new_session(
            SessionId::new(),
            1,
            None,
            AgentEvent::RunFailed {
                identity: Default::default(),
                session_id: SessionId::new(),
                error_report: meerkat_core::event::AgentErrorReport {
                    class: meerkat_core::event::AgentErrorClass::Cancelled,
                    reason: None,
                    message: "localized display text".into(),
                },
                terminal_cause_kind: None,
            },
        );
        let failure = process_agent_event_envelope(
            &envelope,
            "thread-cancel",
            "run-cancel",
            &mut LiveEventAssembler::default(),
            &events_tx,
            &mut false,
        )
        .expect_err("runtime cancellation is terminal");
        assert!(matches!(failure, super::RunFailure::Cancelled));
        assert!(events.try_recv().is_err());
        finish_run(
            &events_tx,
            &handle,
            "thread-cancel",
            "run-cancel",
            "mob-cancel",
            "ingress",
            fixture.to_str().unwrap(),
            fixture.to_str().unwrap(),
            "local",
            gateway.inner.host_tools.as_ref(),
            Err(failure),
        )
        .await;
        assert_eq!(events.try_recv().unwrap().kind, "run.cancelled");
        assert!(events.try_recv().is_err());
        assert_eq!(
            super::lookup_terminal_run(&fixture.join("state"), "run-cancel").unwrap()["status"],
            "cancelled"
        );
        assert!(handle.state.lock().await.active_runs.is_empty());
        forwarding_task.abort();
        let _ = forwarding_task.await;
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn effective_catalog_and_turn_identity_overrides_are_typed_and_fail_closed() {
        let config = meerkat::Config::default();
        let catalog = effective_models_catalog(&config).expect("effective catalog");
        let providers = catalog["providers"].as_array().expect("catalog providers");
        let default_for = |provider: &str| {
            providers
                .iter()
                .find(|entry| entry["provider"] == provider)
                .and_then(|entry| entry["default_model_id"].as_str())
        };
        let registry = config
            .model_registry(meerkat_models::canonical())
            .expect("effective registry");
        for provider in [Provider::Anthropic, Provider::OpenAI, Provider::Gemini] {
            assert_eq!(
                default_for(provider.as_str()),
                registry.default_model(provider)
            );
        }

        let valid_value = serde_json::json!({
            "model": "gpt-5.6-sol",
            "provider": "openai",
            "providerParams": {"reasoning_effort": "xhigh"}
        });
        let valid = member_turn_options_from_params(
            valid_value.as_object().expect("valid params"),
            &config,
            Some(Provider::OpenAI),
        )
        .expect("valid typed OpenAI override");
        assert_eq!(
            valid.model.as_ref().map(|model| model.as_str()),
            Some("gpt-5.6-sol")
        );
        assert_eq!(valid.provider, Some(Provider::OpenAI));
        assert!(
            valid
                .auth_binding
                .as_ref()
                .is_some_and(TurnMetadataOverride::is_clear),
            "catalog selection must re-run Meerkat's credential candidate policy"
        );
        let Some(TurnMetadataOverride::Set(provider_params)) = valid.provider_params.as_ref()
        else {
            panic!("expected typed provider-parameter Set override");
        };
        let Some(ProviderTag::OpenAi(openai)) = provider_params.provider_tag.as_ref() else {
            panic!("expected typed OpenAI provider tag");
        };
        assert_eq!(openai.reasoning_effort, Some(ReasoningEffort::XHigh));

        let same_provider_value = serde_json::json!({
            "model": "gpt-5.4",
            "provider": "openai"
        });
        let same_provider = member_turn_options_from_params(
            same_provider_value
                .as_object()
                .expect("same-provider params"),
            &config,
            Some(Provider::OpenAI),
        )
        .expect("same-provider model selection");
        assert_eq!(
            same_provider.provider_params, None,
            "omission preserves provider params within one provider family"
        );

        let cross_provider_value = serde_json::json!({
            "model": "claude-opus-4-8",
            "provider": "anthropic"
        });
        let cross_provider = member_turn_options_from_params(
            cross_provider_value
                .as_object()
                .expect("cross-provider params"),
            &config,
            Some(Provider::OpenAI),
        )
        .expect("cross-provider model selection");
        assert!(
            cross_provider
                .provider_params
                .as_ref()
                .is_some_and(TurnMetadataOverride::is_clear),
            "provider-family switches must clear a stale foreign tag"
        );

        let explicit_clear_value = serde_json::json!({
            "model": "gpt-5.4",
            "provider": "openai",
            "providerParams": null
        });
        let explicit_clear = member_turn_options_from_params(
            explicit_clear_value
                .as_object()
                .expect("explicit-clear params"),
            &config,
            Some(Provider::OpenAI),
        )
        .expect("explicit provider-parameter clear");
        assert!(explicit_clear
            .provider_params
            .as_ref()
            .is_some_and(TurnMetadataOverride::is_clear));

        for invalid in [
            serde_json::json!({
                "model": "gpt-5.6-sol",
                "provider": "anthropic",
                "providerParams": null
            }),
            serde_json::json!({
                "model": "gpt-5.6-sol",
                "provider": "openai",
                "providerParams": {"reasoning_effort": "impossible"}
            }),
            serde_json::json!({
                "model": "gpt-5.6-sol",
                "provider": "openai",
                "providerParams": {"credential": "must-never-pass"}
            }),
            serde_json::json!({
                "provider": "openai",
                "providerParams": null
            }),
            serde_json::json!({
                "providerParams": {"reasoning_effort": "high"}
            }),
            serde_json::json!({
                "model": "gpt-5.6-sol",
                "provider": "openai",
                "providerParams": "high"
            }),
            serde_json::json!({
                "model": "not-a-real-model",
                "provider": "openai",
                "providerParams": null
            }),
        ] {
            assert!(
                member_turn_options_from_params(
                    invalid.as_object().expect("invalid params object"),
                    &config,
                    Some(Provider::OpenAI),
                )
                .is_err(),
                "invalid identity override unexpectedly passed: {invalid}"
            );
        }

        let unavailable_current_value = serde_json::json!({
            "model": "gpt-5.4",
            "provider": "openai"
        });
        assert!(
            member_turn_options_from_params(
                unavailable_current_value
                    .as_object()
                    .expect("unavailable-current params"),
                &config,
                None,
            )
            .is_err(),
            "omitted providerParams cannot be interpreted without current identity"
        );
    }

    #[test]
    fn desktop_config_projection_and_patch_surface_exclude_realm_credentials() {
        let mut config = meerkat::Config::default();
        config.realm.insert(
            "global".to_string(),
            meerkat_core::connection::RealmConfigSection::from_inline_api_keys(&[(
                "openai",
                "super-secret-inline-credential",
            )]),
        );
        let projection = desktop_runtime_config_projection(&config);
        let rendered = projection.to_string();
        assert!(!rendered.contains("super-secret-inline-credential"));
        assert!(projection.get("realm").is_none());
        assert!(projection.get("self_hosted").is_none());
        assert_eq!(
            projection
                .pointer("/agent/model")
                .and_then(serde_json::Value::as_str),
            Some(config.agent.model.as_str())
        );

        validate_desktop_config_patch(&serde_json::json!({
            "tools": {
                "builtins_enabled": true,
                "shell_enabled": true,
                "comms_enabled": true,
                "mob_enabled": true
            },
            "shell": {"security_mode": "unrestricted"}
        }))
        .expect("closed desktop patch");
        for privileged in [
            serde_json::json!({"realm": {"global": {"auth": {}}}}),
            serde_json::json!({"agent": {"model": "attacker-controlled"}}),
            serde_json::json!({"tools": {"mcp_servers": []}}),
            serde_json::json!({"shell": {"program": "/bin/sh"}}),
            serde_json::json!({"shell": {"security_mode": "sandboxed"}}),
        ] {
            assert!(
                validate_desktop_config_patch(&privileged).is_err(),
                "privileged/legacy patch unexpectedly passed: {privileged}"
            );
        }
    }

    #[test]
    fn config_rpc_persists_with_shared_cas_and_returns_only_safe_effective_fields() {
        std::thread::Builder::new()
            .name("desktop-config-cas-proof".to_string())
            .stack_size(32 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("build config CAS proof runtime")
                    .block_on(config_rpc_cas_proof());
            })
            .expect("spawn config CAS proof thread")
            .join()
            .expect("config CAS proof thread");
    }

    async fn config_rpc_cas_proof() {
        let fixture = std::env::temp_dir().join(format!(
            "meerkat-desktop-config-cas-{}",
            uuid::Uuid::new_v4()
        ));
        let project_path = fixture.join("project");
        let config_state_root = fixture.join("config-state");
        std::fs::create_dir_all(&project_path).expect("create config project");
        std::fs::create_dir_all(&config_state_root).expect("create config root");
        let project_path = project_path.to_string_lossy().to_string();
        let config_state_root = config_state_root.to_string_lossy().to_string();
        let gateway = MeerkatGateway::new();

        let get = |id: &str| RpcRequest {
            jsonrpc: "2.0".to_string(),
            id: Some(RpcId::String(id.to_string())),
            method: "configs.v1.get".to_string(),
            params: Some(serde_json::json!({
                "projectPath": project_path,
                "stateRoot": config_state_root,
            })),
        };
        let initial = gateway
            .handle(get("config-initial"), RequestContext::local())
            .await;
        assert!(initial.error.is_none(), "initial config read: {initial:?}");
        let initial_result = initial.result.as_ref().expect("initial config result");
        assert_eq!(
            initial_result
                .pointer("/config/envelope/generation")
                .and_then(serde_json::Value::as_u64),
            Some(0)
        );
        let safe_config = initial_result
            .pointer("/config/envelope/config")
            .expect("safe effective config");
        assert!(safe_config.get("realm").is_none());
        assert!(safe_config.get("self_hosted").is_none());
        assert_eq!(
            safe_config
                .as_object()
                .expect("safe config object")
                .keys()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>(),
            ["agent", "shell", "tools"]
                .into_iter()
                .map(str::to_string)
                .collect()
        );

        let patch = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String("config-patch".to_string())),
                    method: "configs.v1.patch".to_string(),
                    params: Some(serde_json::json!({
                        "projectPath": project_path,
                        "stateRoot": config_state_root,
                        "patch": {
                            "tools": {
                                "builtins_enabled": true,
                                "shell_enabled": true,
                                "comms_enabled": true,
                                "mob_enabled": true
                            }
                        },
                        "expectedGeneration": 0,
                        "idempotencyKey": "desktop-config-proof"
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert!(patch.error.is_none(), "config patch failed: {patch:?}");
        let patch_result = patch.result.as_ref().expect("config patch result");
        assert_eq!(
            patch_result
                .pointer("/config/envelope/generation")
                .and_then(serde_json::Value::as_u64),
            Some(1)
        );
        assert_eq!(
            patch_result
                .pointer("/config/envelope/config/tools/builtins_enabled")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );

        let stale = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String("config-stale".to_string())),
                    method: "configs.v1.patch".to_string(),
                    params: Some(serde_json::json!({
                        "projectPath": project_path,
                        "stateRoot": config_state_root,
                        "patch": {"tools": {"shell_enabled": false}},
                        "expectedGeneration": 0
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert_eq!(
            stale.error.as_ref().map(|error| error.data.code.as_str()),
            Some("CONFLICT")
        );
        assert_eq!(
            stale
                .error
                .as_ref()
                .and_then(|error| error.data.details.as_ref())
                .and_then(|details| details.get("currentGeneration"))
                .and_then(serde_json::Value::as_u64),
            Some(1)
        );

        let privileged = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String("config-privileged".to_string())),
                    method: "configs.v1.patch".to_string(),
                    params: Some(serde_json::json!({
                        "projectPath": project_path,
                        "stateRoot": config_state_root,
                        "patch": {
                            "realm": {
                                "global": {
                                    "auth": {
                                        "exfiltrate": {
                                            "source": {
                                                "kind": "inline_secret",
                                                "secret": "must-not-persist"
                                            }
                                        }
                                    }
                                }
                            }
                        },
                        "expectedGeneration": 1
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert_eq!(
            privileged
                .error
                .as_ref()
                .map(|error| error.data.code.as_str()),
            Some("INVALID_PARAMS")
        );

        let reread = gateway
            .handle(get("config-reread"), RequestContext::local())
            .await;
        let reread_result = reread.result.as_ref().expect("reread config result");
        assert_eq!(
            reread_result
                .pointer("/config/envelope/generation")
                .and_then(serde_json::Value::as_u64),
            Some(1)
        );
        assert_eq!(
            reread_result
                .pointer("/config/envelope/config/tools/shell_enabled")
                .and_then(serde_json::Value::as_bool),
            Some(true),
            "stale and privileged writes must not mutate the raw head"
        );
        assert!(!reread_result.to_string().contains("must-not-persist"));

        drop(gateway);
        let _ = std::fs::remove_dir_all(&fixture);
    }

    #[test]
    fn effective_realm_catalog_preserves_inherited_self_hosted_route_identity() {
        std::thread::Builder::new()
            .name("effective-realm-catalog-proof".to_string())
            .stack_size(32 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("build effective catalog proof runtime")
                    .block_on(effective_realm_catalog_proof());
            })
            .expect("spawn effective catalog proof thread")
            .join()
            .expect("effective catalog proof thread");
    }

    async fn effective_realm_catalog_proof() {
        use meerkat_core::connection::{RealmConfigSection, RealmId};
        use meerkat_core::{ConfigStore, FileConfigStore};

        let fixture = std::env::temp_dir().join(format!(
            "meerkat-effective-catalog-{}",
            uuid::Uuid::new_v4()
        ));
        let project_path = fixture.join("project");
        let config_state_root = fixture.join("config-state");
        std::fs::create_dir_all(&project_path).expect("create catalog project");
        std::fs::create_dir_all(&config_state_root).expect("create catalog root");
        let head_id = RealmId::parse(&meerkat_core::derive_workspace_realm_id(&project_path))
            .expect("workspace realm id");
        let parent_id = RealmId::parse("desktop-catalog-parent").expect("parent realm id");

        let mut parent = meerkat::Config::default();
        parent
            .realm
            .insert(parent_id.to_string(), RealmConfigSection::default());
        parent.self_hosted.servers.insert(
            "studio-server".to_string(),
            meerkat_core::SelfHostedServerConfig {
                base_url: "http://127.0.0.1:11434/v1".to_string(),
                ..Default::default()
            },
        );
        parent.self_hosted.models.insert(
            "studio-reasoner".to_string(),
            meerkat_core::SelfHostedModelConfig {
                server: "studio-server".to_string(),
                remote_model: "studio/reasoner".to_string(),
                display_name: "Studio Reasoner".to_string(),
                family: "studio".to_string(),
                supports_reasoning: true,
                ..Default::default()
            },
        );
        parent.self_hosted.default_model = Some("studio-reasoner".to_string());
        FileConfigStore::new(
            config_state_root
                .join(parent_id.as_str())
                .join("config.toml"),
            meerkat_models::canonical(),
        )
        .set(parent)
        .await
        .expect("persist parent config");

        let head_config_path = config_state_root.join(head_id.as_str()).join("config.toml");
        std::fs::create_dir_all(head_config_path.parent().expect("head config parent"))
            .expect("create head config parent");
        tokio::fs::write(
            &head_config_path,
            format!(
                "[realm.{}]\nparent = \"{}\"\n",
                head_id.as_str(),
                parent_id.as_str()
            ),
        )
        .await
        .expect("persist presence-minimal head config");

        let effective =
            crate::mobkit_registry::load_effective_realm_config(&project_path, &config_state_root)
                .await
                .expect("compose inherited realm config");
        let catalog = effective_models_catalog(&effective.effective).expect("effective catalog");
        let inherited_model = catalog["providers"]
            .as_array()
            .expect("catalog providers")
            .iter()
            .find(|provider| provider["provider"] == "self_hosted")
            .and_then(|provider| provider["models"].as_array())
            .and_then(|models| models.iter().find(|model| model["id"] == "studio-reasoner"))
            .expect("inherited self-hosted model");
        assert_eq!(inherited_model["server_id"], "studio-server");
        assert_eq!(inherited_model["display_name"], "Studio Reasoner");

        let runtime = crate::mobkit_registry::realm_config_runtime(&effective, &config_state_root);
        let patched = runtime
            .patch(
                meerkat_core::ConfigDelta(serde_json::json!({
                    "tools": {"shell_enabled": true}
                })),
                Some(0),
            )
            .await
            .expect("patch unrelated head policy");
        assert_eq!(patched.generation, 1);
        let persisted_head = tokio::fs::read_to_string(&head_config_path)
            .await
            .expect("read patched head config");
        assert!(
            !persisted_head.contains("self_hosted"),
            "unrelated patch must not materialize an inherited self-hosted tombstone"
        );

        let reloaded =
            crate::mobkit_registry::load_effective_realm_config(&project_path, &config_state_root)
                .await
                .expect("reload inherited realm config after patch");
        let reloaded_catalog =
            effective_models_catalog(&reloaded.effective).expect("reloaded effective catalog");
        let inherited_after_patch = reloaded_catalog["providers"]
            .as_array()
            .expect("reloaded catalog providers")
            .iter()
            .find(|provider| provider["provider"] == "self_hosted")
            .and_then(|provider| provider["models"].as_array())
            .and_then(|models| models.iter().find(|model| model["id"] == "studio-reasoner"))
            .expect("inherited self-hosted model after unrelated patch");
        assert_eq!(inherited_after_patch["server_id"], "studio-server");
        assert_eq!(inherited_after_patch["display_name"], "Studio Reasoner");

        let _ = std::fs::remove_dir_all(&fixture);
    }

    /// Deterministic model used only by the end-to-end MobKit host-tool proofs
    /// below. Each turn requests a fixed number of synthetic host calls before
    /// emitting a final answer after their results are committed.
    struct ScriptedHostToolLlm {
        tool_calls_per_turn: usize,
        streams: AtomicUsize,
        tool_surface_observations: AtomicUsize,
        missing_tool_surface_observations: AtomicUsize,
        missing_tool_error_observations: AtomicUsize,
        capability_error_observations: AtomicUsize,
        host_disconnected_observations: AtomicUsize,
        native_mob_prompt_observations: AtomicUsize,
        observed_requests: std::sync::Mutex<Vec<String>>,
        block_next: std::sync::Mutex<Option<Arc<tokio::sync::Notify>>>,
        blocked_started: tokio::sync::Notify,
        stop_probe_steering: std::sync::Mutex<Option<String>>,
        stop_probe_observed: tokio::sync::Notify,
    }

    impl ScriptedHostToolLlm {
        fn new(tool_calls_per_turn: usize) -> Self {
            Self {
                tool_calls_per_turn,
                streams: AtomicUsize::new(0),
                tool_surface_observations: AtomicUsize::new(0),
                missing_tool_surface_observations: AtomicUsize::new(0),
                missing_tool_error_observations: AtomicUsize::new(0),
                capability_error_observations: AtomicUsize::new(0),
                host_disconnected_observations: AtomicUsize::new(0),
                native_mob_prompt_observations: AtomicUsize::new(0),
                observed_requests: std::sync::Mutex::new(Vec::new()),
                block_next: std::sync::Mutex::new(None),
                blocked_started: tokio::sync::Notify::new(),
                stop_probe_steering: std::sync::Mutex::new(None),
                stop_probe_observed: tokio::sync::Notify::new(),
            }
        }

        fn advance_after_interrupted_turn(&self) {
            let cycle_length = self.tool_calls_per_turn + 1;
            let current = self.streams.load(Ordering::SeqCst);
            let remainder = current % cycle_length;
            if remainder != 0 {
                self.streams
                    .fetch_add(cycle_length - remainder, Ordering::SeqCst);
            }
        }
    }

    #[async_trait::async_trait]
    impl meerkat::LlmClient for ScriptedHostToolLlm {
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
            let messages = serde_json::to_string(&request.messages).unwrap_or_default();
            self.observed_requests
                .lock()
                .unwrap()
                .push(messages.clone());
            if messages.contains("running on Meerkat MobKit") {
                for tool_name in [
                    "delegate",
                    "mob_check_member",
                    "mob_create",
                    "mob_spawn_member",
                ] {
                    assert!(
                        request
                            .tools
                            .iter()
                            .any(|tool| tool.name.as_str() == tool_name),
                        "thread prompt advertised unavailable native tool {tool_name}"
                    );
                }
                if !request
                    .tools
                    .iter()
                    .any(|tool| tool.name.as_str() == "spawn_flow")
                {
                    assert!(
                        !messages.contains("`spawn_flow`"),
                        "headless thread advertises desktop flow tool"
                    );
                }
                self.native_mob_prompt_observations
                    .fetch_add(1, Ordering::SeqCst);
            }
            let stream_index = self.streams.fetch_add(1, Ordering::SeqCst);
            let stop_probe_steering = self.stop_probe_steering.lock().unwrap().clone();
            if stop_probe_steering.as_ref().is_some_and(|marker| messages.contains(marker)) {
                // Stop must interrupt the request that already observed joined steering,
                // rather than leave an accepted-but-queued input to start a successor.
                self.stop_probe_observed.notify_one();
                return Box::pin(futures_util::stream::pending());
            }
            let cycle_length = self.tool_calls_per_turn + 1;
            let turn_index = stream_index / cycle_length;
            let turn_phase = stream_index % cycle_length;
            let events = if stop_probe_steering.is_some() {
                assert!(stream_index < 25, "steering never reached a native cooperative boundary");
                assert!(request.tools.iter().any(|tool| tool.name.as_str() == "peers"));
                vec![
                    meerkat::LlmEvent::ToolCallComplete {
                        id: format!("stop-probe-peers-{stream_index}"),
                        name: "peers".into(),
                        args: json!({}),
                        meta: None,
                    },
                    meerkat::LlmEvent::Done {
                        outcome: meerkat::LlmDoneOutcome::Success {
                            stop_reason: meerkat_core::StopReason::ToolUse,
                        },
                    },
                ]
            } else if turn_phase < self.tool_calls_per_turn {
                let tool_visible = request
                    .tools
                    .iter()
                    .any(|tool| tool.name.as_str() == "synthetic_counter");
                if tool_visible {
                    self.tool_surface_observations
                        .fetch_add(1, Ordering::SeqCst);
                } else {
                    self.missing_tool_surface_observations
                        .fetch_add(1, Ordering::SeqCst);
                }
                vec![
                    meerkat::LlmEvent::ToolCallComplete {
                        id: format!("synthetic-call-{}-{}", turn_index + 1, turn_phase + 1),
                        name: "synthetic_counter".to_string(),
                        args: serde_json::json!({"increment": 7 + (turn_phase as i64 * 4)}),
                        meta: None,
                    },
                    meerkat::LlmEvent::Done {
                        outcome: meerkat::LlmDoneOutcome::Success {
                            stop_reason: meerkat_core::StopReason::ToolUse,
                        },
                    },
                ]
            } else {
                let messages = serde_json::to_string(&request.messages).unwrap_or_default();
                if request.messages.iter().rev().find_map(|message| match message {
                    meerkat_core::Message::ToolResults { results, .. } => results.last(),
                    _ => None,
                }).is_some_and(|result| result.is_error
                    && serde_json::from_str::<Value>(&result.text_content())
                        .is_ok_and(|value| value["error"] == "tool_not_found")) {
                    self.missing_tool_error_observations.fetch_add(1, Ordering::SeqCst);
                }
                if messages.contains("CAPABILITY_UNAVAILABLE") {
                    self.capability_error_observations
                        .fetch_add(1, Ordering::SeqCst);
                }
                if messages.contains("HOST_DISCONNECTED") {
                    self.host_disconnected_observations
                        .fetch_add(1, Ordering::SeqCst);
                }
                vec![
                    meerkat::LlmEvent::TextDelta {
                        delta: "Synthetic host tool completed.".to_string(),
                        meta: None,
                    },
                    meerkat::LlmEvent::Done {
                        outcome: meerkat::LlmDoneOutcome::Success {
                            stop_reason: meerkat_core::StopReason::EndTurn,
                        },
                    },
                ]
            };
            let gate = self.block_next.lock().unwrap().take();
            if let Some(gate) = gate {
                use futures_util::StreamExt;
                self.blocked_started.notify_one();
                Box::pin(futures_util::stream::once(async move {
                    gate.notified().await;
                    futures_util::stream::iter(events.into_iter().map(Ok))
                }).flatten())
            } else {
                Box::pin(futures_util::stream::iter(events.into_iter().map(Ok)))
            }
        }

        fn provider(&self) -> meerkat_core::Provider {
            meerkat_core::Provider::Other
        }

        async fn health_check(&self) -> Result<(), meerkat::LlmError> {
            Ok(())
        }
    }

    fn synthetic_counter_definition() -> serde_json::Value {
        serde_json::json!({
            "name": "synthetic_counter",
            "description": "Increment a deterministic host-owned counter",
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["increment"],
                "properties": {"increment": {"type": "integer"}}
            },
            "resultSchema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["total"],
                "properties": {"total": {"type": "integer"}}
            },
            "capabilityErrorSchema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["version", "code", "retryability"],
                "properties": {
                    "version": {"type": "string"},
                    "code": {"type": "string"},
                    "retryability": {"type": "string"}
                }
            }
        })
    }

    async fn configure_synthetic_host_tool(
        gateway: &MeerkatGateway,
        request_id: &str,
        enabled: bool,
    ) -> meerkat_desktop_contracts::RpcResponse {
        gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String(request_id.to_string())),
                    method: "desktop.hostTools.configure.v1".to_string(),
                    params: Some(serde_json::json!({
                        "protocolVersion": 1,
                        "enabled": enabled,
                        "toolDefinitions": if enabled {
                            vec![synthetic_counter_definition()]
                        } else {
                            Vec::new()
                        }
                    })),
                },
                RequestContext::local(),
            )
            .await
    }

    fn real_mobkit_fixture_mob_id(project_path: &str) -> String {
        format!(
            "mob-{}",
            meerkat_core::derive_workspace_realm_id(std::path::Path::new(project_path))
        )
    }

    #[tokio::test]
    async fn native_media_upload_reaches_multimodal_llm_and_reads_back() {
        use base64::Engine as _;
        let (fixture,project,state,gateway,llm)=setup_real_mobkit_host_tool_fixture("multimodal-input",1).await;
        let mob_id=real_mobkit_fixture_mob_id(&project);
        let encoded=base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nfixture");
        let uploaded=gateway.mobs_image_upload(Some(&json!({"projectPath":project,"stateRoot":state,"mobId":mob_id,"mediaType":"image/png","dataBase64":encoded}))).await.expect("upload");
        let blob=uploaded["blob"]["blobId"].as_str().unwrap();
        llm.advance_after_interrupted_turn();
        llm.streams.store(1,Ordering::SeqCst); // The deterministic model now emits its answer without a tool.
        let mut events=gateway.subscribe_events();
        let receipt=gateway.mobs_turn_start(Some(&json!({"projectPath":project,"stateRoot":state,"mobId":mob_id,"threadId":"image-thread","input":[{"type":"image","media_type":"image/png","source":"blob","blob_id":blob}]}))).await.expect("image turn");
        wait_for_real_mobkit_terminal_event(&mut events,receipt["runId"].as_str().unwrap(),"run.completed").await;
        assert!(llm.observed_requests.lock().unwrap().iter().any(|request|request.contains(&encoded)&&request.contains("image/png")),"native model must receive hydrated image content");
        let read=gateway.mobs_image_read(Some(&json!({"projectPath":project,"stateRoot":state,"mobId":mob_id,"blobId":blob}))).await.expect("read");
        assert_eq!(read["dataBase64"],encoded);
        let mut projected=json!({"content":[{"type":"image","media_type":"image/png","source":"inline","data":encoded}]});
        super::media::reference_inline_images(&mut projected);
        assert_eq!(projected["content"][0]["blob_id"],blob);
        assert!(projected["content"][0].get("data").is_none());
        let handle=gateway.project_runtime_handle_for_paths(&project,&project,"local".into(),Some(&state)).await.unwrap();
        assert!(handle.state.lock().await.mobkit.remove(&mob_id).await.unwrap());
        let reloaded = MeerkatGateway::new();
        let read_after_reload = reloaded.mobs_image_read(Some(&json!({"projectPath":project,"stateRoot":state,"mobId":mob_id,"blobId":blob}))).await.expect("read without admitting native runtime");
        assert_eq!(read_after_reload["dataBase64"], encoded);
        assert!(handle.state.lock().await.mobkit.get(&mob_id).await.is_none());
        let _=std::fs::remove_dir_all(fixture);
    }

    #[tokio::test]
    async fn stopped_native_crew_resumes_exact_session_without_replaying_input() {
        let (fixture, project_path, state_root, gateway, llm) =
            setup_real_mobkit_host_tool_fixture_with_workers("crew-resume", 0, true).await;
        let mob_id = real_mobkit_fixture_mob_id(&project_path);
        let scope = serde_json::json!({"projectPath":project_path,"stateRoot":state_root});
        let root = gateway.mob_for_params(scope.as_object().unwrap(), &mob_id).await.unwrap();
        let runtime = root.runtime.as_ref().unwrap();
        let state = runtime.mob_runtime().agent_mob_mcp_state().unwrap();
        let child_id = meerkat_mob::MobId::from(format!("{mob_id}-resume-child"));
        let mut definition = runtime.mob_handle().definition().clone();
        definition.id = child_id.clone();
        state.mob_create_definition(definition).await.unwrap();
        state.mob_spawn_spec(
            &child_id,
            meerkat_mob::SpawnMemberSpec::new("ingress", "resume-worker")
                .with_runtime_mode(meerkat_mob::MobRuntimeMode::TurnDriven)
                .with_labels(std::collections::BTreeMap::from([("agent_identity".into(), "resume-alias".into())])),
        ).await.unwrap();
        let child = root.console.as_ref().unwrap().list_identities().await.unwrap()
            .into_iter().find(|item| item.labels.get("source_mob_id").map(String::as_str) == Some(child_id.as_str())).unwrap();
        let expected = super::mobkit_registry::ConsoleExpectedTarget {
            identity: child.identity.clone(),
            runtime_key: child.runtime_key.clone(),
            runtime_member_id: child.runtime_member_id.clone(),
            session_id: child.session_id.clone(),
            source_mob_id: Some(child_id.to_string()),
        };
        let mut input = console_control_params(&project_path, &state_root, &mob_id, &child);
        input["content"] = serde_json::json!("resume-once-input-819");
        gateway.mobs_console_send(Some(&input)).await.unwrap();
        wait_console_frame(root.console.as_ref().unwrap(), "resume-alias", "terminal").await;
        let session = meerkat_core::SessionId::parse(expected.session_id.as_ref().unwrap()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let service = runtime.mob_runtime().session_service().unwrap();
                if !service.read(&session).await.unwrap().state.is_active { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
        let streams_before = llm.streams.load(Ordering::SeqCst);
        assert!(streams_before >= 1, "original input must reach the native model before stop/resume");
        assert!(super::native_history::resume(&root, &expected).await.is_err(), "running crew cannot be resumed");
        let stop_params = console_control_params(&project_path, &state_root, &mob_id, &child);
        for field in ["identity", "runtimeKey", "runtimeMemberId", "sessionId", "sourceMobId"] {
            let mut stale = stop_params.clone();
            stale["expected"][field] = json!("replacement");
            let refused = gateway.handle(RpcRequest {
                jsonrpc: "2.0".into(), id: Some(RpcId::String(format!("stale-stop-{field}"))),
                method: "mobs.v1.consoleStopCrew".into(), params: Some(stale),
            }, RequestContext::local()).await;
            assert!(refused.error.is_some(), "stale {field} must not authorize crew stop");
        }
        let mut root_target = expected.clone();
        root_target.source_mob_id = None;
        assert!(super::native_history::stop_crew(&root, &root_target).await.is_err(),
            "root conversations must not be treated as disposable worker crews");
        let stopped = gateway.handle(RpcRequest {
            jsonrpc: "2.0".into(), id: Some(RpcId::String("crew-stop".into())),
            method: "mobs.v1.consoleStopCrew".into(), params: Some(stop_params.clone()),
        }, RequestContext::local()).await;
        assert!(stopped.error.is_none(), "native crew stop failed: {:?}", stopped.error);
        assert_eq!(stopped.result.unwrap()["stopped"], true);
        assert_eq!(root.team_snapshot().await["stoppedCrewIds"], serde_json::json!([child_id.to_string()]));
        assert!(super::native_history::stop_crew(&root, &expected).await.is_err(),
            "stopped crew must not be stopped again");
        let mut stale = expected.clone();
        stale.session_id = Some(uuid::Uuid::new_v4().to_string());
        assert!(super::native_history::resume(&root, &stale).await.is_err(), "replacement session must not authorize resume");
        let resumed = gateway.handle(RpcRequest {
            jsonrpc: "2.0".into(), id: Some(RpcId::String("crew-resume".into())),
            method: "mobs.v1.consoleResume".into(), params: Some(stop_params),
        }, RequestContext::local()).await;
        assert!(resumed.error.is_none(), "native crew resume failed: {:?}", resumed.error);
        let result = resumed.result.unwrap();
        assert_eq!(result["resumed"], true);
        assert_eq!(root.team_snapshot().await["stoppedCrewIds"], serde_json::json!([]));
        let handle = state.mob_handles_snapshot().await.unwrap().into_iter()
            .find(|(id, _)| id == &child_id).unwrap().1;
        assert_eq!(handle.status_observation_snapshot(), meerkat_mob::MobState::Running);
        let refreshed = root.console.as_ref().unwrap().list_identities().await.unwrap()
            .into_iter().find(|item| item.labels.get("source_mob_id").map(String::as_str) == Some(child_id.as_str())).unwrap();
        assert!(refreshed.addressable, "resume must refresh actual native capabilities");
        // Released MobKit owns informational stop/resume turns for an
        // orchestrator. These are allowed; replaying the old user input is not.
        assert!(llm.streams.load(Ordering::SeqCst) > streams_before);
        let requests = llm.observed_requests.lock().unwrap().clone();
        let last: Vec<serde_json::Value> = serde_json::from_str(requests.last().unwrap()).unwrap();
        let user_inputs = last.iter().filter(|message| message["role"] == "user")
            .filter_map(|message| message["content"].as_str()).collect::<Vec<_>>();
        assert_eq!(user_inputs.iter().filter(|value| **value == "resume-once-input-819").count(), 1,
            "explicit resume must keep the prior user input exactly once");
        assert_eq!(user_inputs.last().copied(), Some(format!("Mob '{child_id}' resumed with 1 active meerkats and 0 wiring links. Reconcile worker state and continue orchestration.").as_str()));
        assert_eq!(refreshed.session_id, expected.session_id, "native resume preserves the worker conversation");
        destroy_real_mobkit_host_tool_fixture(gateway, &fixture, &project_path, &state_root).await;
    }

    #[tokio::test]
    async fn owner_bound_crew_native_resume_preserves_owner_session_and_cold_transcript() {
        use meerkat_core::ops_lifecycle::{OperationKind, OperationSource, OpsLifecycleRegistry};

        let (fixture, project, state_root, gateway, llm) =
            setup_real_mobkit_host_tool_fixture_with_workers("autonomous-crew-resume", 0, true)
                .await;
        let mob_id = real_mobkit_fixture_mob_id(&project);
        let root = gateway
            .mob_for_params(
                json!({"projectPath":project,"stateRoot":state_root})
                    .as_object()
                    .unwrap(),
                &mob_id,
            )
            .await
            .unwrap();
        let runtime = root.runtime.as_ref().unwrap();
        let service = runtime.mob_runtime().session_service().unwrap();
        let machine = service.acquire_runtime_adapter(None)
            .expect("canonical native machine acquisition").expect("canonical native machine");
        let state = runtime.mob_runtime().agent_mob_mcp_state().unwrap();
        let child_id = meerkat_mob::MobId::from(format!("{mob_id}-autonomous-child"));
        let definition: meerkat_mob::MobDefinition = serde_json::from_value(json!({
            "id":child_id,"profiles":{"worker":{
                "model":"claude-haiku-4-5","runtime_mode":"autonomous_host",
                "tools":{"builtins":true,"shell":false,"comms":true}
            }}
        }))
        .unwrap();
        let owner = runtime
            .mob_handle()
            .resolve_bridge_session_id(&meerkat_mob::AgentIdentity::from("ingress"))
            .await
            .unwrap();
        state
            .mob_create_definition_with_owner_bridge_session(definition, owner.clone(), true, false)
            .await
            .unwrap();
        let spawn = meerkat_mob::SpawnMemberSpec::new("worker", "autonomous-worker")
            .with_runtime_mode(meerkat_mob::MobRuntimeMode::AutonomousHost)
            .with_initial_message("autonomous-once-input-901");
        let handle = state
            .mob_handles_snapshot()
            .await
            .unwrap()
            .into_iter()
            .find(|(id, _)| id == &child_id)
            .unwrap()
            .1;
        handle
            .spawn_spec_with_generated_owner_context(spawn, owner.clone())
            .await
            .unwrap();
        let child = root
            .console
            .as_ref()
            .unwrap()
            .list_identities()
            .await
            .unwrap()
            .into_iter()
            .find(|item| {
                item.labels.get("source_mob_id").map(String::as_str) == Some(child_id.as_str())
            })
            .unwrap();
        let expected = super::mobkit_registry::ConsoleExpectedTarget {
            identity: child.identity.clone(),
            runtime_key: child.runtime_key.clone(),
            runtime_member_id: child.runtime_member_id.clone(),
            session_id: child.session_id.clone(),
            source_mob_id: Some(child_id.to_string()),
        };
        wait_console_frame(root.console.as_ref().unwrap(), &child.identity, "terminal").await;
        let session =
            meerkat_core::SessionId::parse(expected.session_id.as_ref().unwrap()).unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if !service.read(&session).await.unwrap().state.is_active {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("initial child turn committed");

        // Exercise an admitted connection inside the child mob. Its members
        // share a transport namespace; the coordinator remains the operation
        // owner in the root mob. This does not prove cross-mob child routing.
        handle
            .spawn_spec_with_generated_owner_context(
                meerkat_mob::SpawnMemberSpec::new("worker", "autonomous-peer")
                    .with_runtime_mode(meerkat_mob::MobRuntimeMode::AutonomousHost)
                    .with_initial_message("autonomous-peer-ready-899"),
                owner.clone(),
            )
            .await
            .expect("spawn same-child-mob peer with the root coordinator as owner");
        let sender_session = handle
            .resolve_bridge_session_id(&meerkat_mob::AgentIdentity::from("autonomous-peer"))
            .await
            .expect("same-child-mob peer session");
        let sender_session_id = sender_session.to_string();
        let sender_identity = root
            .console
            .as_ref()
            .unwrap()
            .list_identities()
            .await
            .unwrap()
            .into_iter()
            .find(|item| item.session_id.as_deref() == Some(sender_session_id.as_str()))
            .expect("same-child-mob peer console identity");
        wait_console_frame(
            root.console.as_ref().unwrap(),
            &sender_identity.identity,
            "terminal",
        )
        .await;
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if !service.read(&sender_session).await.unwrap().state.is_active {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("same-child-mob peer initial turn committed");
        handle
            .wire(
                meerkat_mob::AgentIdentity::from("autonomous-peer"),
                meerkat_mob::AgentIdentity::from("autonomous-worker"),
            )
            .await
            .expect("admit native same-child-mob connection before stop");
        let sender_comms = service
            .comms_runtime(&sender_session)
            .await
            .expect("peer comms");
        let initial_child_comms = service.comms_runtime(&session).await.expect("child comms");
        let sender_peer = sender_comms.peer_id().unwrap();
        let initial_child_peer = initial_child_comms.peer_id().unwrap();
        assert!(
            sender_comms
                .peers()
                .await
                .iter()
                .any(|peer| peer.peer_id == initial_child_peer),
            "same-child-mob peer trusts the child before either resume"
        );
        assert!(
            initial_child_comms
                .peers()
                .await
                .iter()
                .any(|peer| peer.peer_id == sender_peer),
            "child trusts its same-mob peer before either resume"
        );
        sender_comms
            .send(meerkat_core::comms::CommsCommand::PeerMessage {
                to: meerkat_core::comms::PeerRoute::new(initial_child_peer),
                body: "autonomous-peer-before-resume-900".into(),
                blocks: None,
                handling_mode: meerkat_core::types::HandlingMode::Queue,
                content_taint: None,
                objective_id: None,
            })
            .await
            .expect("same-child-mob peer delivery before any stop/resume");
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let view = service.read(&session).await.unwrap();
                let history = service
                    .read_history(
                        &session,
                        meerkat_core::service::SessionHistoryQuery::default(),
                    )
                    .await
                    .unwrap();
                let peer_visible = serde_json::to_string(&history.messages)
                    .unwrap()
                    .contains("autonomous-peer-before-resume-900");
                let assistants = history
                    .messages
                    .iter()
                    .filter(|message| matches!(message, meerkat_core::Message::BlockAssistant(_)))
                    .count();
                if !view.state.is_active && peer_visible && assistants > 1 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("fixture child commits peer work before any stop/resume");
        let initial_history = service
            .read_history(
                &session,
                meerkat_core::service::SessionHistoryQuery::default(),
            )
            .await
            .unwrap();
        let initial_assistants = initial_history
            .messages
            .iter()
            .filter(|message| matches!(message, meerkat_core::Message::BlockAssistant(_)))
            .count();
        assert!(
            initial_assistants > 0,
            "initial task produced a committed answer"
        );
        let streams_before = llm.streams.load(Ordering::SeqCst);
        assert!(streams_before >= 1);
        let owner_authority = handle
            .owner_bridge_session_lifecycle_authority()
            .expect("native crew has a coordinator owner");
        assert_eq!(owner_authority.bridge_session_id, owner);
        let owner_registry = machine
            .ops_lifecycle_registry(&owner)
            .await
            .expect("coordinator registry remains live");
        let source = OperationSource::session_child(session.clone());
        let child_operations = owner_registry
            .list_operations()
            .unwrap()
            .into_iter()
            .filter(|operation| {
                operation.kind == OperationKind::MobMemberChild
                    && operation.operation_source.as_ref() == Some(&source)
            })
            .collect::<Vec<_>>();
        assert_eq!(
            child_operations.len(),
            1,
            "one exact coordinator-owned child operation"
        );
        let operation = child_operations[0].clone();
        assert_eq!(operation.owner_session_id, owner);
        assert!(
            !operation.terminal,
            "a completed turn does not retire the worker"
        );
        let sender_source = OperationSource::session_child(sender_session.clone());
        let sender_operations = owner_registry
            .list_operations()
            .unwrap()
            .into_iter()
            .filter(|operation| {
                operation.kind == OperationKind::MobMemberChild
                    && operation.operation_source.as_ref() == Some(&sender_source)
            })
            .collect::<Vec<_>>();
        assert_eq!(sender_operations.len(), 1, "one root-owned peer operation");
        let sender_operation = sender_operations[0].clone();
        assert_eq!(sender_operation.owner_session_id, owner);
        assert!(!sender_operation.terminal);
        let attachment = machine
            .current_executor_attachment_witness(&session)
            .await
            .expect("initial child attachment");
        assert_eq!(
            root.team_snapshot().await["ownerBoundCrewIds"],
            json!([child_id.to_string()])
        );
        let input = console_control_params(&project, &state_root, &mob_id, &child);

        for cycle in 1..=2 {
            for field in [
                "identity",
                "runtimeKey",
                "runtimeMemberId",
                "sessionId",
                "sourceMobId",
            ] {
                let mut stale = input.clone();
                stale["expected"][field] = json!("replacement");
                let refused = gateway
                    .handle(
                        RpcRequest {
                            jsonrpc: "2.0".into(),
                            id: Some(RpcId::String(format!("owned-stale-stop-{cycle}-{field}"))),
                            method: "mobs.v1.consoleStopCrew".into(),
                            params: Some(stale),
                        },
                        RequestContext::local(),
                    )
                    .await;
                assert!(
                    refused.error.is_some(),
                    "cycle {cycle}: stale {field} cannot stop the crew"
                );
                assert_eq!(
                    handle.status_observation_snapshot(),
                    meerkat_mob::MobState::Running
                );
            }
            assert!(
                super::native_history::resume(&root, &expected)
                    .await
                    .is_err(),
                "cycle {cycle}: a running crew cannot be resumed"
            );
            let stopped = tokio::time::timeout(
                Duration::from_secs(10),
                gateway.handle(
                    RpcRequest {
                        jsonrpc: "2.0".into(),
                        id: Some(RpcId::String(format!("owned-crew-stop-{cycle}"))),
                        method: "mobs.v1.consoleStopCrew".into(),
                        params: Some(input.clone()),
                    },
                    RequestContext::local(),
                ),
            )
            .await
            .expect("public owned crew stop timeout");
            assert!(
                stopped.error.is_none(),
                "cycle {cycle}: public crew stop failed: {:?}",
                stopped.error
            );
            assert_eq!(stopped.result.unwrap()["stopped"], true);
            assert_eq!(
                handle.status_observation_snapshot(),
                meerkat_mob::MobState::Stopped
            );
            assert_eq!(
                root.team_snapshot().await["stoppedCrewIds"],
                json!([child_id.to_string()])
            );
            assert!(
                super::native_history::stop_crew(&root, &expected)
                    .await
                    .is_err(),
                "cycle {cycle}: a stopped crew cannot be stopped again"
            );
            for field in [
                "identity",
                "runtimeKey",
                "runtimeMemberId",
                "sessionId",
                "sourceMobId",
            ] {
                let mut stale = input.clone();
                stale["expected"][field] = json!("replacement");
                let refused = gateway
                    .handle(
                        RpcRequest {
                            jsonrpc: "2.0".into(),
                            id: Some(RpcId::String(format!("owned-stale-resume-{cycle}-{field}"))),
                            method: "mobs.v1.consoleResume".into(),
                            params: Some(stale),
                        },
                        RequestContext::local(),
                    )
                    .await;
                assert!(
                    refused.error.is_some(),
                    "cycle {cycle}: stale {field} cannot resume the crew"
                );
                assert_eq!(
                    handle.status_observation_snapshot(),
                    meerkat_mob::MobState::Stopped
                );
            }
            let resumed = tokio::time::timeout(
                Duration::from_secs(10),
                gateway.handle(
                    RpcRequest {
                        jsonrpc: "2.0".into(),
                        id: Some(RpcId::String(format!("owned-crew-resume-{cycle}"))),
                        method: "mobs.v1.consoleResume".into(),
                        params: Some(input.clone()),
                    },
                    RequestContext::local(),
                ),
            )
            .await
            .expect("public owned crew resume timeout");
            assert!(
                resumed.error.is_none(),
                "cycle {cycle}: public crew resume failed: {:?}",
                resumed.error
            );
            assert_eq!(resumed.result.unwrap()["resumed"], true);
            assert_eq!(
                handle.status_observation_snapshot(),
                meerkat_mob::MobState::Running
            );
            assert_eq!(root.team_snapshot().await["stoppedCrewIds"], json!([]));
            assert_eq!(
                handle.owner_bridge_session_lifecycle_authority(),
                Some(owner_authority.clone())
            );
            assert_eq!(
                handle
                    .resolve_bridge_session_id_observation(&meerkat_mob::AgentIdentity::from(
                        "autonomous-worker"
                    ),)
                    .await,
                Some(session.clone()),
                "cycle {cycle}: preserve the exact child session"
            );
            assert_eq!(
                machine.current_executor_attachment_witness(&session).await,
                Some(attachment.clone()),
                "cycle {cycle}: warm resume reuses the exact child attachment"
            );
            let resumed_comms = service
                .comms_runtime(&session)
                .await
                .expect("resumed child comms");
            let resumed_sender_comms = service
                .comms_runtime(&sender_session)
                .await
                .expect("resumed same-child-mob peer comms");
            assert_eq!(
                handle
                    .resolve_bridge_session_id_observation(&meerkat_mob::AgentIdentity::from(
                        "autonomous-peer"
                    ))
                    .await,
                Some(sender_session.clone()),
                "cycle {cycle}: preserve the exact same-child-mob peer session"
            );
            assert_eq!(
                resumed_comms.peer_id(),
                Some(initial_child_peer),
                "cycle {cycle}: preserve the child routing identity"
            );
            assert_eq!(
                resumed_sender_comms.peer_id(),
                Some(sender_peer),
                "cycle {cycle}: preserve the same-child-mob peer routing identity"
            );
            assert!(
                resumed_sender_comms
                    .peers()
                    .await
                    .iter()
                    .any(|peer| peer.peer_id == initial_child_peer),
                "cycle {cycle}: same-child-mob peer retains child trust"
            );
            assert!(
                resumed_comms
                    .peers()
                    .await
                    .iter()
                    .any(|peer| peer.peer_id == sender_peer),
                "cycle {cycle}: child retains same-mob peer trust"
            );
            let current_owner_registry = machine.ops_lifecycle_registry(&owner).await.unwrap();
            assert!(
                Arc::ptr_eq(&owner_registry, &current_owner_registry),
                "cycle {cycle}: preserve the exact coordinator registry"
            );
            let current_operations = owner_registry
                .list_operations()
                .unwrap()
                .into_iter()
                .filter(|current| {
                    current.kind == OperationKind::MobMemberChild
                        && current.operation_source.as_ref() == Some(&source)
                })
                .collect::<Vec<_>>();
            assert_eq!(
                current_operations.len(),
                1,
                "cycle {cycle}: no duplicate child operation"
            );
            assert_eq!(current_operations[0].id, operation.id);
            assert_eq!(current_operations[0].owner_session_id, owner);
            assert!(
                !current_operations[0].terminal,
                "cycle {cycle}: original child operation is live"
            );
            let current_sender_operations = owner_registry
                .list_operations()
                .unwrap()
                .into_iter()
                .filter(|current| {
                    current.kind == OperationKind::MobMemberChild
                        && current.operation_source.as_ref() == Some(&sender_source)
                })
                .collect::<Vec<_>>();
            assert_eq!(
                current_sender_operations.len(),
                1,
                "cycle {cycle}: one peer operation"
            );
            assert_eq!(current_sender_operations[0].id, sender_operation.id);
            assert_eq!(current_sender_operations[0].owner_session_id, owner);
            assert!(!current_sender_operations[0].terminal);
            let own_registry = machine.ops_lifecycle_registry(&session).await.unwrap();
            assert!(
                !own_registry
                    .list_operations()
                    .unwrap()
                    .iter()
                    .any(|current| current.kind == OperationKind::MobMemberChild
                        && current.operation_source.as_ref() == Some(&source)),
                "cycle {cycle}: the child must not acquire its own operation"
            );
            assert_eq!(
                llm.streams.load(Ordering::SeqCst),
                streams_before,
                "cycle {cycle}: warm resume must not replay completed initial work"
            );
            let resumed_history = service
                .read_history(
                    &session,
                    meerkat_core::service::SessionHistoryQuery::default(),
                )
                .await
                .unwrap();
            assert_eq!(resumed_history.messages.iter().filter(|message|
                    matches!(message, meerkat_core::Message::User(user) if user.text_content() == "autonomous-once-input-901")
                ).count(), 1, "cycle {cycle}: initial input is committed exactly once");
        }

        let mut fresh = input.clone();
        fresh["content"] = json!("autonomous-fresh-after-resume-902");
        fresh["idempotencyKey"] = json!("owned-resume-fresh-902");
        let sent = gateway
            .mobs_console_send(Some(&fresh))
            .await
            .expect("fresh work after warm resume");
        assert_eq!(
            sent["receipt"]["session_id"],
            expected.session_id.as_deref().unwrap()
        );
        tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let view = service.read(&session).await.unwrap();
                    let history = service.read_history(
                        &session, meerkat_core::service::SessionHistoryQuery::default(),
                    ).await.unwrap();
                    let fresh_count = history.messages.iter().filter(|message|
                        matches!(message, meerkat_core::Message::User(user) if user.text_content() == "autonomous-fresh-after-resume-902")
                    ).count();
                    let assistants = history.messages.iter()
                        .filter(|message| matches!(message, meerkat_core::Message::BlockAssistant(_))).count();
                    if !view.state.is_active && fresh_count == 1 && assistants > initial_assistants { break; }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }).await.expect("fresh child work commits a new answer on the original session");
        assert!(llm.streams.load(Ordering::SeqCst) > streams_before);

        let resumed_sender_comms = service
            .comms_runtime(&sender_session)
            .await
            .expect("resumed same-child-mob peer comms for fresh delivery");
        resumed_sender_comms
            .send(meerkat_core::comms::CommsCommand::PeerMessage {
                to: meerkat_core::comms::PeerRoute::new(initial_child_peer),
                body: "autonomous-peer-after-resume-903".into(),
                blocks: None,
                handling_mode: meerkat_core::types::HandlingMode::Queue,
                content_taint: None,
                objective_id: None,
            })
            .await
            .expect("same-child-mob peer message after child resume");
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let view = service.read(&session).await.unwrap();
                let history = service
                    .read_history(
                        &session,
                        meerkat_core::service::SessionHistoryQuery::default(),
                    )
                    .await
                    .unwrap();
                let peer_visible = serde_json::to_string(&history.messages)
                    .unwrap()
                    .contains("autonomous-peer-after-resume-903");
                let assistants = history
                    .messages
                    .iter()
                    .filter(|message| matches!(message, meerkat_core::Message::BlockAssistant(_)))
                    .count();
                if !view.state.is_active && peer_visible && assistants > initial_assistants + 1 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("resumed child receives and completes peer work");
        let after_work = owner_registry.snapshot(&operation.id).unwrap().unwrap();
        assert_eq!(after_work.owner_session_id, owner);
        assert_eq!(after_work.operation_source, Some(source));
        assert!(
            !after_work.terminal,
            "fresh work preserves the original coordinator-owned operation"
        );
        let warm_history = super::native_history::read(Some(&input)).await.unwrap();
        let refreshed = root
            .console
            .as_ref()
            .unwrap()
            .list_identities()
            .await
            .unwrap()
            .into_iter()
            .find(|item| item.identity == child.identity)
            .unwrap();
        assert_eq!(refreshed.session_id, expected.session_id);

        let project_handle = gateway
            .project_runtime_handle_for_paths(&project, &project, "local".into(), Some(&state_root))
            .await
            .unwrap();
        assert!(
            project_handle
                .state
                .lock()
                .await
                .mobkit
                .remove(&mob_id)
                .await
                .unwrap()
        );
        let reloaded = MeerkatGateway::new();
        let history = reloaded
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".into(),
                    id: Some(RpcId::String("cold-native-transcript".into())),
                    method: "mobs.v1.consoleHistory".into(),
                    params: Some(input.clone()),
                },
                RequestContext::local(),
            )
            .await;
        assert!(
            history.error.is_none(),
            "cold committed transcript: {:?}",
            history.error
        );
        let history = history.result.unwrap();
        assert_eq!(
            history["transcript"]["sessionId"],
            expected.session_id.as_deref().unwrap()
        );
        assert_eq!(
            history["transcript"]["messages"], warm_history["transcript"]["messages"],
            "cold read preserves the exact committed transcript after warm resume"
        );
        let saved = history["transcript"]["messages"].as_array().unwrap();
        for prompt in [
            "autonomous-once-input-901",
            "autonomous-fresh-after-resume-902",
        ] {
            assert_eq!(
                saved
                    .iter()
                    .filter(|entry| entry["message"]["content"] == prompt)
                    .count(),
                1
            );
        }
        for peer_input in [
            "autonomous-peer-before-resume-900",
            "autonomous-peer-after-resume-903",
        ] {
            assert!(serde_json::to_string(saved).unwrap().contains(peer_input));
        }
        assert!(
            saved
                .iter()
                .any(|entry| entry["message"]["role"] == "block_assistant")
        );
        assert!(
            history.get("historyStatus").is_none(),
            "complete attributed history must not carry the optional partial-history marker"
        );
        assert!(
            project_handle
                .state
                .lock()
                .await
                .mobkit
                .get(&mob_id)
                .await
                .is_none(),
            "cold transcript read must not admit a native runtime"
        );
        // This verifies committed history, not cold reconstruction of the
        // coordinator-owned crew, which remains a separate native limitation.
        drop(reloaded);
        drop(gateway);
        let _ = std::fs::remove_dir_all(fixture);
    }

    async fn setup_real_mobkit_host_tool_fixture(
        label: &str,
        tool_calls_per_turn: usize,
    ) -> (
        std::path::PathBuf,
        String,
        String,
        MeerkatGateway,
        Arc<ScriptedHostToolLlm>,
    ) {
        setup_real_mobkit_host_tool_fixture_with_workers(label, tool_calls_per_turn, false).await
    }

    async fn setup_real_mobkit_host_tool_fixture_with_workers(
        label: &str,
        tool_calls_per_turn: usize,
        include_native_workers: bool,
    ) -> (
        std::path::PathBuf,
        String,
        String,
        MeerkatGateway,
        Arc<ScriptedHostToolLlm>,
    ) {
        let fixture =
            std::env::temp_dir().join(format!("meerkat-{label}-{}", uuid::Uuid::new_v4()));
        let project_path = fixture.join("project");
        let state_root = fixture.join("state");
        std::fs::create_dir_all(&project_path).expect("create project fixture");
        std::fs::create_dir_all(&state_root).expect("create state fixture");
        let project_path_string = project_path.to_string_lossy().to_string();
        let state_root_string = state_root.to_string_lossy().to_string();
        let mob_id = real_mobkit_fixture_mob_id(&project_path_string);

        let gateway = MeerkatGateway::new();
        let scripted_llm = Arc::new(ScriptedHostToolLlm::new(tool_calls_per_turn));
        let runtime_handle = gateway
            .project_runtime_handle_for_paths(
                &project_path_string,
                &project_path_string,
                "local".to_string(),
                Some(&state_root_string),
            )
            .await
            .expect("create project runtime");
        {
            let mut state = runtime_handle.state.lock().await;
            let test_client: Arc<dyn meerkat::LlmClient> = scripted_llm.clone();
            state.mobkit = Arc::new(ProjectMobkitRegistry::new_with_test_llm(
                Arc::clone(&gateway.inner.host_tools),
                test_client,
            ));
        }

        let configure =
            configure_synthetic_host_tool(&gateway, &format!("configure-{label}"), true).await;
        assert!(configure.error.is_none(), "configure failed: {configure:?}");

        let create = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String(format!("create-{label}"))),
                    method: "mobs.v1.createThreadMob".to_string(),
                    params: Some(serde_json::json!({
                        "projectPath": project_path_string,
                        "executionPath": project_path_string,
                        "stateRoot": state_root_string,
                        "threadId": "thread-host-tool-proof",
                        "mobId": mob_id,
                        "ingressAgentIdentity": "ingress",
                        "model": "gpt-5.6-sol",
                        "title": "Host tool proof",
                        "includeNativeWorkers": include_native_workers
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert!(create.error.is_none(), "mob creation failed: {create:?}");
        assert_eq!(
            create
                .result
                .as_ref()
                .and_then(|result| result.pointer("/mob/ingressAgentIdentity"))
                .and_then(serde_json::Value::as_str),
            Some("ingress")
        );

        (
            fixture,
            project_path_string,
            state_root_string,
            gateway,
            scripted_llm,
        )
    }

    async fn start_real_mobkit_host_tool_turn(
        gateway: &MeerkatGateway,
        request_id: &str,
        project_path: &str,
        state_root: &str,
        input: &str,
        foreground: bool,
    ) -> meerkat_desktop_contracts::RpcResponse {
        let mob_id = real_mobkit_fixture_mob_id(project_path);
        let mut params = serde_json::json!({
            "projectPath": project_path,
            "executionPath": project_path,
            "stateRoot": state_root,
            "threadId": "thread-host-tool-proof",
            "mobId": mob_id,
            "agentIdentity": "ingress",
            "input": input
        });
        if foreground {
            params["ingressKind"] = serde_json::json!("desktop_interactive_turn");
        }
        gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String(request_id.to_string())),
                    method: "mobs.v1.turnStart".to_string(),
                    params: Some(params),
                },
                RequestContext::local(),
            )
            .await
    }

    async fn wait_for_real_mobkit_terminal_event(
        events: &mut tokio::sync::broadcast::Receiver<meerkat_desktop_contracts::EventEmit>,
        run_id: &str,
        terminal_kind: &str,
    ) -> Option<serde_json::Value> {
        tokio::time::timeout(Duration::from_secs(30), async {
            let mut final_text = None;
            loop {
                let event = events.recv().await.expect("MobKit run event");
                if event.run_id.as_deref() != Some(run_id) {
                    continue;
                }
                if event.kind == "run.output.complete" {
                    final_text = event.payload.get("text").cloned();
                }
                if event.kind == terminal_kind {
                    break final_text;
                }
                assert_ne!(event.kind, "run.failed", "MobKit run failed: {event:?}");
            }
        })
        .await
        .expect("MobKit run terminal event timeout")
    }

    async fn destroy_real_mobkit_host_tool_fixture(
        gateway: MeerkatGateway,
        fixture: &std::path::Path,
        project_path: &str,
        state_root: &str,
    ) {
        let mob_id = real_mobkit_fixture_mob_id(project_path);
        let destroyed = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String("destroy-proof-mob".to_string())),
                    method: "mobs.v1.destroy".to_string(),
                    params: Some(serde_json::json!({
                        "projectPath": project_path,
                        "executionPath": project_path,
                        "stateRoot": state_root,
                        "mobId": mob_id
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert_eq!(
            destroyed
                .result
                .as_ref()
                .and_then(|result| result.get("destroyed"))
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        drop(gateway);
        let _ = std::fs::remove_dir_all(fixture);
    }

    #[test]
    fn coordinator_work_controls_native_input_without_application_turn() {
        std::thread::Builder::new().name("coordinator-native-work".into())
            .stack_size(32 * 1024 * 1024).spawn(|| {
                tokio::runtime::Builder::new_multi_thread().worker_threads(2)
                    .thread_stack_size(16 * 1024 * 1024).enable_all().build().unwrap()
                    .block_on(async {
                        use meerkat_runtime::SessionServiceRuntimeExt;
                        let (fixture,project,state,gateway,llm) = setup_real_mobkit_host_tool_fixture("coordinator-work",0).await;
                        let mob_id=real_mobkit_fixture_mob_id(&project);
                        let mob=gateway.mob_for_params(json!({"projectPath":project,"stateRoot":state}).as_object().unwrap(),&mob_id).await.unwrap();
                        let console=mob.console.as_ref().unwrap();
                        let record=console.list_identities().await.unwrap().into_iter().find(|r|r.identity=="ingress").unwrap();
                        let runtime=mob.runtime.as_ref().unwrap();
                        let session_id=SessionId::parse(record.session_id.as_deref().unwrap()).unwrap();
                        let mut events=gateway.subscribe_events();
                        let seed=gateway.mobs_turn_start(Some(&json!({
                            "projectPath":project,"stateRoot":state,"configStateRoot":state,
                            "threadId":"thread-host-tool-proof","mobId":mob_id,"agentIdentity":"ingress",
                            "input":"Completed history before exact peer Stop","model":"gpt-5.6-sol","provider":"openai"
                        }))).await.expect("seed completed history");
                        wait_for_real_mobkit_terminal_event(&mut events,seed["runId"].as_str().unwrap(),"run.completed").await;
                        let completed_history=super::read_session_history_messages(runtime,&session_id.to_string()).await.unwrap();
                        assert!(completed_history.iter().any(|row|row["content"]=="Completed history before exact peer Stop"));
                        let first_request_gate=Arc::new(tokio::sync::Notify::new());
                        *llm.block_next.lock().unwrap()=Some(first_request_gate.clone());
                        *llm.stop_probe_steering.lock().unwrap()=Some("Keep the current task focused".into());
                        let mut params=console_control_params(&project,&state,&mob_id,&record);
                        console.send(meerkat_mobkit::ConsoleSendRequest{
                            origin_kind: None,
                            skill_refs: Vec::new(),
                            identity:"ingress".into(),content:json!("Native work outside the application turn"),
                            origin:"native-work-proof".into(),idempotency_key:"first".into(),handling_mode:None,
                        }).await.unwrap();
                        tokio::time::timeout(Duration::from_secs(10),llm.blocked_started.notified()).await.expect("native model started");
                        let work=gateway.mobs_coordinator_work(Some(&params)).await.unwrap();
                        assert_eq!(work["busy"],true,"native work must remain visible without an app turn");
                        let first=work["inputs"].as_array().unwrap().first().expect("exact active input");
                        params["inputId"]=first["inputId"].clone();
                        params["nativeRunId"]=first["runId"].clone();
                        params["content"]=json!("Keep the current task focused");
                        params["idempotencyKey"]=json!("native-peer-steer");
                        let steered=gateway.mobs_coordinator_steer(Some(&params)).await.unwrap();
                        assert_eq!(steered["receipt"]["kind"],"runtime_input");
                        assert_eq!(steered["receipt"]["sessionId"],record.session_id.as_deref().unwrap());
                        assert!(steered["receipt"]["inputId"].as_str().is_some_and(|id|!id.is_empty()));
                        let replay=gateway.mobs_coordinator_steer(Some(&params)).await.unwrap();
                        assert_eq!(replay["receipt"],steered["receipt"]);
                        let mut wrong=params.clone();
                        wrong["nativeRunId"]=json!("unrelated-run");
                        assert!(gateway.mobs_coordinator_stop(Some(&wrong)).await.is_err());
                        wrong=params.clone();
                        wrong["content"]=json!("Different message under same request");
                        assert!(gateway.mobs_coordinator_steer(Some(&wrong)).await.is_err());
                        first_request_gate.notify_one();
                        tokio::time::timeout(Duration::from_secs(10),llm.stop_probe_observed.notified()).await.expect("original native run observed accepted steering");
                        let joined_work=gateway.mobs_coordinator_work(Some(&params)).await.unwrap();
                        assert!(joined_work["inputs"].as_array().unwrap().contains(first),"the original input/run must still be active when steering is observed");
                        let machine=mob.session_runtime.as_ref().unwrap();
                        let original_input=serde_json::from_value::<meerkat_core::lifecycle::InputId>(params["inputId"].clone()).unwrap();
                        let steer_input=serde_json::from_value::<meerkat_core::lifecycle::InputId>(steered["receipt"]["inputId"].clone()).unwrap();
                        let joined=machine.input_state(&session_id,&steer_input).await.unwrap().unwrap();
                        assert_eq!(joined.seed.last_run_id.as_ref().map(ToString::to_string).as_deref(),params["nativeRunId"].as_str(),"steering must join the selected native run before Stop");
                        let stopped=gateway.mobs_coordinator_stop(Some(&params)).await.unwrap();
                        assert_eq!(stopped["accepted"],true,"stop={stopped:?}; work={:?}",gateway.mobs_coordinator_work(Some(&params)).await);
                        assert_eq!(stopped["nativeRunId"],params["nativeRunId"]);
                        *llm.stop_probe_steering.lock().unwrap()=None;
                        let original_terminal=machine.input_state(&session_id,&original_input).await.unwrap().unwrap();
                        let steer_terminal=machine.input_state(&session_id,&steer_input).await.unwrap().unwrap();
                        for terminal in [&original_terminal,&steer_terminal] {
                            assert_eq!(terminal.seed.terminal_outcome,Some(meerkat_runtime::input_state::InputTerminalOutcome::Abandoned {
                                reason:meerkat_runtime::input_state::InputAbandonReason::Cancelled,
                            }),"Stop must terminalize both contributors of the selected native run");
                        }
                        let handle=gateway.project_runtime_handle_for_paths(&project,&project,"local".into(),Some(&state)).await.unwrap();
                        assert!(handle.state.lock().await.active_runs.is_empty(),"controls never invent an application turn");
                        // The next ordinary desktop turn always carries a model selection.
                        // Reconfiguration must observe the same committed native session after
                        // Stop; completing a peer turn without selection is insufficient.
                        let service=runtime.mob_runtime().session_service().unwrap();
                        let actor_registered=service.live_session_actor_registered(&session_id).await;
                        let live_authority=service.has_live_session(&session_id).await;
                        let persisted_authority=service.observe_persisted_session_authority(&session_id).await;
                        let attachment=mob.session_runtime.as_ref().unwrap().session_attachment_state(&session_id).await;
                        let diagnostics=format!("fixture={}; session={session_id}; actor_registered={actor_registered:?}; live_authority={live_authority:?}; attachment={attachment:?}; persisted_authority={persisted_authority:?}",fixture.display());
                        eprintln!("Post-Stop session authority: {diagnostics}");
                        std::fs::write(fixture.join("stop-successor-authority.json"),serde_json::to_vec_pretty(&json!({
                            "sessionId":session_id.to_string(),"stoppedRunId":params["nativeRunId"],
                            "originalInput":original_terminal,"steeringInput":steer_terminal,
                            "diagnostics":diagnostics,"modelRequestsBeforeSuccessor":llm.observed_requests.lock().unwrap().clone(),
                        })).unwrap()).unwrap();
                        let calls_before_successor=llm.streams.load(Ordering::SeqCst);
                        let successor=gateway.mobs_turn_start(Some(&json!({
                            "projectPath":project,"stateRoot":state,"configStateRoot":state,
                            "threadId":"thread-host-tool-proof","mobId":mob_id,"agentIdentity":"ingress",
                            "input":"Fresh model-selected turn after exact peer Stop","model":"gpt-5.4","provider":"openai"
                        }))).await.unwrap_or_else(|error|panic!("same-session successor rejected: {error}; {diagnostics}"));
                        assert_eq!(successor["appliedModel"],"gpt-5.4");
                        wait_for_real_mobkit_terminal_event(&mut events,successor["runId"].as_str().unwrap(),"run.completed").await;
                        std::fs::write(fixture.join("stop-successor-requests.json"),serde_json::to_vec_pretty(&json!({
                            "successor":successor,"modelRequests":llm.observed_requests.lock().unwrap().clone(),
                        })).unwrap()).unwrap();
                        assert_eq!(llm.streams.load(Ordering::SeqCst),calls_before_successor+1,"Stop must never replay the predecessor or joined steering");
                        let same_session=runtime.mob_handle().resolve_bridge_session_id(&meerkat_mobkit::member_comms_id::mob_member_id("ingress")).await.unwrap();
                        assert_eq!(same_session,session_id,"continuation preserves native conversation identity");
                        let continued_history=super::read_session_history_messages(runtime,&session_id.to_string()).await.unwrap();
                        assert_eq!(&continued_history[..completed_history.len()],completed_history.as_slice(),"Stop preserves completed conversation history");
                        assert_eq!(continued_history.iter().filter(|row|row["content"]=="Fresh model-selected turn after exact peer Stop").count(),1);
                        destroy_real_mobkit_host_tool_fixture(gateway,&fixture,&project,&state).await;
                    });
            }).unwrap().join().unwrap();
    }

    #[test]
    fn rejected_steering_releases_native_owners_before_finalization_wait() {
        std::thread::Builder::new()
            .name("steering-owner-release-proof".into())
            .stack_size(32 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .thread_stack_size(16 * 1024 * 1024)
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(async {
                        let (fixture, project, state_root, gateway, scripted) =
                            setup_real_mobkit_host_tool_fixture("steering-owner-release", 0).await;
                        let mob_id = real_mobkit_fixture_mob_id(&project);
                        let handle = gateway.project_runtime_handle_for_paths(
                            &project, &project, "local".into(), Some(&state_root),
                        ).await.unwrap();
                        let registry = Arc::clone(&handle.state.lock().await.mobkit);
                        let mob = registry.get(&mob_id).await.unwrap();
                        let runtime = Arc::clone(mob.runtime.as_ref().unwrap());
                        let weak_mob = Arc::downgrade(&mob);
                        let weak_runtime = Arc::downgrade(&runtime);
                        let projection = Arc::new(Mutex::new(RunEventProjection::default()));
                        let mut events = gateway.subscribe_events();
                        // Block application finalization independently of native
                        // shutdown. The error path must release its native owners
                        // even while finish_run cannot acquire this mutex.
                        let mut finalization_guard = handle.state.lock().await;
                        finalization_guard.active_runs.insert("thread-host-tool-proof".into(), ActiveRun {
                            run_id: "owner-release-run".into(),
                            mob_id: mob_id.clone(),
                            agent_identity: "absent-member".into(),
                            started_at: chrono::Utc::now(),
                            deliveries: AppRunDeliveries::default(),
                            projection: Arc::clone(&projection),
                        });
                        let admission = gateway.submit_run_steering(
                            Arc::clone(&handle), runtime, mob,
                            "thread-host-tool-proof".into(), "owner-release-run".into(),
                            mob_id.clone(), "absent-member".into(), project.clone(),
                            project.clone(), "local".into(),
                            meerkat_core::ContentInput::Text("No native turn should be admitted".into()),
                            projection,
                        ).await;
                        assert!(admission.is_err());
                        assert!(registry.remove(&mob_id).await.unwrap());
                        let released = tokio::time::timeout(Duration::from_secs(2), async {
                            while weak_mob.strong_count() != 0 || weak_runtime.strong_count() != 0 {
                                tokio::task::yield_now().await;
                            }
                        }).await;
                        // Release the test's gate before asserting so the old
                        // behavior can finish its owned task and fixture cleanup.
                        drop(finalization_guard);
                        wait_for_real_mobkit_terminal_event(
                            &mut events, "owner-release-run", "run.completed",
                        ).await;
                        assert!(gateway.shutdown().await.is_empty());
                        let observer_failures = gateway.drain_storage_observers().await;
                        assert!(observer_failures.is_empty(), "{observer_failures:?}");
                        assert!(scripted.observed_requests.lock().unwrap().is_empty());
                        drop(gateway);
                        std::fs::remove_dir_all(&fixture).unwrap();
                        assert!(released.is_ok(), "detached steering retained native owners while finalization was blocked");
                    });
            })
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn idle_steering_continuation_waits_for_application_delivery_barrier() {
        std::thread::Builder::new().name("idle-steering-app-proof".into())
            .stack_size(16 * 1024 * 1024).spawn(|| {
                tokio::runtime::Builder::new_multi_thread().worker_threads(2)
                    .thread_stack_size(16 * 1024 * 1024).enable_all().build().unwrap()
                    .block_on(async {
                        let (fixture, project_path, state_root, gateway, scripted) =
                            setup_real_mobkit_host_tool_fixture("idle-steering-app", 1).await;
                        let mob_id = real_mobkit_fixture_mob_id(&project_path);
                        let handle = gateway.project_runtime_handle_for_paths(
                            &project_path, &project_path, "local".into(), Some(&state_root),
                        ).await.unwrap();
                        handle.state.lock().await.active_runs.insert("thread-host-tool-proof".into(), ActiveRun {
                            run_id: "app-run".into(), mob_id: mob_id.clone(), agent_identity: "ingress".into(),
                            started_at: chrono::Utc::now(), deliveries: AppRunDeliveries::default(),
                            projection: Arc::new(Mutex::new(RunEventProjection::default())),
                        });
                        let mut events = gateway.subscribe_events();
                        let receipt = gateway.mobs_turn_start(Some(&serde_json::json!({
                            "projectPath":project_path,"executionPath":project_path,"stateRoot":state_root,
                            "threadId":"thread-host-tool-proof","mobId":mob_id,"agentIdentity":"ingress",
                            "handlingMode":"steer","expectedRunId":"app-run","input":"IDLE-APP-STEER-715"
                        }))).await.unwrap();
                        assert_eq!(receipt["mode"], "steering_submitted");
                        assert_eq!(receipt["runId"], "app-run");
                        assert_eq!(receipt["runtimeReceipt"]["handling_mode"], "steer");
                        tokio::time::timeout(Duration::from_secs(10), async {
                            loop {
                                if handle.state.lock().await.active_runs["thread-host-tool-proof"].deliveries.pending == 1 { break; }
                                tokio::task::yield_now().await;
                            }
                        }).await.expect("idle steering committed");
                        let mut final_count = 0;
                        while let Ok(event) = events.try_recv() {
                            assert_ne!(event.kind, "run.completed", "original delivery still owns app work");
                            assert_ne!(event.kind, "run.failed");
                            if event.kind == "run.output.complete" { final_count += 1; }
                        }
                        assert_eq!(final_count, 1, "idle fallback output must be projected exactly once");
                        assert!(scripted.observed_requests.lock().unwrap()[0].contains("IDLE-APP-STEER-715"));
                        finish_run(&gateway.inner.events_tx, &handle, "thread-host-tool-proof", "app-run",
                            &mob_id, "ingress", &project_path, &project_path, "local",
                            gateway.inner.host_tools.as_ref(), Ok(())).await;
                        assert_eq!(events.try_recv().unwrap().kind, "run.completed");
                        assert!(events.try_recv().is_err());
                        destroy_real_mobkit_host_tool_fixture(gateway, &fixture, &project_path, &state_root).await;
                    });
            }).unwrap().join().unwrap();
    }

    #[test]
    fn disposal_stops_native_execution_and_preserves_unrelated_runtime_and_history() {
        std::thread::Builder::new().name("native-disposal-proof".into())
            .stack_size(32 * 1024 * 1024).spawn(|| {
                tokio::runtime::Builder::new_multi_thread().worker_threads(2)
                    .thread_stack_size(16 * 1024 * 1024).enable_all().build().unwrap()
                    .block_on(async {
                        let (fixture, project, state, gateway, _) = setup_real_mobkit_host_tool_fixture("disposal", 1).await;
                        let mob_id = real_mobkit_fixture_mob_id(&project);
                        let params = serde_json::json!({"projectPath":project,"stateRoot":state,"mobId":mob_id});
                        let handle = gateway.project_runtime_handle_for_mob_params(params.as_object().unwrap()).await.unwrap();
                        let registry = Arc::clone(&handle.state.lock().await.mobkit);
                        registry.insert_remote_tcp("unrelated".into(), "Other project agent".into(), "127.0.0.1:1".into(), None).await.unwrap();
                        let mob = registry.get(&mob_id).await.unwrap();
                        let mut notifications = gateway.subscribe_host_tool_notifications();
                        let started = start_real_mobkit_host_tool_turn(&gateway,"dispose-running",&project,&state,"Call the host tool and wait.",true).await;
                        assert!(started.error.is_none(), "{started:?}");
                        let run_id = started.result.unwrap()["runId"].as_str().unwrap().to_string();
                        assert!(matches!(tokio::time::timeout(Duration::from_secs(10),notifications.recv()).await.unwrap().unwrap(),DesktopHostToolNotificationV1::Invoke(_)));
                        let disposed = tokio::time::timeout(Duration::from_secs(30),gateway.mobs_destroy(Some(&params))).await.expect("disposal settles").unwrap();
                        assert_eq!(disposed["cleanupCompleted"],true);
                        assert!(registry.get(&mob_id).await.is_none());
                        assert!(registry.get("unrelated").await.is_some());
                        assert!(super::lookup_terminal_run(std::path::Path::new(&state),&run_id).is_some());
                        assert!(handle.state.lock().await.active_runs.is_empty());
                        assert!(mob.state_root.join("mobkit").exists(),"native history is retained");
                        assert!(mob.runtime.as_ref().unwrap().mob_handle().force_cancel_member(meerkat_mob::AgentIdentity::from("ingress")).await.is_err(),"old handle cannot execute after cleanup");
                        assert_eq!(gateway.mobs_destroy(Some(&params)).await.unwrap()["cleanupCompleted"],true);
                        assert!(gateway.shutdown().await.is_empty());
                        assert!(registry.list().await.is_empty());
                        assert!(registry.insert_remote_tcp("late".into(),"Late".into(),"127.0.0.1:1".into(),None).await.is_err());
                        assert!(gateway.project_runtime_handle_for_mob_params(params.as_object().unwrap()).await.is_err());
                        drop(mob); drop(gateway); std::fs::remove_dir_all(fixture).unwrap();
                    });
            }).unwrap().join().unwrap();
    }

    #[test]
    fn cancellation_settles_original_and_already_reserved_steering() {
        std::thread::Builder::new()
            .name("cancel-reserved-steering-proof".into())
            .stack_size(16 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .thread_stack_size(16 * 1024 * 1024)
                    .enable_all().build().unwrap()
                    .block_on(async {
                        let (fixture, project_path, state_root, gateway, _) =
                            setup_real_mobkit_host_tool_fixture("cancel-reserved-steering", 1).await;
                        let mob_id = real_mobkit_fixture_mob_id(&project_path);
                        let handle = gateway.project_runtime_handle_for_paths(
                            &project_path, &project_path, "local".into(), Some(&state_root),
                        ).await.unwrap();
                        let mut host = gateway.subscribe_host_tool_notifications();
                        let mut events = gateway.subscribe_events();
                        let active = start_real_mobkit_host_tool_turn(
                            &gateway, "cancel-steer-original", &project_path, &state_root,
                            "Wait on the host tool until cancelled.", true,
                        ).await;
                        assert!(active.error.is_none(), "{active:?}");
                        let run_id = active.result.unwrap()["runId"].as_str().unwrap().to_owned();
                        assert!(matches!(tokio::time::timeout(Duration::from_secs(10), host.recv())
                            .await.unwrap().unwrap(), DesktopHostToolNotificationV1::Invoke(_)));
                        let steering_gateway = gateway.clone();
                        let params = serde_json::json!({
                            "projectPath":project_path,"executionPath":project_path,"stateRoot":state_root,
                            "threadId":"thread-host-tool-proof","mobId":mob_id,"agentIdentity":"ingress",
                            "handlingMode":"steer","expectedRunId":run_id,"input":"CANCEL-RESERVED-STEER-231"
                        });
                        let steering = tokio::spawn(async move {
                            steering_gateway.mobs_turn_start(Some(&params)).await
                        });
                        tokio::time::timeout(Duration::from_secs(10), async {
                            loop {
                                if handle.state.lock().await.active_runs["thread-host-tool-proof"].deliveries.pending == 2 { break; }
                                tokio::task::yield_now().await;
                            }
                        }).await.unwrap();
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        let cancelled = gateway.mobs_force_cancel(Some(&serde_json::json!({
                            "projectPath":project_path,"executionPath":project_path,"stateRoot":state_root,
                            "threadId":"thread-host-tool-proof","mobId":mob_id,"agentIdentity":"ingress","runId":run_id,
                        }))).await.unwrap();
                        assert_eq!(cancelled["status"], "cancelling");
                        assert_eq!(cancelled["runtimeCancelled"], false);
                        let steering_outcome = tokio::time::timeout(Duration::from_secs(10), steering)
                            .await.expect("reserved steering admission settles after cancellation").unwrap();
                        if let Ok(receipt) = steering_outcome {
                            assert_eq!(receipt["runId"], run_id);
                            assert_eq!(receipt["mode"], "steering_submitted");
                        }
                        wait_for_real_mobkit_terminal_event(&mut events, &run_id, "run.cancelled").await;
                        assert!(handle.state.lock().await.active_runs.is_empty());
                        assert!(events.try_recv().is_err(), "cancellation has one application terminal");
                        assert_eq!(super::lookup_terminal_run(std::path::Path::new(&state_root), &run_id).unwrap()["status"], "cancelled");
                        destroy_real_mobkit_host_tool_fixture(gateway, &fixture, &project_path, &state_root).await;
                    });
            }).unwrap().join().unwrap();
    }

    #[test]
    fn gateway_live_steering_keeps_same_application_run_and_committed_history() {
        std::thread::Builder::new()
            .name("gateway-live-steering-proof".into())
            .stack_size(16 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .thread_stack_size(16 * 1024 * 1024)
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(async {
                        let (fixture, project_path, state_root, gateway, scripted) =
                            setup_real_mobkit_host_tool_fixture("gateway-live-steering", 1).await;
                        let mob_id = real_mobkit_fixture_mob_id(&project_path);
                        let handle = gateway.project_runtime_handle_for_paths(
                            &project_path, &project_path, "local".into(), Some(&state_root),
                        ).await.unwrap();
                        let mut host = gateway.subscribe_host_tool_notifications();
                        let mut events = gateway.subscribe_events();
                        let active = start_real_mobkit_host_tool_turn(
                            &gateway, "app-steer-original", &project_path, &state_root,
                            "APP-STEER-ORIGINAL-167", true,
                        ).await;
                        assert!(active.error.is_none(), "{active:?}");
                        let run_id = active.result.unwrap()["runId"].as_str().unwrap().to_owned();
                        let invoke = tokio::time::timeout(Duration::from_secs(10), host.recv())
                            .await.unwrap().unwrap();
                        let DesktopHostToolNotificationV1::Invoke(invoke) = invoke else {
                            panic!("expected live host tool");
                        };
                        let steering_gateway = gateway.clone();
                        let params = serde_json::json!({
                            "projectPath":project_path,"executionPath":project_path,"stateRoot":state_root,
                            "threadId":"thread-host-tool-proof","mobId":mob_id,"agentIdentity":"ingress",
                            "handlingMode":"steer","expectedRunId":run_id,"input":"APP-LIVE-STEER-923"
                        });
                        let steering = tokio::spawn(async move {
                            steering_gateway.mobs_turn_start(Some(&params)).await
                        });
                        tokio::time::timeout(Duration::from_secs(10), async {
                            loop {
                                if handle.state.lock().await.active_runs["thread-host-tool-proof"].deliveries.pending == 2 { break; }
                                tokio::task::yield_now().await;
                            }
                        }).await.expect("gateway steering reservation");
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        let released = gateway.handle(RpcRequest {
                            jsonrpc:"2.0".into(),id:Some(RpcId::String("release-app-steer".into())),
                            method:"desktop.hostTools.complete.v1".into(),
                            params:Some(serde_json::json!({"callId":invoke.call_id,"outcome":{"kind":"result","value":{"total":7}}})),
                        }, RequestContext::local()).await;
                        assert!(released.error.is_none(), "{released:?}");
                        let receipt = tokio::time::timeout(Duration::from_secs(10), steering)
                            .await.unwrap().unwrap().unwrap();
                        assert_eq!(receipt["runId"], run_id);
                        assert_eq!(receipt["mode"], "steering_submitted");
                        assert_eq!(receipt["runtimeReceipt"]["handling_mode"], "steer");
                        wait_for_real_mobkit_terminal_event(&mut events, &run_id, "run.completed").await;
                        assert!(handle.state.lock().await.active_runs.is_empty());
                        assert_eq!(scripted.observed_requests.lock().unwrap().len(), 2);
                        assert!(!scripted.observed_requests.lock().unwrap()[0].contains("APP-LIVE-STEER-923"));
                        assert_eq!(scripted.observed_requests.lock().unwrap()[1].matches("APP-LIVE-STEER-923").count(), 1);
                        assert!(events.try_recv().is_err(), "application terminal must emit exactly once");
                        assert_eq!(super::lookup_terminal_run(std::path::Path::new(&state_root), &run_id).unwrap()["status"], "completed");
                        let mob = handle.state.lock().await.mobkit.get(&mob_id).await.unwrap();
                        let runtime = mob.runtime.as_ref().unwrap();
                        let session_id = runtime.mob_handle().resolve_bridge_session_id(&meerkat_mob::AgentIdentity::from("ingress"))
                            .await.unwrap();
                        let history = super::read_session_history_messages(runtime, &session_id.to_string()).await.unwrap();
                        let steer_rows = history.iter().filter(|row| {
                            row["role"] == "user"
                                && super::message_text_for_matching(row) == "APP-LIVE-STEER-923"
                        }).collect::<Vec<_>>();
                        assert_eq!(steer_rows.len(), 1, "steering must commit exactly once");
                        let committed_steer = steer_rows[0].clone();
                        let history = serde_json::to_string(&history).unwrap();
                        assert!(history.contains("APP-STEER-ORIGINAL-167"));
                        assert!(history.contains("Synthetic host tool completed."));
                        let next = start_real_mobkit_host_tool_turn(
                            &gateway, "after-app-steer", &project_path, &state_root,
                            "NEXT-AFTER-STEER-634", false,
                        ).await;
                        assert!(next.error.is_none(), "{next:?}");
                        let next_run = next.result.unwrap()["runId"].as_str().unwrap().to_owned();
                        assert_ne!(next_run, run_id);
                        wait_for_real_mobkit_terminal_event(&mut events, &next_run, "run.completed").await;
                        let history = super::read_session_history_messages(runtime, &session_id.to_string()).await.unwrap();
                        assert!(serde_json::to_string(&history).unwrap().contains("NEXT-AFTER-STEER-634"));
                        let steer_rows = history.iter().filter(|row| {
                            row["role"] == "user"
                                && super::message_text_for_matching(row) == "APP-LIVE-STEER-923"
                        }).collect::<Vec<_>>();
                        assert_eq!(steer_rows.len(), 1, "the next turn must not reappend steering");
                        assert_eq!(steer_rows[0], &committed_steer);
                        assert_eq!(scripted.observed_requests.lock().unwrap().len(), 4);
                        {
                            let requests = scripted.observed_requests.lock().unwrap();
                            let next_request = &requests[2];
                            assert!(next_request.contains("APP-STEER-ORIGINAL-167"));
                            assert!(next_request.contains("Synthetic host tool completed."));
                            assert!(next_request.contains("NEXT-AFTER-STEER-634"));
                            // Typed User steering is durable native transcript history.
                            assert_eq!(next_request.matches("APP-LIVE-STEER-923").count(), 1);
                            assert_eq!(requests[3].matches("APP-LIVE-STEER-923").count(), 1);
                        }
                        destroy_real_mobkit_host_tool_fixture(gateway, &fixture, &project_path, &state_root).await;
                    });
            }).unwrap().join().unwrap();
    }

    #[test]
    fn tracked_mobkit_steering_observes_active_and_idle_delivery() {
        std::thread::Builder::new()
            .name("tracked-mobkit-steering-proof".into())
            .stack_size(16 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .thread_stack_size(16 * 1024 * 1024)
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(tracked_mobkit_steering_proof());
            })
            .unwrap()
            .join()
            .unwrap();
    }

    async fn tracked_mobkit_steering_proof() {
        if std::env::var_os("MEERKAT_TEST_STEER_TRACE").is_some() {
            let _ = tracing_subscriber::fmt()
                .with_env_filter("warn,meerkat_runtime=debug")
                .with_ansi(false)
                .with_writer(std::io::stderr)
                .try_init();
        }
        let (fixture, project_path, state_root, gateway, scripted_llm) =
            setup_real_mobkit_host_tool_fixture("tracked-steering", 1).await;
        let mob_id = real_mobkit_fixture_mob_id(&project_path);
        let runtime_handle = gateway
            .project_runtime_handle_for_paths(
                &project_path,
                &project_path,
                "local".into(),
                Some(&state_root),
            )
            .await
            .unwrap();
        let mob = runtime_handle
            .state
            .lock()
            .await
            .mobkit
            .get(&mob_id)
            .await
            .unwrap();
        let runtime = mob.runtime.as_ref().unwrap();
        let mut host_notifications = gateway.subscribe_host_tool_notifications();
        let mut gateway_events = gateway.subscribe_events();
        let active = start_real_mobkit_host_tool_turn(
            &gateway,
            "active-before-steer",
            &project_path,
            &state_root,
            "Hold the host tool open until steering arrives.",
            true,
        )
        .await;
        assert!(active.error.is_none(), "{active:?}");
        let active_run_id = active.result.as_ref().unwrap()["runId"]
            .as_str()
            .unwrap()
            .to_string();
        let invoke = tokio::time::timeout(Duration::from_secs(10), host_notifications.recv())
            .await
            .unwrap()
            .unwrap();
        let DesktopHostToolNotificationV1::Invoke(invoke) = invoke else {
            panic!("expected host tool invocation");
        };
        let (live_tx, mut live_rx) = tokio::sync::mpsc::channel(128);
        let steer_runtime = Arc::clone(runtime);
        let pending_live = tokio::spawn(async move {
            let mut live = steer_runtime
                .start_member_turn(
                    "ingress",
                    meerkat_core::ContentInput::Text("LIVE-STEER-PROOF-842".into()),
                    meerkat_core::types::HandlingMode::Steer,
                    meerkat_mob::MemberTurnOptions::new(),
                    Some(live_tx),
                )
                .await
                .expect("tracked live steer admission");
            assert_eq!(
                live.turn.wait_for_applied_llm_identity().await.unwrap(),
                None
            );
            live
        });
        // Steering waits for the current tool's context boundary. Keep the
        // tool alive while the real actor receives the concurrent admission.
        tokio::time::sleep(Duration::from_millis(250)).await;
        let live_observer = tokio::spawn(async move {
            let mut events = Vec::new();
            while let Some(event) = live_rx.recv().await {
                events.push(serde_json::to_value(event).unwrap());
            }
            events
        });
        let completed = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".into(),
                    id: Some(RpcId::String("release-for-steer".into())),
                    method: "desktop.hostTools.complete.v1".into(),
                    params: Some(serde_json::json!({
                        "callId": invoke.call_id,
                        "outcome": {"kind": "result", "value": {"total": 7}}
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert!(completed.error.is_none(), "{completed:?}");
        let live = tokio::time::timeout(Duration::from_secs(10), pending_live)
            .await
            .expect("live steer admission timeout")
            .unwrap();
        assert_eq!(
            live.turn.receipt().handling_mode,
            meerkat_core::types::HandlingMode::Steer
        );
        tokio::time::timeout(Duration::from_secs(10), live.turn.wait())
            .await
            .expect("live steer completion timeout")
            .expect("live steer completion");
        let live_events = tokio::time::timeout(Duration::from_secs(10), live_observer)
            .await
            .expect("live event stream close timeout")
            .unwrap();
        wait_for_real_mobkit_terminal_event(&mut gateway_events, &active_run_id, "run.completed")
            .await;
        let active_requests = scripted_llm.observed_requests.lock().unwrap().clone();
        assert_eq!(active_requests.len(), 2);
        assert!(active_requests[1].contains("LIVE-STEER-PROOF-842"));
        assert!(
            live_events.is_empty(),
            "live steering does not create a second executor stream"
        );

        let (idle_fixture, idle_project_path, idle_state_root, idle_gateway, idle_llm) =
            setup_real_mobkit_host_tool_fixture("tracked-idle-steering", 1).await;
        let idle_mob_id = real_mobkit_fixture_mob_id(&idle_project_path);
        let idle_runtime_handle = idle_gateway
            .project_runtime_handle_for_paths(
                &idle_project_path,
                &idle_project_path,
                "local".into(),
                Some(&idle_state_root),
            )
            .await
            .unwrap();
        let idle_mob = idle_runtime_handle
            .state
            .lock()
            .await
            .mobkit
            .get(&idle_mob_id)
            .await
            .unwrap();
        let idle_runtime = idle_mob.runtime.as_ref().unwrap();
        let (idle_tx, mut idle_rx) = tokio::sync::mpsc::channel(128);
        let mut idle = idle_runtime
            .start_member_turn(
                "ingress",
                meerkat_core::ContentInput::Text("IDLE-STEER-PROOF-391".into()),
                meerkat_core::types::HandlingMode::Steer,
                meerkat_mob::MemberTurnOptions::new(),
                Some(idle_tx),
            )
            .await
            .expect("tracked idle steer admission");
        assert_eq!(
            idle.turn.wait_for_applied_llm_identity().await.unwrap(),
            None
        );
        assert_eq!(
            idle.turn.receipt().handling_mode,
            meerkat_core::types::HandlingMode::Steer
        );
        let idle_observer = tokio::spawn(async move {
            let mut events = Vec::new();
            while let Some(event) = idle_rx.recv().await {
                events.push(serde_json::to_value(event).unwrap());
            }
            events
        });
        tokio::time::timeout(Duration::from_secs(10), idle.turn.wait())
            .await
            .expect("idle steer completion timeout")
            .expect("idle steer completion");
        let idle_events = tokio::time::timeout(Duration::from_secs(10), idle_observer)
            .await
            .expect("idle event stream close timeout")
            .unwrap();
        let requests = idle_llm.observed_requests.lock().unwrap().clone();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].contains("IDLE-STEER-PROOF-391"));
        assert_eq!(
            idle_events.first().unwrap()["payload"]["type"],
            "run_started"
        );
        assert_eq!(
            idle_events.first().unwrap()["payload"]["input"]["content"],
            "IDLE-STEER-PROOF-391"
        );
        assert_eq!(
            idle_events.last().unwrap()["payload"]["type"],
            "run_completed"
        );
        destroy_real_mobkit_host_tool_fixture(
            idle_gateway,
            &idle_fixture,
            &idle_project_path,
            &idle_state_root,
        )
        .await;
        destroy_real_mobkit_host_tool_fixture(gateway, &fixture, &project_path, &state_root).await;
    }

    #[test]
    fn steering_rejects_stale_targets_before_runtime_mutation() {
        std::thread::Builder::new()
            .name("mobkit-strict-steering-proof".to_string())
            .stack_size(16 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .thread_stack_size(16 * 1024 * 1024)
                    .enable_all()
                    .build()
                    .expect("build steering proof runtime")
                    .block_on(async {
                        let (fixture, project_path, state_root, gateway, scripted_llm) =
                            setup_real_mobkit_host_tool_fixture("strict-steering", 1).await;
                        let mob_id = real_mobkit_fixture_mob_id(&project_path);
                        let handle = gateway
                            .project_runtime_handle_for_paths(
                                &project_path,
                                &project_path,
                                "local".to_string(),
                                Some(&state_root),
                            )
                            .await
                            .unwrap();
                        let mut events = gateway.subscribe_events();
                        let initial_streams = scripted_llm.streams.load(Ordering::SeqCst);
                        let base = serde_json::json!({
                            "projectPath": project_path,
                            "executionPath": project_path,
                            "stateRoot": state_root,
                            "configStateRoot": state_root,
                            "threadId": "thread-host-tool-proof",
                            "mobId": mob_id,
                            "agentIdentity": "ingress",
                            "input": "This input must never become a runtime turn.",
                            "handlingMode": "steer",
                            "expectedRunId": "active-run",
                        });
                        // An idle member would otherwise accept Steer as a
                        // fresh turn. Reject it at the gateway before send.
                        let idle = gateway.mobs_turn_start(Some(&base)).await.unwrap_err();
                        assert!(matches!(
                            idle,
                            super::GatewayError::Api {
                                typed_code: "CONFLICT",
                                ..
                            }
                        ));
                        assert!(handle.state.lock().await.active_runs.is_empty());

                        // Target validation is against the still-open
                        // application run before reserving native delivery.
                        handle.state.lock().await.active_runs.insert(
                            "thread-host-tool-proof".into(),
                            ActiveRun {
                                run_id: "active-run".into(),
                                mob_id: mob_id.clone(),
                                agent_identity: "ingress".into(),
                                started_at: chrono::Utc::now(),
                                deliveries: AppRunDeliveries::default(),
                                projection: Arc::new(Mutex::new(RunEventProjection::default())),
                            },
                        );
                        let cases = [
                            ("expectedRunId", serde_json::json!("stale-run"), "CONFLICT"),
                            (
                                "agentIdentity",
                                serde_json::json!("other-member"),
                                "CONFLICT",
                            ),
                            ("expectedRunId", serde_json::Value::Null, "INVALID_PARAMS"),
                            ("handlingMode", serde_json::json!("queue"), "INVALID_PARAMS"),
                        ];
                        for (field, value, expected_code) in cases {
                            let mut params = base.clone();
                            params[field] = value;
                            let rejected =
                                gateway.mobs_turn_start(Some(&params)).await.unwrap_err();
                            let super::GatewayError::Api { typed_code, .. } = rejected;
                            assert_eq!(typed_code, expected_code, "rejection for {field}");
                        }
                        for pending in [true, false] {
                            {
                                let mut state = handle.state.lock().await;
                                let active =
                                    state.active_runs.get_mut("thread-host-tool-proof").unwrap();
                                active.deliveries.cancellation_requests_pending =
                                    usize::from(pending);
                                active.deliveries.cancellation_requested = !pending;
                            }
                            assert!(matches!(
                                gateway.mobs_turn_start(Some(&base)).await.unwrap_err(),
                                super::GatewayError::Api {
                                    typed_code: "CONFLICT",
                                    ..
                                }
                            ));
                            assert_eq!(
                                handle.state.lock().await.active_runs["thread-host-tool-proof"]
                                    .deliveries
                                    .pending,
                                1
                            );
                        }
                        {
                            let mut state = handle.state.lock().await;
                            let active =
                                state.active_runs.get_mut("thread-host-tool-proof").unwrap();
                            active.deliveries.cancellation_requested = false;
                            active.deliveries.cancellation_requests_pending = 0;
                        }
                        handle
                            .state
                            .lock()
                            .await
                            .active_runs
                            .get_mut("thread-host-tool-proof")
                            .unwrap()
                            .mob_id = "other-mob".into();
                        assert!(matches!(
                            gateway.mobs_turn_start(Some(&base)).await.unwrap_err(),
                            super::GatewayError::Api {
                                typed_code: "CONFLICT",
                                ..
                            }
                        ));
                        assert_eq!(scripted_llm.streams.load(Ordering::SeqCst), initial_streams);
                        assert!(
                            events.try_recv().is_err(),
                            "rejected steer emitted a run event"
                        );
                        let state = handle.state.lock().await;
                        assert_eq!(state.active_runs.len(), 1);
                        assert_eq!(
                            state.active_runs["thread-host-tool-proof"].run_id,
                            "active-run"
                        );
                        assert!(super::lookup_terminal_run(
                            std::path::Path::new(&state_root),
                            "active-run"
                        )
                        .is_none());
                        drop(state);
                        drop(gateway);
                        let _ = std::fs::remove_dir_all(fixture);
                    });
            })
            .expect("spawn steering proof thread")
            .join()
            .expect("steering proof thread");
    }

    #[test]
    fn real_mobkit_turn_acknowledges_applied_identity_before_visible_run_events() {
        std::thread::Builder::new()
            .name("mobkit-applied-identity-proof".to_string())
            .stack_size(16 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .thread_stack_size(16 * 1024 * 1024)
                    .enable_all()
                    .build()
                    .expect("build applied-identity proof runtime")
                    .block_on(real_mobkit_applied_identity_proof());
            })
            .expect("spawn applied-identity proof thread")
            .join()
            .expect("applied-identity proof thread");
    }

    async fn real_mobkit_applied_identity_proof() {
        let (fixture, project_path, state_root, gateway, _scripted_llm) =
            setup_real_mobkit_host_tool_fixture("applied-identity", 1).await;
        let mob_id = real_mobkit_fixture_mob_id(&project_path);
        let runtime_handle = gateway
            .project_runtime_handle_for_paths(
                &project_path,
                &project_path,
                "local".to_string(),
                Some(&state_root),
            )
            .await
            .expect("project runtime");
        let mob = {
            let state = runtime_handle.state.lock().await;
            state.mobkit.get(&mob_id).await.expect("proof mob")
        };
        let runtime = mob.runtime.as_ref().expect("local MobKit runtime");
        let runtime_adapter = runtime
            .mob_runtime()
            .session_service()
            .expect("session service")
            .acquire_runtime_adapter(None)
            .expect("session runtime adapter acquisition")
            .expect("session runtime adapter");
        assert!(
            runtime_adapter.has_session_llm_reconfigure_host(),
            "desktop bootstrap must install the canonical session LLM reconfigure host"
        );

        // A real MobKit rejection must leave the gateway reservation and
        // forwarder intact. Use an unknown member while the known mob is live.
        let rejected_forwarder = tokio::spawn(std::future::pending::<()>());
        runtime_handle.state.lock().await.active_runs.insert(
            "missing-member-thread".into(),
            ActiveRun {
                run_id: "missing-member-run".into(),
                mob_id: mob_id.clone(),
                agent_identity: "unknown-member".into(),
                started_at: chrono::Utc::now(),
                deliveries: AppRunDeliveries::default(),
                projection: Arc::new(Mutex::new(RunEventProjection::default())),
            },
        );
        let mut rejection_events = gateway.subscribe_events();
        let rejected = gateway
            .mobs_force_cancel(Some(&serde_json::json!({
                "projectPath": project_path, "executionPath": project_path, "stateRoot": state_root,
                "threadId": "missing-member-thread", "runId": "missing-member-run",
                "mobId": mob_id, "agentIdentity": "unknown-member",
            })))
            .await;
        assert!(
            rejected.is_err(),
            "runtime must reject cancellation for an unknown member"
        );
        assert!(runtime_handle
            .state
            .lock()
            .await
            .active_runs
            .contains_key("missing-member-thread"));
        assert!(!rejected_forwarder.is_finished());
        assert!(rejection_events.try_recv().is_err());
        assert!(super::lookup_terminal_run(
            std::path::Path::new(&state_root),
            "missing-member-run"
        )
        .is_none());
        runtime_handle
            .state
            .lock()
            .await
            .active_runs
            .remove("missing-member-thread");
        rejected_forwarder.abort();
        let _ = rejected_forwarder.await;

        let mut host_notifications = gateway.subscribe_host_tool_notifications();
        let mut events = gateway.subscribe_events();
        let turn = tokio::time::timeout(
            Duration::from_secs(60),
            gateway.handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String("applied-identity-turn".to_string())),
                    method: "mobs.v1.turnStart".to_string(),
                    params: Some(serde_json::json!({
                        "projectPath": project_path,
                        "executionPath": project_path,
                        "stateRoot": state_root,
                        "configStateRoot": state_root,
                        "threadId": "thread-host-tool-proof",
                        "mobId": mob_id,
                        "agentIdentity": "ingress",
                        "input": "Apply the exact requested model before this turn.",
                        "model": "gpt-5.4",
                        "provider": "openai",
                        "providerParams": null,
                        "ingressKind": "desktop_interactive_turn"
                    })),
                },
                RequestContext::local(),
            ),
        )
        .await
        .expect("turn identity acknowledgement timeout");
        assert!(turn.error.is_none(), "identity turn failed: {turn:?}");
        let turn_result = turn.result.as_ref().expect("identity turn result");
        assert_eq!(turn_result["appliedModel"], "gpt-5.4");
        assert_eq!(turn_result["appliedProvider"], "openai");
        let run_id = turn_result["runId"]
            .as_str()
            .expect("identity run id")
            .to_string();

        let first_run_event = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let event = events.recv().await.expect("identity run event");
                if event.run_id.as_deref() == Some(run_id.as_str()) {
                    break event;
                }
            }
        })
        .await
        .expect("identity run.started timeout");
        assert_eq!(
            first_run_event.kind, "run.started",
            "no run output may become visible before authoritative identity acknowledgement"
        );
        assert_eq!(first_run_event.payload["appliedModel"], "gpt-5.4");
        assert_eq!(first_run_event.payload["appliedProvider"], "openai");

        let rejected_steer = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String("identity-steer-reject".to_string())),
                    method: "mobs.v1.turnStart".to_string(),
                    params: Some(serde_json::json!({
                        "projectPath": project_path,
                        "executionPath": project_path,
                        "stateRoot": state_root,
                        "configStateRoot": state_root,
                        "threadId": "thread-host-tool-proof",
                        "mobId": mob_id,
                        "agentIdentity": "ingress",
                        "input": "Do not allow identity mutation through steering.",
                        "handlingMode": "steer",
                        "model": "gpt-5.6-sol",
                        "provider": "openai",
                        "providerParams": null
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert_eq!(
            rejected_steer
                .error
                .as_ref()
                .map(|error| error.data.code.as_str()),
            Some("INVALID_PARAMS")
        );

        let notification = tokio::time::timeout(Duration::from_secs(30), host_notifications.recv())
            .await
            .expect("host invocation timeout")
            .expect("host invocation");
        assert!(matches!(
            notification,
            DesktopHostToolNotificationV1::Invoke(_)
        ));
        let cancel = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String("identity-turn-cancel".to_string())),
                    method: "mobs.v1.forceCancel".to_string(),
                    params: Some(serde_json::json!({
                        "projectPath": project_path,
                        "executionPath": project_path,
                        "stateRoot": state_root,
                        "threadId": "thread-host-tool-proof",
                        "runId": run_id,
                        "mobId": mob_id,
                        "agentIdentity": "ingress"
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert!(cancel.error.is_none(), "identity run cancel: {cancel:?}");
        assert_eq!(cancel.result.as_ref().unwrap()["status"], "cancelling");
        assert_eq!(
            cancel.result.as_ref().unwrap()["cancellationRequested"],
            true
        );
        assert_eq!(cancel.result.as_ref().unwrap()["runtimeCancelled"], false);
        wait_for_real_mobkit_terminal_event(&mut events, &run_id, "run.cancelled").await;
        assert_eq!(
            super::lookup_terminal_run(std::path::Path::new(&state_root), &run_id).unwrap()
                ["status"],
            "cancelled"
        );
        destroy_real_mobkit_host_tool_fixture(gateway, &fixture, &project_path, &state_root).await;
    }

    #[test]
    fn host_tool_rpc_methods_use_closed_request_and_ack_shapes() {
        std::thread::Builder::new()
            .name("host-tool-rpc-shapes".to_string())
            .stack_size(16 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("build host-tool RPC test runtime")
                    .block_on(host_tool_rpc_shapes_proof());
            })
            .expect("spawn host-tool RPC test thread")
            .join()
            .expect("host-tool RPC test thread");
    }

    async fn host_tool_rpc_shapes_proof() {
        let gateway = MeerkatGateway::new();
        let configure = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String("configure".to_string())),
                    method: "desktop.hostTools.configure.v1".to_string(),
                    params: Some(serde_json::json!({
                        "protocolVersion": 1,
                        "enabled": true,
                        "toolDefinitions": [{
                            "name": "synthetic_echo",
                            "description": "Synthetic host-neutral proof",
                            "inputSchema": {
                                "type": "object",
                                "additionalProperties": false
                            },
                            "resultSchema": {
                                "type": "object",
                                "additionalProperties": false
                            },
                            "capabilityErrorSchema": {
                                "type": "object",
                                "additionalProperties": false
                            }
                        }]
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert_eq!(
            configure.result,
            Some(serde_json::json!({"protocolVersion": 1, "enabled": true}))
        );
        assert!(configure.error.is_none());

        let unmatched_complete = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String("complete".to_string())),
                    method: "desktop.hostTools.complete.v1".to_string(),
                    params: Some(serde_json::json!({
                        "callId": "unknown-call",
                        "outcome": {"kind": "result", "value": {}}
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert_eq!(
            unmatched_complete
                .error
                .as_ref()
                .map(|error| error.data.code.as_str()),
            Some("INVALID_ENVELOPE")
        );

        let notification_shaped_request = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: None,
                    method: "desktop.hostTools.configure.v1".to_string(),
                    params: Some(serde_json::json!({
                        "protocolVersion": 1,
                        "enabled": false,
                        "toolDefinitions": []
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert_eq!(
            notification_shaped_request
                .error
                .as_ref()
                .map(|error| error.data.code.as_str()),
            Some("INVALID_ENVELOPE")
        );
    }

    #[test]
    fn foreground_mobkit_turn_routes_host_tool_overlay_and_completes_through_rpc() {
        std::thread::Builder::new()
            .name("foreground-mobkit-host-tool-proof".to_string())
            .stack_size(16 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .thread_stack_size(16 * 1024 * 1024)
                    .enable_all()
                    .build()
                    .expect("build host-tool proof runtime")
                    .block_on(foreground_mobkit_host_tool_proof());
            })
            .expect("spawn host-tool proof thread")
            .join()
            .expect("host-tool proof thread");
    }

    async fn foreground_mobkit_host_tool_proof() {
        let (fixture, project_path_string, state_root_string, gateway, scripted_llm) =
            setup_real_mobkit_host_tool_fixture("foreground-host-tool", 2).await;
        let mob_id = real_mobkit_fixture_mob_id(&project_path_string);

        let mut host_notifications = gateway.subscribe_host_tool_notifications();
        let mut events = gateway.subscribe_events();
        let foreground_turn = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String("foreground-turn".to_string())),
                    method: "mobs.v1.turnStart".to_string(),
                    params: Some(serde_json::json!({
                        "projectPath": project_path_string,
                        "executionPath": project_path_string,
                        "stateRoot": state_root_string,
                        "threadId": "thread-host-tool-proof",
                        "mobId": mob_id,
                        "agentIdentity": "ingress",
                        "input": "Use the configured synthetic counter now.",
                        "ingressKind": "desktop_interactive_turn"
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert!(
            foreground_turn.error.is_none(),
            "foreground turn failed to start: {foreground_turn:?}"
        );
        let foreground_result = foreground_turn.result.as_ref().expect("turn result");
        assert_eq!(foreground_result["status"], serde_json::json!("running"));
        let foreground_run_id = foreground_result["runId"]
            .as_str()
            .expect("foreground run id")
            .to_string();

        let first_invoke = tokio::time::timeout(Duration::from_secs(30), host_notifications.recv())
            .await
            .expect("foreground host invocation timeout")
            .expect("foreground host invocation channel");
        let DesktopHostToolNotificationV1::Invoke(first_invoke) = first_invoke else {
            panic!("expected a reverse host-tool invocation, got {first_invoke:?}");
        };
        assert_eq!(first_invoke.tool_name, "synthetic_counter");
        assert_eq!(first_invoke.arguments, serde_json::json!({"increment": 7}));
        assert_eq!(first_invoke.browser_invocation_id, foreground_run_id);
        assert_eq!(first_invoke.witness.run_id, foreground_run_id);
        assert_eq!(
            first_invoke.witness.browser_invocation_id,
            foreground_run_id
        );
        assert_eq!(first_invoke.witness.thread_id, "thread-host-tool-proof");
        assert_eq!(first_invoke.witness.mob_id, mob_id);
        assert_eq!(first_invoke.witness.member_binding, "ingress");
        assert_eq!(
            first_invoke.witness.realm_id,
            foreground_result["realmId"].as_str().expect("turn realm")
        );
        assert_eq!(
            first_invoke.witness.runtime_instance_id,
            foreground_result["instanceId"]
                .as_str()
                .expect("turn runtime instance")
        );
        assert_eq!(
            first_invoke.witness.tool_host_connection_id,
            gateway.host_tool_connection_id()
        );
        assert_eq!(first_invoke.witness.principal_version, 1);
        assert_eq!(first_invoke.witness.witness_version, 1);
        assert!(!first_invoke.witness.nonce.is_empty());
        assert!(matches!(
            first_invoke.witness.principal_kind,
            crate::host_tools::HostPrincipalKind::LocalForegroundIngress
        ));
        assert!(matches!(
            first_invoke.witness.ingress_kind,
            crate::host_tools::HostIngressKind::DesktopInteractiveTurn
        ));
        let first_call_id = first_invoke.call_id.clone();
        let invocation_witness = first_invoke.witness.clone();

        let first_completion = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String("complete-synthetic-first".to_string())),
                    method: "desktop.hostTools.complete.v1".to_string(),
                    params: Some(serde_json::json!({
                        "callId": first_call_id,
                        "outcome": {
                            "kind": "result",
                            "value": {"total": 7}
                        }
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert!(
            first_completion.error.is_none(),
            "first completion failed: {first_completion:?}"
        );
        assert_eq!(
            first_completion
                .result
                .as_ref()
                .and_then(|result| result.get("received"))
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );

        // Completing the first call resumes the same MobKit turn through
        // PendingToolResults. Its next host call must retain the exact private
        // witness while receiving a fresh per-call transport identity.
        let second_invoke =
            tokio::time::timeout(Duration::from_secs(30), host_notifications.recv())
                .await
                .expect("continued host invocation timeout")
                .expect("continued host invocation channel");
        let DesktopHostToolNotificationV1::Invoke(second_invoke) = second_invoke else {
            panic!("expected a continued reverse host-tool invocation, got {second_invoke:?}");
        };
        assert_eq!(second_invoke.tool_name, "synthetic_counter");
        assert_eq!(
            second_invoke.arguments,
            serde_json::json!({"increment": 11})
        );
        assert_ne!(second_invoke.call_id, first_call_id);
        assert_eq!(second_invoke.browser_invocation_id, foreground_run_id);
        assert_eq!(second_invoke.witness, invocation_witness);

        let second_completion = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String("complete-synthetic-second".to_string())),
                    method: "desktop.hostTools.complete.v1".to_string(),
                    params: Some(serde_json::json!({
                        "callId": second_invoke.call_id,
                        "outcome": {
                            "kind": "result",
                            "value": {"total": 18}
                        }
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert!(
            second_completion.error.is_none(),
            "second completion failed: {second_completion:?}"
        );
        assert_eq!(
            second_completion
                .result
                .as_ref()
                .and_then(|result| result.get("received"))
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );

        let foreground_final = tokio::time::timeout(Duration::from_secs(30), async {
            let mut final_text = None;
            loop {
                let event = events.recv().await.expect("foreground run event");
                if event.run_id.as_deref() != Some(foreground_run_id.as_str()) {
                    continue;
                }
                if event.kind == "run.output.complete" {
                    final_text = event.payload.get("text").cloned();
                }
                if event.kind == "run.completed" {
                    break final_text;
                }
                assert_ne!(event.kind, "run.failed", "foreground run failed: {event:?}");
            }
        })
        .await
        .expect("foreground MobKit run completion timeout");
        assert_eq!(
            foreground_final,
            Some(serde_json::json!("Synthetic host tool completed."))
        );

        let foreground_status = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String("foreground-status".to_string())),
                    method: "mobs.v1.runStatus".to_string(),
                    params: Some(serde_json::json!({
                        "projectPath": project_path_string,
                        "stateRoot": state_root_string,
                        "runId": foreground_run_id
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert_eq!(
            foreground_status
                .result
                .as_ref()
                .and_then(|result| result.get("status"))
                .and_then(serde_json::Value::as_str),
            Some("completed")
        );

        // The same real local member and configured tool remain in place, but
        // this internal/unmarked turn gets no TurnToolOverlay. It must receive
        // the dispatcher-owned capability error without any reverse host call.
        let background_turn = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String("background-turn".to_string())),
                    method: "mobs.v1.turnStart".to_string(),
                    params: Some(serde_json::json!({
                        "projectPath": project_path_string,
                        "executionPath": project_path_string,
                        "stateRoot": state_root_string,
                        "threadId": "thread-host-tool-proof",
                        "mobId": mob_id,
                        "agentIdentity": "ingress",
                        "input": "Internal turn must not inherit host authority."
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert!(
            background_turn.error.is_none(),
            "background turn failed to start: {background_turn:?}"
        );
        let background_run_id = background_turn
            .result
            .as_ref()
            .and_then(|result| result.get("runId"))
            .and_then(serde_json::Value::as_str)
            .expect("background run id")
            .to_string();
        let background_final = tokio::time::timeout(Duration::from_secs(30), async {
            let mut final_text = None;
            loop {
                tokio::select! {
                    notification = host_notifications.recv() => {
                        panic!("unmarked turn reached the reverse host channel: {notification:?}");
                    }
                    event = events.recv() => {
                        let event = event.expect("background run event");
                        if event.run_id.as_deref() != Some(background_run_id.as_str()) {
                            continue;
                        }
                        if event.kind == "run.output.complete" {
                            final_text = event.payload.get("text").cloned();
                        }
                        if event.kind == "run.completed" {
                            break final_text;
                        }
                        assert_ne!(event.kind, "run.failed", "background run failed: {event:?}");
                    }
                }
            }
        })
        .await
        .expect("background MobKit run completion timeout");
        assert_eq!(
            background_final,
            Some(serde_json::json!("Synthetic host tool completed."))
        );
        assert_eq!(
            scripted_llm
                .tool_surface_observations
                .load(Ordering::SeqCst),
            4,
            "two generic tool steps must reach the model on both real turns"
        );
        assert_eq!(
            scripted_llm.streams.load(Ordering::SeqCst),
            6,
            "each real turn must execute two tool-use steps and one final step"
        );
        assert_eq!(
            scripted_llm
                .native_mob_prompt_observations
                .load(Ordering::SeqCst),
            6,
            "every real model request must receive native MobKit guidance matching its tools"
        );
        assert_eq!(
            scripted_llm
                .capability_error_observations
                .load(Ordering::SeqCst),
            1,
            "only the unmarked turn must receive CAPABILITY_UNAVAILABLE from the dispatcher"
        );
        assert_eq!(
            scripted_llm
                .missing_tool_surface_observations
                .load(Ordering::SeqCst),
            0
        );

        destroy_real_mobkit_host_tool_fixture(
            gateway,
            &fixture,
            &project_path_string,
            &state_root_string,
        )
        .await;
    }

    #[test]
    fn foreground_mobkit_live_call_is_cancelled_before_run_end_settles() {
        std::thread::Builder::new()
            .name("foreground-mobkit-run-end-proof".to_string())
            .stack_size(16 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .thread_stack_size(16 * 1024 * 1024)
                    .enable_all()
                    .build()
                    .expect("build run-end proof runtime")
                    .block_on(foreground_mobkit_run_end_proof());
            })
            .expect("spawn run-end proof thread")
            .join()
            .expect("run-end proof thread");
    }

    async fn foreground_mobkit_run_end_proof() {
        let (fixture, project_path, state_root, gateway, _scripted_llm) =
            setup_real_mobkit_host_tool_fixture("foreground-run-end", 1).await;
        let mob_id = real_mobkit_fixture_mob_id(&project_path);
        let mut host_notifications = gateway.subscribe_host_tool_notifications();
        let mut events = gateway.subscribe_events();

        let turn = start_real_mobkit_host_tool_turn(
            &gateway,
            "run-end-turn",
            &project_path,
            &state_root,
            "Keep the synthetic host call live until cancellation.",
            true,
        )
        .await;
        assert!(
            turn.error.is_none(),
            "run-end turn failed to start: {turn:?}"
        );
        let run_id = turn
            .result
            .as_ref()
            .and_then(|result| result.get("runId"))
            .and_then(serde_json::Value::as_str)
            .expect("run-end run id")
            .to_string();

        let invoke = tokio::time::timeout(Duration::from_secs(30), host_notifications.recv())
            .await
            .expect("run-end invoke timeout")
            .expect("run-end invoke channel");
        let DesktopHostToolNotificationV1::Invoke(invoke) = invoke else {
            panic!("expected live invoke before run end, got {invoke:?}");
        };
        let call_id = invoke.call_id.clone();
        assert_eq!(invoke.witness.run_id, run_id);

        let cancel_gateway = gateway.clone();
        let cancel_project_path = project_path.clone();
        let cancel_state_root = state_root.clone();
        let cancel_run_id = run_id.clone();
        let cancel_request = async move {
            cancel_gateway
                .handle(
                    RpcRequest {
                        jsonrpc: "2.0".to_string(),
                        id: Some(RpcId::String("force-cancel-live-call".to_string())),
                        method: "mobs.v1.forceCancel".to_string(),
                        params: Some(serde_json::json!({
                            "projectPath": cancel_project_path,
                            "executionPath": cancel_project_path,
                            "stateRoot": cancel_state_root,
                            "threadId": "thread-host-tool-proof",
                            "runId": cancel_run_id,
                            "mobId": mob_id,
                            "agentIdentity": "ingress"
                        })),
                    },
                    RequestContext::local(),
                )
                .await
        };
        let cancel_response = cancel_request.await;
        assert!(
            cancel_response.error.is_none(),
            "forceCancel failed: {cancel_response:?}"
        );
        // A response can be polled in the same scheduler tick that enqueues
        // the notification. Inspect the channel after the response to prove
        // the host call was fenced before acknowledgement, without imposing
        // an ordering on which ready future the test executor polls first.
        let cancel = host_notifications
            .try_recv()
            .expect("host call cancelled before response");
        let DesktopHostToolNotificationV1::Cancel(cancel) = cancel else {
            panic!("expected run-end cancel notification, got {cancel:?}");
        };
        assert_eq!(cancel.call_id, call_id);
        assert_eq!(
            cancel.reason,
            crate::host_tools::DesktopHostToolCancelReasonV1::RunEnded
        );
        assert_eq!(
            cancel_response.result.as_ref().unwrap()["status"],
            "cancelling"
        );
        assert_eq!(cancel_response.result.as_ref().unwrap()["cancelled"], false);
        assert_eq!(
            cancel_response.result.as_ref().unwrap()["cancellationRequested"],
            true
        );
        assert_eq!(
            wait_for_real_mobkit_terminal_event(&mut events, &run_id, "run.cancelled").await,
            None
        );

        let status = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String("cancelled-status".to_string())),
                    method: "mobs.v1.runStatus".to_string(),
                    params: Some(serde_json::json!({
                        "projectPath": project_path,
                        "stateRoot": state_root,
                        "runId": run_id
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert_eq!(
            status
                .result
                .as_ref()
                .and_then(|result| result.get("status"))
                .and_then(serde_json::Value::as_str),
            Some("cancelled")
        );

        let late_completion = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String("late-run-end-completion".to_string())),
                    method: "desktop.hostTools.complete.v1".to_string(),
                    params: Some(serde_json::json!({
                        "callId": call_id,
                        "outcome": {"kind": "result", "value": {"total": 7}}
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert_eq!(
            late_completion
                .error
                .as_ref()
                .map(|error| error.data.code.as_str()),
            Some("INVALID_ENVELOPE")
        );

        destroy_real_mobkit_host_tool_fixture(gateway, &fixture, &project_path, &state_root).await;
    }

    #[test]
    fn foreground_mobkit_live_call_disconnects_and_requires_reconfigure() {
        std::thread::Builder::new()
            .name("foreground-mobkit-disconnect-proof".to_string())
            .stack_size(16 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .thread_stack_size(16 * 1024 * 1024)
                    .enable_all()
                    .build()
                    .expect("build disconnect proof runtime")
                    .block_on(foreground_mobkit_disconnect_proof());
            })
            .expect("spawn disconnect proof thread")
            .join()
            .expect("disconnect proof thread");
    }

    async fn foreground_mobkit_disconnect_proof() {
        let (fixture, project_path, state_root, gateway, scripted_llm) =
            setup_real_mobkit_host_tool_fixture("foreground-disconnect", 1).await;
        let mut host_notifications = gateway.subscribe_host_tool_notifications();
        let mut events = gateway.subscribe_events();

        let turn = start_real_mobkit_host_tool_turn(
            &gateway,
            "disconnect-turn",
            &project_path,
            &state_root,
            "Keep the synthetic host call live until disconnect.",
            true,
        )
        .await;
        assert!(
            turn.error.is_none(),
            "disconnect turn failed to start: {turn:?}"
        );
        let run_id = turn
            .result
            .as_ref()
            .and_then(|result| result.get("runId"))
            .and_then(serde_json::Value::as_str)
            .expect("disconnect run id")
            .to_string();
        let invoke = tokio::time::timeout(Duration::from_secs(30), host_notifications.recv())
            .await
            .expect("disconnect invoke timeout")
            .expect("disconnect invoke channel");
        let DesktopHostToolNotificationV1::Invoke(invoke) = invoke else {
            panic!("expected live invoke before disconnect, got {invoke:?}");
        };
        let disconnected_call_id = invoke.call_id.clone();
        let disconnected_witness = invoke.witness.clone();

        gateway.disconnect_host_tools().await;
        // Disconnect has no response frame, so prove its synchronous ordering
        // without yielding: the cancel must already be queued when it returns.
        let cancel = host_notifications
            .try_recv()
            .expect("disconnect returned before queuing its cancel notification");
        let DesktopHostToolNotificationV1::Cancel(cancel) = cancel else {
            panic!("expected disconnect cancel notification, got {cancel:?}");
        };
        assert_eq!(cancel.call_id, disconnected_call_id);
        assert_eq!(
            cancel.reason,
            crate::host_tools::DesktopHostToolCancelReasonV1::HostDisconnected
        );
        let late_completion = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String("late-disconnect-completion".to_string())),
                    method: "desktop.hostTools.complete.v1".to_string(),
                    params: Some(serde_json::json!({
                        "callId": disconnected_call_id,
                        "outcome": {"kind": "result", "value": {"total": 7}}
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert_eq!(
            late_completion
                .error
                .as_ref()
                .map(|error| error.data.code.as_str()),
            Some("INVALID_ENVELOPE")
        );

        assert_eq!(
            wait_for_real_mobkit_terminal_event(&mut events, &run_id, "run.completed").await,
            Some(serde_json::json!("Synthetic host tool completed."))
        );
        assert_eq!(
            scripted_llm
                .host_disconnected_observations
                .load(Ordering::SeqCst),
            1,
            "the real MobKit waiter must settle with HOST_DISCONNECTED"
        );
        assert!(
            meerkat_core::AgentToolDispatcher::tools(gateway.inner.host_tools.as_ref()).is_empty(),
            "disconnect must close host-tool admission until configure ACK"
        );

        // A new eligible turn before reconfiguration must not reach the reverse
        // channel, and the model must not be shown the disconnected tool.
        let unconfigured_turn = start_real_mobkit_host_tool_turn(
            &gateway,
            "unconfigured-turn",
            &project_path,
            &state_root,
            "The disconnected tool must remain unavailable.",
            true,
        )
        .await;
        assert!(
            unconfigured_turn.error.is_none(),
            "unconfigured turn failed to start: {unconfigured_turn:?}"
        );
        let unconfigured_run_id = unconfigured_turn
            .result
            .as_ref()
            .and_then(|result| result.get("runId"))
            .and_then(serde_json::Value::as_str)
            .expect("unconfigured run id")
            .to_string();
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                tokio::select! {
                    notification = host_notifications.recv() => {
                        panic!("disconnected tool reached reverse channel before configure: {notification:?}");
                    }
                    event = events.recv() => {
                        let event = event.expect("unconfigured run event");
                        if event.run_id.as_deref() != Some(unconfigured_run_id.as_str()) {
                            continue;
                        }
                        assert_ne!(event.kind, "run.failed", "missing tool must return model-visible feedback: {event:?}");
                        if event.kind == "run.completed" { break; }
                    }
                }
            }
        })
        .await
        .expect("unconfigured turn did not settle without reverse dispatch");
        assert_eq!(
            scripted_llm.missing_tool_error_observations.load(Ordering::SeqCst),
            1,
            "native missing-tool feedback must reach the model without host dispatch"
        );
        assert_eq!(
            scripted_llm
                .missing_tool_surface_observations
                .load(Ordering::SeqCst),
            1,
            "the disconnected tool must be absent from the next model request"
        );
        let reconfigure =
            configure_synthetic_host_tool(&gateway, "reconfigure-after-disconnect", true).await;
        assert!(
            reconfigure.error.is_none(),
            "reconfigure failed: {reconfigure:?}"
        );
        assert_eq!(
            reconfigure
                .result
                .as_ref()
                .and_then(|result| result.get("enabled"))
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );

        let reconnected_turn = start_real_mobkit_host_tool_turn(
            &gateway,
            "reconnected-turn",
            &project_path,
            &state_root,
            "Use the explicitly reconfigured synthetic tool.",
            true,
        )
        .await;
        assert!(
            reconnected_turn.error.is_none(),
            "reconnected turn failed to start: {reconnected_turn:?}"
        );
        let reconnected_run_id = reconnected_turn
            .result
            .as_ref()
            .and_then(|result| result.get("runId"))
            .and_then(serde_json::Value::as_str)
            .expect("reconnected run id")
            .to_string();
        let reconnected_invoke =
            tokio::time::timeout(Duration::from_secs(30), host_notifications.recv())
                .await
                .expect("reconnected invoke timeout")
                .expect("reconnected invoke channel");
        let DesktopHostToolNotificationV1::Invoke(reconnected_invoke) = reconnected_invoke else {
            panic!("expected invoke after explicit reconfigure, got {reconnected_invoke:?}");
        };
        assert_eq!(reconnected_invoke.witness.run_id, reconnected_run_id);
        assert_ne!(
            reconnected_invoke.witness.run_id,
            disconnected_witness.run_id
        );
        assert_ne!(reconnected_invoke.witness.nonce, disconnected_witness.nonce);

        let completion = gateway
            .handle(
                RpcRequest {
                    jsonrpc: "2.0".to_string(),
                    id: Some(RpcId::String("complete-reconnected-call".to_string())),
                    method: "desktop.hostTools.complete.v1".to_string(),
                    params: Some(serde_json::json!({
                        "callId": reconnected_invoke.call_id,
                        "outcome": {"kind": "result", "value": {"total": 7}}
                    })),
                },
                RequestContext::local(),
            )
            .await;
        assert!(
            completion.error.is_none(),
            "reconnected completion failed: {completion:?}"
        );
        assert_eq!(
            wait_for_real_mobkit_terminal_event(&mut events, &reconnected_run_id, "run.completed")
                .await,
            Some(serde_json::json!("Synthetic host tool completed."))
        );

        destroy_real_mobkit_host_tool_fixture(gateway, &fixture, &project_path, &state_root).await;
    }

    #[test]
    fn topology_journal_components_are_lossless_and_collision_resistant() {
        assert_eq!(path_hex_component("mob-a"), "6d6f622d61");
        assert_ne!(path_hex_component("a-b"), path_hex_component("a_b"));
        assert_ne!(path_hex_component("A"), path_hex_component("a"));
    }

    #[test]
    fn topology_journal_opens_and_restores_with_production_length_mob_ids() {
        let fixture = std::env::temp_dir().join(format!(
            "meerkat-topology-long-identities-{}",
            uuid::Uuid::new_v4()
        ));
        let thread_mob = format!("t3-{}", "a".repeat(64));
        let project_agent_mob = format!("project-agent-{}", "b".repeat(66));
        assert_eq!(thread_mob.len(), 67);
        assert_eq!(project_agent_mob.len(), 80);
        assert!((thread_mob.len() + project_agent_mob.len()) * 2 + 7 > 255);
        let filename = super::topology_pair_journal_filename(&thread_mob, &project_agent_mob);
        assert_eq!(
            filename,
            super::topology_pair_journal_filename(&project_agent_mob, &thread_mob)
        );
        assert!(filename.len() + ".lock".len() <= 255);
        assert_ne!(
            filename,
            super::topology_pair_journal_filename(&thread_mob, &format!("{project_agent_mob}c"))
        );
        let path = fixture.join("mobkit/topology-pairs").join(filename);
        let coordinator = super::SameProcessTopologyCoordinator::open(&path)
            .expect("open native coordinator with long production mob identities");
        let initial: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read journal"))
                .expect("native journal JSON");
        assert!(path.with_extension("json.lock").is_file());
        drop(coordinator);
        let restored = super::SameProcessTopologyCoordinator::open(&path)
            .expect("restore the same durable native coordinator");
        let reloaded: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read restored"))
                .expect("restored journal JSON");
        assert!(initial["coordinator_id"]
            .as_str()
            .is_some_and(|id| !id.is_empty()));
        assert_eq!(initial["coordinator_id"], reloaded["coordinator_id"]);
        drop(restored);
        std::fs::remove_dir_all(fixture).expect("remove topology fixture");
    }

    #[test]
    fn topology_journal_retains_usable_legacy_paths_including_suffix_boundary() {
        assert_eq!(
            super::topology_pair_journal_filename("a", "b"),
            "61--62.json"
        );
        let first = "a".repeat(61);
        let second = "b".repeat(60);
        assert_eq!(
            super::topology_pair_journal_filename(&first, &second),
            format!(
                "{}--{}.json",
                path_hex_component(&first),
                path_hex_component(&second)
            )
        );
        assert!(
            super::topology_pair_journal_filename(&first, &format!("{second}b"))
                .starts_with("pair-v1-")
        );
    }

    #[tokio::test]
    async fn project_handles_share_mobkit_ownership_for_one_state_root() {
        let fixture = std::env::temp_dir().join(format!(
            "meerkat-shared-mobkit-registry-{}",
            uuid::Uuid::new_v4()
        ));
        let project_path = fixture.join("project");
        let first_execution_path = fixture.join("worktree-a");
        let second_execution_path = fixture.join("worktree-b");
        let state_root = fixture.join("state");
        for path in [
            &project_path,
            &first_execution_path,
            &second_execution_path,
            &state_root,
        ] {
            std::fs::create_dir_all(path).expect("create fixture path");
        }

        let gateway = MeerkatGateway::new();
        let project_path = project_path.to_string_lossy().to_string();
        let state_root = state_root.to_string_lossy().to_string();
        let first = gateway
            .project_runtime_handle_for_paths(
                &project_path,
                &first_execution_path.to_string_lossy(),
                "local".to_string(),
                Some(&state_root),
            )
            .await
            .expect("create first project runtime");
        let second = gateway
            .project_runtime_handle_for_paths(
                &project_path,
                &second_execution_path.to_string_lossy(),
                "local".to_string(),
                Some(&state_root),
            )
            .await
            .expect("create second project runtime");

        assert!(!Arc::ptr_eq(&first, &second));
        let first_registry = {
            let state = first.state.lock().await;
            Arc::clone(&state.mobkit)
        };
        let second_registry = {
            let state = second.state.lock().await;
            Arc::clone(&state.mobkit)
        };
        assert!(Arc::ptr_eq(&first_registry, &second_registry));

        std::fs::remove_dir_all(fixture).expect("remove fixture");
    }

    #[tokio::test]
    async fn concurrent_same_thread_admission_starts_and_finishes_only_one_run() {
        let fixture = std::env::temp_dir().join(format!(
            "meerkat-concurrent-run-admission-{}",
            uuid::Uuid::new_v4()
        ));
        let state_root = fixture.join("state");
        std::fs::create_dir_all(&state_root).expect("create test state root");

        let handle = Arc::new(ProjectRuntimeHandle {
            runs_settled: tokio::sync::Notify::new(),
            state: Mutex::new(ProjectRuntimeState {
                locator: ProjectLocator {
                    project_path: fixture.clone(),
                    state_root,
                    context_root: fixture.clone(),
                    realm_id: "test-realm".to_string(),
                },
                execution_path: fixture.clone(),
                execution_mode: "local".to_string(),
                instance_id: "test-instance".to_string(),
                mobkit: Arc::new(ProjectMobkitRegistry::new(HostToolTransport::new())),
                active_runs: HashMap::new(),
                member_turn_locks: HashMap::new(),
                dirty: false,
            }),
        });
        let (events_tx, mut events_rx) = tokio::sync::broadcast::channel(8);
        let barrier = Arc::new(Barrier::new(3));
        let builder_calls = Arc::new(AtomicUsize::new(0));

        let start_attempt = |run_id: &'static str| {
            let handle = handle.clone();
            let events_tx = events_tx.clone();
            let barrier = barrier.clone();
            let builder_calls = builder_calls.clone();
            tokio::spawn(async move {
                barrier.wait().await;
                let mut state = handle.state.lock().await;
                let admission = admit_active_run_locked(&mut state, "thread-shared", || {
                    builder_calls.fetch_add(1, Ordering::SeqCst);
                    emit_named_event(
                        &events_tx,
                        "run.started",
                        "thread-shared",
                        Some(run_id),
                        serde_json::json!({"mobId": "mob-test"}),
                    );
                    ActiveRun {
                        run_id: run_id.to_string(),
                        mob_id: "mob-test".to_string(),
                        agent_identity: "ingress".to_string(),
                        started_at: chrono::Utc::now(),
                        deliveries: AppRunDeliveries::default(),
                        projection: Arc::new(Mutex::new(RunEventProjection::default())),
                    }
                });
                match admission {
                    Ok(()) => Ok(run_id.to_string()),
                    Err(active_run) => Err(active_run.run_id),
                }
            })
        };

        let first_attempt = start_attempt("run-first");
        let second_attempt = start_attempt("run-second");
        barrier.wait().await;
        let first_result = first_attempt.await.expect("first admission task");
        let second_result = second_attempt.await.expect("second admission task");

        assert_ne!(
            first_result.is_ok(),
            second_result.is_ok(),
            "exactly one concurrent start must be admitted"
        );
        let admitted_run_id = first_result
            .as_ref()
            .ok()
            .or_else(|| second_result.as_ref().ok())
            .expect("one admitted run")
            .clone();
        let conflicting_run_id = first_result
            .as_ref()
            .err()
            .or_else(|| second_result.as_ref().err())
            .expect("one conflicting run");
        assert_eq!(
            conflicting_run_id, &admitted_run_id,
            "the loser must observe the winner rather than overwrite it"
        );
        assert_eq!(builder_calls.load(Ordering::SeqCst), 1);

        let started = events_rx.try_recv().expect("one run.started event");
        assert_eq!(started.kind, "run.started");
        assert_eq!(started.run_id.as_deref(), Some(admitted_run_id.as_str()));
        assert!(
            events_rx.try_recv().is_err(),
            "loser must emit no start event"
        );

        finish_run(
            &events_tx,
            &handle,
            "thread-shared",
            &admitted_run_id,
            "mob-test",
            "ingress",
            fixture.to_str().expect("utf-8 fixture path"),
            fixture.to_str().expect("utf-8 fixture path"),
            "local",
            HostToolTransport::new().as_ref(),
            Ok(()),
        )
        .await;

        let completed = events_rx.try_recv().expect("one run.completed event");
        assert_eq!(completed.kind, "run.completed");
        assert_eq!(completed.run_id.as_deref(), Some(admitted_run_id.as_str()));
        assert!(
            events_rx.try_recv().is_err(),
            "the conflicting request must emit no terminal event"
        );
        assert!(
            handle.state.lock().await.active_runs.is_empty(),
            "the winner's terminal path clears the reservation"
        );

        std::fs::remove_dir_all(&fixture).expect("remove test fixture");
    }

    #[tokio::test]
    async fn followup_read_never_materializes_a_runtime_or_creates_native_stores() {
        let fixture = std::env::temp_dir().join(format!("followup-cold-read-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&fixture).unwrap();
        let state = fixture.join("state");
        let gateway = MeerkatGateway::new();
        let params = serde_json::json!({
            "threadId":"thread","projectPath":fixture,"stateRoot":state,"mobId":"mob"
        });
        let result = gateway.mobs_thread_followups(Some(&params)).await.unwrap();
        assert_eq!(result["status"], "unavailable");
        assert!(result.get("nextCursor").is_none());
        assert!(gateway.inner.project_runtimes.lock().await.is_empty());
        assert!(!state.exists());
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[tokio::test]
    async fn followup_persistence_failure_cannot_be_bypassed_by_a_duplicate_observer() {
        let fixture = std::env::temp_dir().join(format!("followup-failed-record-{}", Uuid::new_v4()));
        let session = SessionId::new();
        let attribution = super::thread_followups::Attribution {
                state_root: fixture.clone(), thread_id: "thread".into(), mob_id: "mob".into(),
                session_id: session.to_string(), run_id: "app-run".into(),
            };
        let projection = Arc::new(Mutex::new(RunEventProjection {
            delivery_scope: Some(attribution.clone()),
            followup: Some(attribution),
            ..Default::default()
        }));
        let event = EventEnvelope::new_session(session.clone(), 1, None, AgentEvent::RunCompleted {
            identity: Default::default(),
            assistant_message_id: Some(fixture_assistant_message_id()),
            session_id: session, result: "done".into(), structured_output: None,
            extraction_required: false, usage: Default::default(), terminal_cause_kind: None,
        });
        let (tx, mut rx) = tokio::sync::broadcast::channel(4);
        for _ in 0..2 {
            assert!(super::project_run_event(&projection, &event, "thread", "app-run", &tx).await.is_err());
            assert!(!projection.lock().await.seen.contains(&event.event_id));
        }
        assert!(projection.lock().await.followup_failed);
        assert!(rx.try_recv().is_err());
        assert_eq!(super::thread_deliveries::read(&fixture, "thread", "mob").unwrap().len(), 1,
            "the unsent final remains durable even though attribution failed");
        std::fs::remove_dir_all(&fixture).unwrap();
    }

    #[test]
    fn native_terminal_identity_is_preserved_for_durable_followup_dedup() {
        let (tx,mut rx)=tokio::sync::broadcast::channel(4);
        let session=SessionId::new();
        let event=EventEnvelope::new_session(session.clone(),1,None,AgentEvent::RunCompleted {
            identity: Default::default(),
            assistant_message_id: Some(fixture_assistant_message_id()),
            session_id:session.clone(),result:"done".into(),structured_output:None,
            extraction_required:false,usage:Default::default(),terminal_cause_kind:None,
        });
        process_agent_event_envelope(&event,"thread","app-run",&mut LiveEventAssembler::default(),&tx,&mut false).unwrap();
        let emitted=rx.try_recv().unwrap();
        assert_eq!(emitted.kind,"run.output.complete");
        assert_eq!(emitted.payload["nativeSourceEventId"],format!("evt-agent-{}",event.event_id));
        assert_eq!(emitted.payload["nativeSessionId"],session.to_string());
        assert_eq!(emitted.run_id.as_deref(),Some("app-run"));
    }

    #[test]
    fn terminal_result_emits_authoritative_final_after_streamed_deltas() {
        let (events_tx, mut events_rx) = tokio::sync::broadcast::channel(4);
        let mut state = LiveEventAssembler::default();
        let mut emitted_live_events = false;
        let session_id = SessionId::new();
        let envelope = |seq, payload| EventEnvelope {
            event_id: Uuid::new_v4(),
            source: EventSourceIdentity::session(session_id.clone()),
            seq,
            mob_id: None,
            timestamp_ms: 1_752_414_000_000 + seq,
            payload,
        };

        let terminal = process_agent_event_envelope(
            &envelope(
                1,
                AgentEvent::TextDelta {
                    assistant_message_id: Some(fixture_assistant_message_id()),
                    delta: "partial streamed tail".to_string(),
                },
            ),
            "thread-stream",
            "run-stream",
            &mut state,
            &events_tx,
            &mut emitted_live_events,
        )
        .expect("delta should process");
        assert!(!terminal);
        assert_eq!(
            events_rx.try_recv().expect("delta event").kind,
            "run.output.delta"
        );

        let terminal = process_agent_event_envelope(
            &envelope(
                2,
                AgentEvent::TextComplete {
                    assistant_message_id: Some(fixture_assistant_message_id()),
                    content: "partial streamed tail".to_string(),
                },
            ),
            "thread-stream",
            "run-stream",
            &mut state,
            &events_tx,
            &mut emitted_live_events,
        )
        .expect("per-turn text completion should process");
        assert!(!terminal, "TextComplete is not an agent-run terminal");
        assert!(
            events_rx.try_recv().is_err(),
            "TextComplete must not freeze the live tail before tool execution"
        );

        let terminal = process_agent_event_envelope(
            &envelope(
                3,
                AgentEvent::TextDelta {
                    assistant_message_id: Some(fixture_assistant_message_id()),
                    delta: " after tool execution".to_string(),
                },
            ),
            "thread-stream",
            "run-stream",
            &mut state,
            &events_tx,
            &mut emitted_live_events,
        )
        .expect("post-tool delta should process");
        assert!(!terminal);
        assert_eq!(
            events_rx.try_recv().expect("post-tool delta event").kind,
            "run.output.delta"
        );

        let terminal = process_agent_event_envelope(
            &envelope(
                4,
                AgentEvent::RunCompleted {
                    identity: Default::default(),
                    assistant_message_id: Some(fixture_assistant_message_id()),
                    session_id: session_id.clone(),
                    result: "complete authoritative response".to_string(),
                    structured_output: None,
                    extraction_required: false,
                    usage: Usage::default().into(),
                    terminal_cause_kind: None,
                },
            ),
            "thread-stream",
            "run-stream",
            &mut state,
            &events_tx,
            &mut emitted_live_events,
        )
        .expect("terminal should process");
        assert!(terminal);

        let final_event = events_rx.try_recv().expect("authoritative final event");
        assert_eq!(final_event.kind, "run.output.complete");
        assert_eq!(
            final_event.payload["text"],
            "complete authoritative response"
        );
    }

    #[test]
    fn contentless_terminal_uses_only_post_tool_model_turn_text() {
        let (events_tx, mut events_rx) = tokio::sync::broadcast::channel(16);
        let mut state = LiveEventAssembler::default();
        let mut emitted_live_events = false;
        let session_id = SessionId::new();
        let envelope = |seq, payload| EventEnvelope {
            event_id: Uuid::new_v4(),
            source: EventSourceIdentity::session(session_id.clone()),
            seq,
            mob_id: None,
            timestamp_ms: 1_752_414_100_000 + seq,
            payload,
        };
        let events = vec![
            AgentEvent::TextDelta {
                assistant_message_id: Some(fixture_assistant_message_id()),
                delta: "I will inspect the repository first.".to_string(),
            },
            AgentEvent::TextComplete {
                assistant_message_id: Some(fixture_assistant_message_id()),
                content: "I will inspect the repository first.".to_string(),
            },
            AgentEvent::ToolCallRequested {
                id: "read-1".to_string(),
                name: "read_file".to_string(),
                args: meerkat_core::event::ToolCallArguments::empty(),
            },
            AgentEvent::TextDelta {
                assistant_message_id: Some(fixture_assistant_message_id()),
                delta: "The repository is healthy.".to_string(),
            },
            AgentEvent::TextComplete {
                assistant_message_id: Some(fixture_assistant_message_id()),
                content: "The repository is healthy.".to_string(),
            },
            AgentEvent::RunCompleted {
                identity: Default::default(),
                assistant_message_id: Some(fixture_assistant_message_id()),
                session_id: session_id.clone(),
                result: String::new(),
                structured_output: None,
                extraction_required: false,
                usage: Usage::default().into(),
                terminal_cause_kind: None,
            },
        ];

        for (index, payload) in events.into_iter().enumerate() {
            let terminal = process_agent_event_envelope(
                &envelope(index as u64 + 1, payload),
                "thread-post-tool",
                "run-post-tool",
                &mut state,
                &events_tx,
                &mut emitted_live_events,
            )
            .expect("event should process");
            assert_eq!(terminal, index == 5);
        }

        let emitted = std::iter::from_fn(|| events_rx.try_recv().ok()).collect::<Vec<_>>();
        let finals = emitted
            .iter()
            .filter(|event| event.kind == "run.output.complete")
            .collect::<Vec<_>>();
        assert_eq!(finals.len(), 1, "the run emits one authorized final");
        assert_eq!(finals[0].payload["text"], "The repository is healthy.");
        assert!(
            !finals[0].payload["text"]
                .as_str()
                .unwrap_or_default()
                .contains("inspect the repository"),
            "pre-tool planning must not leak into the final response"
        );
    }

    #[test]
    fn history_recovery_selects_last_terminal_assistant_before_next_user() {
        let messages = vec![
            serde_json::json!({"role": "user", "content": "inspect the repo"}),
            serde_json::json!({
                "role": "block_assistant",
                "blocks": [
                    {"type": "text", "data": {"text": "I will inspect it."}},
                    {"type": "tool_use", "data": {"name": "shell", "id": "tool-1"}}
                ]
            }),
            serde_json::json!({
                "role": "tool",
                "results": [{"id": "tool-1", "name": "shell"}]
            }),
            serde_json::json!({
                "role": "block_assistant",
                "blocks": [{"type": "text", "data": {"text": "The final repository answer."}}]
            }),
            serde_json::json!({"role": "user", "content": "a later prompt"}),
            serde_json::json!({"role": "assistant", "content": "a later answer"}),
        ];

        let window = history_window_after_latest_user_prompt(&messages, "inspect the repo");
        assert!(window.bounded_by_next_user);
        assert_eq!(
            window.messages.len(),
            3,
            "history window must stop at the next user turn"
        );
        assert!(!assistant_message_is_terminal_candidate(
            &window.messages[0]
        ));
        assert!(assistant_message_is_terminal_candidate(&window.messages[2]));
        assert_eq!(
            assistant_message_text(&window.messages[2]).as_deref(),
            Some("The final repository answer.")
        );
        assert_eq!(
            terminal_assistant_index_for_history_recovery(&window, true),
            Some(2),
            "a successor user boundary closes this turn even while the shared session is active"
        );
    }

    #[test]
    fn active_history_recovery_waits_for_an_unbounded_tail() {
        let messages = vec![
            serde_json::json!({"role": "user", "content": "inspect the repo"}),
            serde_json::json!({
                "role": "assistant",
                "content": "This looks terminal but may only be the pre-tool model turn."
            }),
        ];

        let window = history_window_after_latest_user_prompt(&messages, "inspect the repo");
        assert!(!window.bounded_by_next_user);
        assert!(assistant_message_is_terminal_candidate(&window.messages[0]));
        assert_eq!(
            terminal_assistant_index_for_history_recovery(&window, true),
            None,
            "an active session must not promote terminal-looking pre-tool text without a next-user boundary"
        );
        assert_eq!(
            terminal_assistant_index_for_history_recovery(&window, false),
            Some(0),
            "an inactive session remains authoritative for its unbounded final tail"
        );
    }

    #[test]
    fn repeated_successor_prompt_does_not_recover_the_prior_identical_turn() {
        let messages = vec![
            serde_json::json!({"role": "user", "content": "inspect the repo"}),
            serde_json::json!({"role": "assistant", "content": "The first answer."}),
            serde_json::json!({"role": "user", "content": "inspect the repo"}),
            serde_json::json!({
                "role": "assistant",
                "content": "A terminal-looking prefix from the still-active successor."
            }),
        ];

        // Prompt correlation is text-based, so selecting the latest exact
        // match is deliberately conservative: an identical successor may
        // delay recovery of the prior turn, but cannot misattribute its final.
        let window = history_window_after_latest_user_prompt(&messages, "inspect the repo");
        assert!(!window.bounded_by_next_user);
        assert_eq!(window.messages.len(), 1);
        assert_eq!(
            terminal_assistant_index_for_history_recovery(&window, true),
            None
        );
    }

    #[test]
    fn kickoff_quiescence_rejects_failed_legacy_autonomous_sessions() {
        assert!(member_kickoff_phase_is_quiescent(None));
        assert!(member_kickoff_phase_is_quiescent(Some(
            MobMemberKickoffPhase::Started
        )));
        assert!(!member_kickoff_phase_is_quiescent(Some(
            MobMemberKickoffPhase::Failed
        )));
        assert!(!member_kickoff_phase_is_quiescent(Some(
            MobMemberKickoffPhase::Cancelled
        )));
        assert!(!member_kickoff_phase_is_quiescent(Some(
            MobMemberKickoffPhase::Pending
        )));
        assert!(!member_kickoff_phase_is_quiescent(Some(
            MobMemberKickoffPhase::Starting
        )));
        assert!(!member_kickoff_phase_is_quiescent(Some(
            MobMemberKickoffPhase::CallbackPending
        )));
    }

    #[test]
    fn project_runtime_instance_id_is_bounded_and_path_sensitive() {
        let long_runtime_key = [
            "/Users/example/Library/Caches/meerkat-app-dev/electron-dev/isolated/workspace",
            "/Users/example/Library/Caches/meerkat-app-dev/electron-dev/isolated/state/mobkit-state",
            "/Users/example/Library/Caches/meerkat-app-dev/electron-dev/isolated/workspace",
        ]
        .join("::");
        let first = project_runtime_instance_id(&long_runtime_key);
        let second = project_runtime_instance_id(&format!("{long_runtime_key}-other"));

        assert_eq!(first.len(), "project-".len() + 64);
        assert!(first.is_ascii());
        assert_ne!(first, second);
        assert_eq!(first, project_runtime_instance_id(&long_runtime_key));
    }

    #[cfg(unix)]
    #[test]
    fn nonexistent_state_root_below_symlink_has_stable_runtime_key() {
        use std::os::unix::fs::symlink;

        let fixture = std::env::temp_dir().join(format!(
            "meerkat-state-root-canonicalization-{}",
            uuid::Uuid::new_v4()
        ));
        let real_parent = fixture.join("real");
        let alias_parent = fixture.join("alias");
        let project_path = fixture.join("project");
        std::fs::create_dir_all(&real_parent).expect("create real state parent");
        std::fs::create_dir_all(&project_path).expect("create project");
        symlink(&real_parent, &alias_parent).expect("create state-root symlink");

        let requested_root = alias_parent.join("nested").join("state");
        assert!(!requested_root.exists());
        let first = derive_project_locator(
            project_path.to_str().expect("utf-8 project path"),
            Some(requested_root.to_str().expect("utf-8 state root")),
        )
        .expect("first locator");
        let second = derive_project_locator(
            project_path.to_str().expect("utf-8 project path"),
            Some(requested_root.to_str().expect("utf-8 state root")),
        )
        .expect("second locator");

        assert_eq!(
            first.state_root,
            real_parent
                .join("nested")
                .join("state")
                .canonicalize()
                .expect("canonical state root")
        );
        assert_eq!(first.state_root, second.state_root);
        assert_eq!(
            project_runtime_key(&first, &first.context_root),
            project_runtime_key(&second, &second.context_root)
        );

        std::fs::remove_dir_all(&fixture).expect("remove fixture");
    }
}
