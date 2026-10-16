use chrono::Utc;
use meerkat::{
    AgentFactory, Config, FactoryAgentBuilder, McpRouter, McpRouterAdapter, McpServerConfig,
    PersistentSessionService,
};
use meerkat_core::comms::{
    CommsCommand, PeerDeliveryOutcome, PeerId, PeerName, PeerRoute, SendReceipt,
};
use meerkat_core::connection::RealmId;
use meerkat_core::service::{SessionError, SessionQuery, SessionServiceCommsExt};
use meerkat_core::session_store::SessionStoreError;
use meerkat_core::{
    derive_workspace_realm_id, ConfigDelta, ConfigError, ConfigRuntime, ConfigSnapshot,
    ConfigStore, EffectiveConfigReader, FileConfigStore, ModelCatalog, RealmConfigSource,
};
use meerkat_mob::store::{MobSpecStore, SqliteMobStores};
use meerkat_mob::{
    MemberTurnOptions, MobDefinition, MobId, MobRuntimeMode, MobSessionService, MobStorage,
    ProfileName, SpawnMemberSpec,
};
use meerkat_mobkit::mob_handle_runtime::send_message_on_mob_with_mode;
use meerkat_mobkit::tool_compose::ComposedExternalTools;
use meerkat_mobkit::{
    handle_unified_rpc_json, member_comms_id, member_entry_to_json,
    Base64BlobStoreAdapter, BinaryBlobStore,
    ConsoleAggregatorOptions, ConsoleRuntimeRegistration, DiscoverySpec, GatewayPeerKeys,
    MobBootstrapSpec, MetaConfig,
    MetaConsoleAggregator, ModuleConfig, ObjectStoreBlobStore, PreSpawnData,
    TopologyBootstrapConfig, TopologyControlMode, TopologyControlPolicy, UnifiedRuntime,
};
use meerkat_store::SqliteSessionStore;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, RwLock};

use crate::host_tools::HostToolTransport;

mod configured_auth;
mod background_tasks;
use background_tasks::{RetainedShutdown, RetainedTask};
mod observer_drain;
pub(crate) mod storage_upgrade;
use observer_drain::MobStoreObserverDisposal;
type ObserverDisposalRegistry =
    std::sync::Mutex<BTreeMap<PathBuf, Arc<MobStoreObserverDisposal>>>;
#[cfg(test)]
mod initial_model_tests;
#[cfg(test)]
mod observer_registration_tests;
#[cfg(test)]
mod schedule_runtime_tests;

#[derive(Clone)]
pub struct MobkitMobRuntime {
    pub mob_id: String,
    pub kind: String,
    pub label: String,
    pub placement: MobPlacement,
    pub coordinator_identity: String,
    pub state_root: PathBuf,
    pub config_state_root: PathBuf,
    /// Exact roots captured by the session factory, including child builds.
    pub(crate) checkpoint_project_path: PathBuf,
    pub(crate) checkpoint_workspace: PathBuf,
    pub(crate) checkpoint_incarnation: uuid::Uuid,
    pub(crate) checkpoint_runtime_store: Option<Arc<dyn meerkat_runtime::RuntimeStore>>,
    pub realm_id: String,
    pub runtime: Option<Arc<UnifiedRuntime>>,
    pub(crate) session_runtime: Option<Arc<meerkat_runtime::MeerkatMachine>>,
    // The native reconfigure host holds this service weakly. Retain the exact
    // adapter, not just its underlying session service, for the mob's lifetime.
    _llm_reconfigure_service: Option<Arc<
        dyn meerkat::session_runtime::llm_reconfigure::SessionRuntimeLlmReconfigureService,
    >>,
    pub(crate) responsibility_host: Option<Arc<crate::native_responsibilities::NativeResponsibilities>>,
    pub(crate) access_mode: crate::native_execution_modes::ExecutionMode,
    pub(crate) approvals: Option<Arc<crate::native_approvals::NativeApprovals>>,
    /// Console aggregator registered against this mob's runtime. This is the
    /// ONLY working console-timeline surface for embedded mobs: the stdio
    /// JSON-RPC dispatcher (`handle_unified_rpc_json`) never served
    /// `mobkit/console/query_timeline` — that method exists on the HTTP
    /// console router only. Registration also starts the session-history
    /// backfill, so agent-to-agent comms deliveries (peer messages recorded
    /// as `system_notice` session entries) become queryable frames.
    pub console: Option<MetaConsoleAggregator>,
    /// Agent-authored schedules are durable, but the firing loop is owned by
    /// the live embedded runtime. Keep its shutdown authority beside the mob
    /// so registry removal cannot leave a detached schedule driver behind.
    schedule_host: Option<Arc<Mutex<RetainedShutdown>>>,
    /// The schedule dispatcher and target registry point back to the session
    /// service and child-mob state. Release both after their producers stop.
    schedule_bindings: Option<Arc<ScheduleBindings>>,
    /// The watchdog turns a stuck durable occurrence into an actionable log
    /// instead of allowing silent pending rows. It is aborted and joined with the mob.
    schedule_watchdog: Option<Arc<Mutex<RetainedTask>>>,
    /// Join the host-owned event projector after native runtime disposal.
    event_drain: Option<Arc<Mutex<RetainedTask>>>,
    disposal: Arc<crate::thread_dispose::NativeRuntimeDisposal>,
    created_at: chrono::DateTime<Utc>,
}

struct ScheduleBindings {
    targets: meerkat_mobkit::schedule_wiring::ScheduleMobTargetRegistry,
    tools: Arc<std::sync::RwLock<Option<Arc<dyn meerkat_core::AgentToolDispatcher>>>>,
}

impl ScheduleBindings {
    fn clear(&self) {
        self.targets.set_mob_state(None);
        // Native identity probes hold the session service and mob state. The
        // default dispatcher closes that cycle through the service's builder.
        *self.tools.write().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }
}

impl Drop for ScheduleBindings {
    fn drop(&mut self) {
        // Also cover bootstrap failures before there is a registry entry.
        self.clear();
    }
}

#[derive(Clone, Debug)]
pub enum MobPlacement {
    Local,
    RemoteTcp {
        endpoint: String,
        pubkey_b64: Option<String>,
        status: String,
    },
}

pub struct ProjectMobkitRegistry {
    mobs: RwLock<HashMap<String, Arc<MobkitMobRuntime>>>,
    local_bootstrap_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    // Paths only: unloaded or failed bootstraps must remain in the final
    // observer scope without retaining the runtimes that own their stores.
    observer_disposals: ObserverDisposalRegistry,
    admission: RwLock<bool>,
    host_tools: Arc<HostToolTransport>,
    #[cfg(test)]
    test_llm_client: Option<Arc<dyn meerkat::LlmClient>>,
}

#[derive(Clone)]
pub struct CreateMobInput {
    pub mob_id: String,
    pub kind: String,
    pub label: String,
    pub role: String,
    pub coordinator_identity: String,
    pub model: String,
    /// Creation request, validated only when native storage has no saved session.
    pub(crate) initial_llm: Option<crate::native_model::InitialAgentLlmRequest>,
    pub instructions: String,
    /// Optional desktop flow-tool binding, never inferred from a mob id.
    pub thread_id: Option<String>,
    /// Presentation opt-in for native child members, without changing runtime authority.
    pub include_native_workers: bool,
    pub(crate) access_mode: Option<crate::native_execution_modes::ExecutionMode>,
    /// Logical workspace path that owns realm/config identity.
    pub config_project_path: PathBuf,
    /// Concrete execution/context root (the workspace or a worktree).
    pub project_path: PathBuf,
    pub state_root: PathBuf,
    pub config_state_root: PathBuf,
}

pub struct EffectiveRealmConfig {
    pub raw_head: Config,
    pub effective: Config,
    pub head_store: Arc<dyn ConfigStore>,
    pub source: Arc<dyn RealmConfigSource>,
    pub realm_id: RealmId,
}

/// Raw-head filesystem store whose merge-patch path preserves TOML key
/// presence. The upstream FileConfigStore typed patch path reserializes every
/// `Config::default()` section; in an inherited realm, those newly materialized
/// empty tables are meaningful tombstones (not harmless formatting) and can
/// erase inherited self-hosted aliases or scalar policy. Desktop config writes
/// therefore retain the raw document shape while still delegating typed reads,
/// full replacements, and canonical validation to Meerkat.
pub(crate) struct PresencePreservingFileConfigStore {
    path: PathBuf,
    catalog: ModelCatalog,
}

impl PresencePreservingFileConfigStore {
    pub(crate) fn new(path: PathBuf, catalog: ModelCatalog) -> Self {
        Self { path, catalog }
    }

    fn typed_store(&self) -> FileConfigStore {
        FileConfigStore::new(self.path.clone(), self.catalog)
    }
}

#[async_trait::async_trait]
impl ConfigStore for PresencePreservingFileConfigStore {
    async fn get(&self) -> Result<Config, ConfigError> {
        self.typed_store().get().await
    }

    async fn set(&self, config: Config) -> Result<(), ConfigError> {
        self.typed_store().set(config).await
    }

    async fn patch(&self, delta: ConfigDelta) -> Result<Config, ConfigError> {
        let mut raw_json = if tokio::fs::try_exists(&self.path).await? {
            let content = tokio::fs::read_to_string(&self.path).await?;
            let raw: toml::Value = toml::from_str(&content).map_err(ConfigError::Parse)?;
            serde_json::to_value(raw).map_err(ConfigError::Json)?
        } else {
            json!({})
        };
        meerkat_core::merge_patch(&mut raw_json, delta.0);
        let updated: Config =
            serde_json::from_value(raw_json.clone()).map_err(ConfigError::Json)?;
        updated.validate(self.catalog)?;

        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        // Serialize the presence-preserving raw document, not `updated`.
        let content = toml::to_string_pretty(&raw_json).map_err(ConfigError::TomlSerialize)?;
        let parent = self
            .path
            .parent()
            .map_or_else(|| PathBuf::from("."), std::path::Path::to_path_buf);
        let tmp_path = parent.join(format!(".config.tmp.{}", uuid::Uuid::new_v4()));
        let write_result = async {
            let mut tmp = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp_path)
                .await?;
            tmp.write_all(content.as_bytes()).await?;
            tmp.sync_all().await?;
            drop(tmp);
            tokio::fs::rename(&tmp_path, &self.path).await
        }
        .await;
        if write_result.is_err() {
            let _ = tokio::fs::remove_file(&tmp_path).await;
        }
        write_result?;
        Ok(updated)
    }
}

/// Compose and validate an effective realm view over an authoritative raw-head
/// snapshot. ConfigRuntime serializes raw-head writes; callers must recompose
/// from the snapshot it returns rather than using the pre-lock read performed
/// while locating the store.
pub async fn compose_effective_realm_config(
    realm_config: &EffectiveRealmConfig,
    raw_head: Config,
) -> Result<Config, String> {
    let mut effective = EffectiveConfigReader::new(Arc::clone(&realm_config.source))
        .effective_config_over_head(&realm_config.realm_id, raw_head)
        .await
        .map_err(|error| format!("failed to compose workspace realm config: {error}"))?;
    effective
        .apply_env_overrides()
        .map_err(|error| format!("failed to apply config environment overrides: {error}"))?;
    effective
        .validate(meerkat_models::canonical())
        .map_err(|error| format!("workspace realm config is invalid: {error}"))?;
    Ok(effective)
}

/// Construct the one workspace/realm CAS authority shared by every desktop
/// thread. The config document remains owned by FileConfigStore; only the
/// monotonic generation sidecar is desktop-specific.
pub fn realm_config_runtime(
    realm_config: &EffectiveRealmConfig,
    config_state_root: &std::path::Path,
) -> ConfigRuntime {
    ConfigRuntime::new(
        Arc::clone(&realm_config.head_store),
        config_state_root
            .join(realm_config.realm_id.as_str())
            .join("desktop-config-runtime-state.json"),
    )
}

/// Turn a raw ConfigRuntime snapshot into the effective realm view consumed by
/// the UI and runtime without ever writing inherited values back to the head.
pub async fn effective_config_snapshot(
    realm_config: &EffectiveRealmConfig,
    snapshot: ConfigSnapshot,
) -> Result<(Config, u64), String> {
    let generation = snapshot.generation;
    let effective = compose_effective_realm_config(realm_config, snapshot.config).await?;
    Ok((effective, generation))
}

/// Resolve the same raw head, inherited realm chain, and canonical model
/// registry used by both the picker and the runtime builder.
pub async fn load_effective_realm_config(
    project_path: &std::path::Path,
    config_state_root: &std::path::Path,
) -> Result<EffectiveRealmConfig, String> {
    std::fs::create_dir_all(config_state_root).map_err(|error| {
        format!(
            "failed to create realm config state root {}: {error}",
            config_state_root.display()
        )
    })?;
    let realm_id = RealmId::parse(&derive_workspace_realm_id(project_path))
        .map_err(|error| format!("invalid workspace realm id: {error}"))?;
    let global_doc = realm_global_config_path(config_state_root);
    let concrete_source = Arc::new(meerkat_store::FilesystemRealmConfigSource::new(
        config_state_root,
        global_doc,
        meerkat_models::canonical(),
    ));
    let source: Arc<dyn RealmConfigSource> = concrete_source.clone();
    let head_store: Arc<dyn ConfigStore> = Arc::new(PresencePreservingFileConfigStore::new(
        concrete_source.config_doc_path(&realm_id),
        meerkat_models::canonical(),
    ));
    let raw_head = head_store
        .get()
        .await
        .map_err(|error| format!("failed to load workspace realm config: {error}"))?;
    let realm_config = EffectiveRealmConfig {
        raw_head,
        effective: Config::default(),
        head_store,
        source,
        realm_id,
    };
    let effective =
        compose_effective_realm_config(&realm_config, realm_config.raw_head.clone()).await?;
    Ok(EffectiveRealmConfig {
        effective,
        ..realm_config
    })
}

fn realm_global_config_path(config_state_root: &std::path::Path) -> std::path::PathBuf {
    #[cfg(not(test))]
    {
        Config::global_config_path()
            .unwrap_or_else(|| config_state_root.join("__no_global__").join("config.toml"))
    }
    #[cfg(test)]
    {
        // Each fixture owns its entire config chain, including the global layer.
        // Never inherit the developer's credentials or provider policy in tests.
        config_state_root
            .join("__test_global__")
            .join("config.toml")
    }
}

impl ProjectMobkitRegistry {
    pub fn new(host_tools: Arc<HostToolTransport>) -> Self {
        Self {
            mobs: RwLock::new(HashMap::new()),
            local_bootstrap_locks: Mutex::new(HashMap::new()),
            observer_disposals: ObserverDisposalRegistry::default(),
            admission: RwLock::new(true),
            host_tools,
            #[cfg(test)]
            test_llm_client: None,
        }
    }

    /// Construct a registry whose freshly spawned members use a deterministic
    /// in-process model. This seam exists only in Rust tests: production
    /// gateways have no flag, environment variable, or RPC that can replace a
    /// member's configured provider.
    #[cfg(test)]
    pub fn new_with_test_llm(
        host_tools: Arc<HostToolTransport>,
        test_llm_client: Arc<dyn meerkat::LlmClient>,
    ) -> Self {
        Self {
            mobs: RwLock::new(HashMap::new()),
            local_bootstrap_locks: Mutex::new(HashMap::new()),
            observer_disposals: ObserverDisposalRegistry::default(),
            admission: RwLock::new(true),
            host_tools,
            test_llm_client: Some(test_llm_client),
        }
    }

    pub async fn list(&self) -> Vec<Arc<MobkitMobRuntime>> {
        let mut mobs = self.mobs.read().await.values().cloned().collect::<Vec<_>>();
        mobs.sort_by(|left, right| left.mob_id.cmp(&right.mob_id));
        mobs
    }

    pub async fn get(&self, mob_id: &str) -> Option<Arc<MobkitMobRuntime>> {
        self.mobs.read().await.get(mob_id).cloned()
    }

    pub async fn insert_remote_tcp(
        &self,
        mob_id: String,
        label: String,
        endpoint: String,
        pubkey_b64: Option<String>,
    ) -> Result<(), String> {
        let admission = self.admission.read().await;
        if !*admission {
            return Err("MobKit registry is shutting down".to_string());
        }
        let mob = Arc::new(MobkitMobRuntime {
            mob_id: mob_id.clone(),
            kind: "remote".to_string(),
            label,
            placement: MobPlacement::RemoteTcp {
                endpoint,
                pubkey_b64,
                status: "registered".to_string(),
            },
            coordinator_identity: "remote".to_string(),
            state_root: PathBuf::new(),
            config_state_root: PathBuf::new(),
            checkpoint_project_path: PathBuf::new(),
            checkpoint_workspace: PathBuf::new(),
            checkpoint_incarnation: uuid::Uuid::new_v4(),
            checkpoint_runtime_store: None,
            realm_id: String::new(),
            runtime: None,
            session_runtime: None,
            _llm_reconfigure_service: None,
            responsibility_host: None,
            access_mode: Default::default(),
            approvals: None,
            console: None,
            schedule_host: None,
            schedule_bindings: None,
            schedule_watchdog: None,
            event_drain: None,
            disposal: Arc::new(Default::default()),
            created_at: Utc::now(),
        });
        self.mobs.write().await.insert(mob_id, mob);
        Ok(())
    }

    pub async fn create_local(
        &self,
        input: CreateMobInput,
    ) -> Result<Arc<MobkitMobRuntime>, String> {
        let admission = self.admission.read().await;
        if !*admission {
            return Err("MobKit registry is shutting down".to_string());
        }
        // Runtime bootstrap is not idempotent: it opens an exclusive topology
        // controller and may append durable lifecycle events. Restore and send
        // can legitimately converge on a cold thread at the same time, so the
        // ordinary read-before-write check must be backed by a per-mob
        // single-flight boundary and a second read after acquiring it.
        let bootstrap_lock = {
            let mut locks = self.local_bootstrap_locks.lock().await;
            Arc::clone(
                locks
                    .entry(input.mob_id.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let _bootstrap_guard = bootstrap_lock.lock().await;
        if let Some(existing) = self.get(&input.mob_id).await {
            if existing.disposal.has_started() {
                return Err(
                    "MobKit runtime cleanup has started; retry removal before reconnecting".into(),
                );
            }
            crate::native_execution_modes::validate_requested_mode(input.access_mode, existing.access_mode)?;
            return Ok(existing);
        }
        #[cfg(not(test))]
        let test_llm_client = None;
        #[cfg(test)]
        let test_llm_client = self.test_llm_client.clone();
        let bootstrapped = bootstrap_local_runtime_inner(
            input,
            Arc::clone(&self.host_tools),
            test_llm_client,
            Some(&self.observer_disposals),
        ).await?;
        let mob = Arc::new(bootstrapped);
        self.mobs
            .write()
            .await
            .insert(mob.mob_id.clone(), mob.clone());
        Ok(mob)
    }

    pub async fn remove(&self, mob_id: &str) -> Result<bool, String> {
        // Removal and bootstrap share the same boundary. A reconnect cannot
        // receive a shutting-down runtime or race its exclusive store owner.
        let bootstrap_lock = {
            let mut locks = self.local_bootstrap_locks.lock().await;
            Arc::clone(locks.entry(mob_id.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))))
        };
        let _bootstrap_guard = bootstrap_lock.lock().await;
        let removed = self.get(mob_id).await;
        if let Some(mob) = removed.as_ref() {
            let mut failures = Vec::new();
            // Cancellation at any following await must not make a partially
            // closed runtime available for reconnect. Retain it only for retry.
            mob.disposal.begin();
            if let Some(console) = mob.console.as_ref() {
                console.unregister_runtime("default");
            }
            if let Some(schedule_host) = mob.schedule_host.as_ref() {
                if let Err(error) = schedule_host.lock().await.shutdown().await {
                    failures.push(error);
                }
            }
            if let Some(schedule_watchdog) = mob.schedule_watchdog.as_ref() {
                if let Err(error) = schedule_watchdog.lock().await.abort_and_join().await {
                    failures.push(error);
                }
            }
            let mut native_disposed = true;
            if let Some(runtime) = mob.runtime.as_ref() {
                // Stop the runtime (event-drain task, member sessions, and the
                // member's MCP dispatcher — whose drop kills the desktop_ui
                // node child). Without this the drain task pins the runtime
                // Arc and everything leaks until the gateway process exits.
                if let Err(error) = mob.disposal.shutdown(runtime).await {
                    native_disposed = false;
                    failures.push(error);
                }
            }
            if native_disposed {
                if failures.is_empty() {
                    if let Some(bindings) = mob.schedule_bindings.as_ref() {
                        bindings.clear();
                    }
                }
                if let Some(console) = mob.console.as_ref() {
                    // Unregister closes discovery, but an already admitted
                    // native history read can retain cloned runtime handles.
                    // Keep this runtime in the registry until those reads
                    // finish; cancellation leaves it available for retry.
                    console.history_backfill_converged().await;
                }
                if let Some(event_drain) = mob.event_drain.as_ref() {
                    if let Err(error) = event_drain.lock().await.join().await {
                        failures.push(error);
                    }
                }
            }
            if !failures.is_empty() {
                return Err(failures.join("; "));
            }
        }
        self.mobs.write().await.remove(mob_id);
        Ok(removed.is_some())
    }

    pub async fn shutdown(&self) -> Vec<String> {
        // Await any admitted bootstrap before taking the list, and permanently
        // close creation even for callers holding a clone of this registry.
        *self.admission.write().await = false;
        let mob_ids = self.list().await.into_iter()
            .map(|mob| mob.mob_id.clone()).collect::<Vec<_>>();
        futures_util::future::join_all(mob_ids.iter().map(|mob_id| self.remove(mob_id)))
            .await.into_iter().filter_map(Result::err).collect()
    }

    /// Called only after native shutdown and all admitted gateway requests
    /// have settled. This observes mob-store closure; it never removes storage.
    pub async fn drain_storage_observers(&self) -> Vec<String> {
        if *self.admission.read().await {
            return vec!["Cannot drain mob observers while runtime admission is open".into()];
        }
        let targets = self.observer_disposals.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values().cloned().collect::<Vec<_>>();
        let mut failures = Vec::new();
        for target in targets {
            if let Err(error) = target.drain().await {
                failures.push(error);
            }
        }
        failures
    }
}

pub async fn mobkit_rpc(
    runtime: &UnifiedRuntime,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    // The desktop protocol keeps its existing namespace across upgrades.
    // Only the native dispatch boundary adopts Meta's renamed RPC methods.
    let native_method = method.strip_prefix("mobkit/")
        .map(|suffix| format!("meta/{suffix}"))
        .unwrap_or_else(|| method.to_owned());
    let request = json!({
        "jsonrpc": "2.0",
        "id": "desktop",
        "method": native_method,
        "params": params,
    });
    let raw = handle_unified_rpc_json(
        runtime,
        &request.to_string(),
        Duration::from_secs(30),
        None,
        None,
    )
    .await;
    let response: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if let Some(error) = response.get("error") {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("MobKit RPC failed")
            .to_string());
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

pub async fn list_members(runtime: &UnifiedRuntime) -> Vec<Value> {
    runtime
        .mob_handle()
        .list_members()
        .await
        .iter()
        .map(member_entry_to_json)
        .collect()
}

/// Read the member's current durable LLM identity without materializing its
/// transcript. The gateway uses this only to prevent an omitted
/// provider-params override from preserving a foreign provider tag across a
/// provider-family switch.
pub async fn member_llm_identity(
    runtime: &UnifiedRuntime,
    member_id: &str,
) -> Result<Option<meerkat_core::SessionLlmIdentity>, String> {
    let member = member_comms_id::mob_member_id(member_id);
    let Some(session_id) = runtime
        .mob_handle()
        .resolve_bridge_session_id(&member)
        .await
    else {
        return Ok(None);
    };
    let service = runtime
        .mob_runtime()
        .session_service()
        .ok_or_else(|| "MobKit runtime has no session service".to_string())?;
    let view = service
        .load_persisted_session_metadata(&session_id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(view
        .and_then(|view| view.session_metadata)
        .map(|metadata| metadata.llm_identity()))
}

pub async fn send_to_member(
    runtime: &UnifiedRuntime,
    member_id: &str,
    content: &str,
    handling_mode: meerkat_core::types::HandlingMode,
) -> Result<String, String> {
    send_message_on_mob_with_mode(
        &runtime.mob_handle(),
        member_id,
        meerkat_core::ContentInput::Text(content.to_string()),
        handling_mode,
    )
    .await
    .map_err(|error| error.to_string())
}

/// Canonical admission result for one desktop-authored member turn.
///
/// `applied_llm_identity` is populated only after MobKit's serialized
/// executor boundary has authoritatively applied a requested per-turn
/// identity. Admission alone is intentionally not treated as proof.
pub struct StartedMemberTurn {
    pub applied_llm_identity: Option<meerkat_core::SessionLlmIdentity>,
    pub turn: meerkat_mob::MemberTurnHandle,
}

/// Start one desktop-authored member turn through MobKit's canonical
/// completion-bearing API and await the distinct LLM-identity acknowledgement.
///
/// The caller retains native completion and observes its request-scoped events.
/// Peer/helper sends keep their separate API; steering supplies empty options
/// through the same native completion-bearing admission path.
#[cfg(test)]
pub async fn start_member_turn(
    runtime: &UnifiedRuntime,
    member_id: &str,
    content: &str,
    handling_mode: meerkat_core::types::HandlingMode,
    options: MemberTurnOptions,
    event_tx: Option<meerkat_mob::MemberTurnEventSender>,
) -> Result<StartedMemberTurn, String> {
    start_member_turn_content(runtime, member_id, content.into(), handling_mode, options, event_tx).await
}

pub async fn start_member_turn_content(
    runtime: &UnifiedRuntime,
    member_id: &str,
    content: meerkat_core::ContentInput,
    handling_mode: meerkat_core::types::HandlingMode,
    options: MemberTurnOptions,
    event_tx: Option<meerkat_mob::MemberTurnEventSender>,
) -> Result<StartedMemberTurn, String> {
    if member_id.trim().is_empty() {
        return Err("member_id must not be empty".to_string());
    }
    if content.text_content().trim().is_empty() && !content.has_images() {
        return Err("content must not be empty".to_string());
    }

    let mut admission = runtime
        .start_member_turn(
            member_id,
            content,
            handling_mode,
            options,
            event_tx,
        )
        .await
        .map_err(|error| error.to_string())?;
    let applied_llm_identity = admission
        .turn
        .wait_for_applied_llm_identity()
        .await
        .map_err(|error| error.to_string())?;
    Ok(StartedMemberTurn {
        applied_llm_identity,
        turn: admission.turn,
    })
}

pub async fn send_peer_message(
    source_runtime: &UnifiedRuntime,
    source_member_id: &str,
    target_peer_id: &str,
    target_display_name: Option<&str>,
    content: &str,
    handling_mode: meerkat_core::types::HandlingMode,
) -> Result<Value, String> {
    if source_member_id.trim().is_empty() {
        return Err("source_member_id must not be empty".to_string());
    }
    if target_peer_id.trim().is_empty() {
        return Err("target_peer_id must not be empty".to_string());
    }
    if content.trim().is_empty() {
        return Err("content must not be empty".to_string());
    }

    let source_mid = member_comms_id::mob_member_id(source_member_id);
    let source_session_id = source_runtime
        .mob_handle()
        .resolve_bridge_session_id(&source_mid)
        .await
        .ok_or_else(|| {
            format!(
                "source member '{source_member_id}' in mob '{}' has no bridge session",
                source_runtime.mob_id()
            )
        })?;
    let session_service = source_runtime
        .mob_runtime()
        .session_service()
        .ok_or_else(|| "source runtime has no session service".to_string())?;
    let comms_runtime =
        SessionServiceCommsExt::comms_runtime(session_service.as_ref(), &source_session_id)
            .await
            .ok_or_else(|| format!("source member '{source_member_id}' has no comms runtime"))?;
    let peer_id = PeerId::parse(target_peer_id).map_err(|error| error.to_string())?;
    let route = target_display_name
        .and_then(|name| PeerName::new(name.to_string()).ok())
        .map(|name| PeerRoute::with_display_name(peer_id, name))
        .unwrap_or_else(|| PeerRoute::new(peer_id));
    let receipt = comms_runtime
        .send(CommsCommand::PeerMessage {
            to: route,
            body: content.to_string(),
            blocks: None,
            handling_mode,
            // Inherit the runtime-level outbound taint declaration (0.7.15
            // added per-send override; None = no override).
            content_taint: None,
            // Desktop peer sends are not currently attached to a workgraph
            // objective. Preserve that explicitly on the command
            // contract instead of inventing correlation at this boundary.
            objective_id: None,
        })
        .await
        .map_err(|error| error.to_string())?;
    Ok(send_receipt_to_json(receipt))
}

/// Read the stable peer metadata expected by the desktop projection without
/// changing either runtime. All physical and durable topology mutation is
/// owned by MobKit's bilateral coordinator.
pub async fn local_member_pair_metadata(
    source_runtime: &UnifiedRuntime,
    source_member_id: &str,
    target_runtime: &UnifiedRuntime,
    target_member_id: &str,
) -> Result<Value, String> {
    let (source_peer_id, source_comms_name, source_address) = source_runtime
        .local_member_peer_info(source_member_id)
        .await
        .map_err(|error| error.to_string())?;
    let (target_peer_id, target_comms_name, target_address) = target_runtime
        .local_member_peer_info(target_member_id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(json!({
        "status": "peered",
        "transport": "inproc",
        "sourcePeer": {
            "memberId": source_member_id,
            "peerId": source_peer_id,
            "commsName": source_comms_name,
            "address": source_address,
        },
        "targetPeer": {
            "memberId": target_member_id,
            "peerId": target_peer_id,
            "commsName": target_comms_name,
            "address": target_address,
        }
    }))
}

fn send_receipt_to_json(receipt: SendReceipt) -> Value {
    match receipt {
        SendReceipt::InputAccepted {
            interaction_id,
            stream_reserved,
        } => json!({
            "kind": "input_accepted",
            "interactionId": interaction_id.to_string(),
            "streamReserved": stream_reserved,
        }),
        SendReceipt::PeerMessageSent {
            envelope_id,
            delivery,
        } => {
            let acked = matches!(delivery, PeerDeliveryOutcome::Acked);
            let delivery_kind = match delivery {
                PeerDeliveryOutcome::Acked => "acked",
                PeerDeliveryOutcome::DurablyResolved { .. } => "durably_resolved",
                PeerDeliveryOutcome::VolatileHandedOff => "volatile_handed_off",
                PeerDeliveryOutcome::Queued => "queued",
                _ => "unknown",
            };
            json!({
                "kind": "peer_message_sent",
                "envelopeId": envelope_id.to_string(),
                // Keep the legacy boolean for renderer compatibility while
                // exposing the stronger typed delivery fact added upstream.
                "acked": acked,
                "delivery": delivery_kind,
                "deliveryOutcome": delivery,
            })
        }
        SendReceipt::PeerLifecycleSent {
            envelope_id,
            delivery,
        } => json!({
            "kind": "peer_lifecycle_sent",
            "envelopeId": envelope_id.to_string(),
            "deliveryOutcome": delivery,
        }),
        SendReceipt::PeerRequestSent {
            envelope_id,
            interaction_id,
            stream_reserved,
            delivery,
        } => json!({
            "kind": "peer_request_sent",
            "envelopeId": envelope_id.to_string(),
            "interactionId": interaction_id.to_string(),
            "streamReserved": stream_reserved,
            "deliveryOutcome": delivery,
        }),
        SendReceipt::PeerResponseSent {
            envelope_id,
            in_reply_to,
            delivery,
        } => json!({
            "kind": "peer_response_sent",
            "envelopeId": envelope_id.to_string(),
            "inReplyTo": in_reply_to.to_string(),
            "deliveryOutcome": delivery,
        }),
    }
}

/// The observed console incarnation the user acted on. Targeting must not
/// silently follow a replacement worker or a same-name child in another mob.
#[derive(Clone, Debug)]
pub struct ConsoleExpectedTarget {
    pub identity: String,
    pub runtime_key: String,
    pub runtime_member_id: String,
    pub session_id: Option<String>,
    pub source_mob_id: Option<String>,
}

impl MobkitMobRuntime {
    pub async fn validate_console_incarnation(
        &self,
        expected: &ConsoleExpectedTarget,
    ) -> Result<meerkat_mobkit::ConsoleIdentityRecord, String> {
        let console = self
            .console
            .as_ref()
            .ok_or("MobKit console is unavailable")?;
        // inspect_identity resolves live members rather than using the roster's
        // intentionally cached read model while another refresh is in flight.
        let record = console
            .inspect_identity(&expected.identity)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("Agent is not in the current console roster")?
            .identity;
        if record.runtime_key != expected.runtime_key
            || record.runtime_member_id != expected.runtime_member_id
            || record.session_id != expected.session_id
            || record.labels.get("source_mob_id") != expected.source_mob_id.as_ref()
        {
            return Err("Console agent incarnation changed; refresh before acting".to_string());
        }
        if !record.addressable
            || record.visibility != meerkat_mobkit::ConsoleVisibility::Addressable
        {
            return Err("Console agent is not addressable".to_string());
        }
        Ok(record)
    }

    pub async fn validate_console_target(&self, expected: &ConsoleExpectedTarget) -> Result<meerkat_mobkit::ConsoleIdentityRecord,String> {
        let record=self.validate_console_incarnation(expected).await?;
        if self.kind == "thread"
            && record.runtime_member_id == self.coordinator_identity
            && record.labels.get("source_mob_id").is_none()
        {
            return Err(
                "Thread coordinator controls belong to the thread conversation".to_string(),
            );
        }
        Ok(record)
    }

    pub async fn stop_console_target(
        &self,
        expected: &ConsoleExpectedTarget,
        expected_run: meerkat_core::RunId,
    ) -> Result<meerkat_contracts::WireRunStopReceipt, String> {
        let record = self.validate_console_target(expected).await?;
        let runtime = self
            .runtime
            .as_ref()
            .ok_or("MobKit runtime is unavailable")?;
        let handle = match record.labels.get("source_mob_id") {
            None => runtime.mob_handle(),
            Some(source_mob_id) => {
                let native_state = runtime
                    .mob_runtime()
                    .agent_mob_mcp_state()
                    .ok_or("Native child runtime is unavailable")?;
                native_state
                    .mob_handles_snapshot()
                    .await
                    .map_err(|error| error.to_string())?
                    .into_iter()
                    .find(|(mob_id, _)| mob_id.as_str() == source_mob_id)
                    .map(|(_, handle)| handle)
                    .ok_or("Native child mob is no longer available")?
            }
        };
        // Resolve the exact native roster row, not the console's display alias.
        let member = handle
            .list_members_observation_snapshot()
            .await
            .into_iter()
            .find(|member| {
                member_comms_id::runtime_alias_str(member.agent_identity.as_str())
                    == record.runtime_member_id
            })
            .ok_or("Native member is no longer available")?;
        let current_session = handle
            .resolve_bridge_session_id_observation(&member.agent_identity)
            .await
            .map(|id| id.to_string());
        if current_session != expected.session_id {
            return Err("Native member session changed; refresh before stopping".to_string());
        }
        handle
            .stop_member_run(
                meerkat_mob::MobControlPrincipal::Owner,
                member.agent_identity,
                expected_run,
                "Stopped from agent conversation",
            )
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn console_target_busy(
        &self,
        expected: &ConsoleExpectedTarget,
    ) -> Result<bool, String> {
        let record = self.validate_console_incarnation(expected).await?;
        let session_id: meerkat_core::SessionId = serde_json::from_value(json!(record
            .session_id
            .as_ref()
            .ok_or("Console agent has no native session")?))
        .map_err(|error| format!("Console session identity is invalid: {error}"))?;
        let runtime = self
            .session_runtime
            .as_ref()
            .ok_or("Native session activity is unavailable")?;
        let state = tokio::time::timeout(
            Duration::from_secs(2),
            meerkat_runtime::SessionServiceRuntimeExt::runtime_state(runtime.as_ref(), &session_id),
        )
        .await
        .map_err(|_| "Native session activity read timed out".to_string())?
        .map_err(|error| error.to_string())?;
        self.validate_console_incarnation(expected).await?;
        match state {
            meerkat_runtime::RuntimeState::Running => Ok(true),
            meerkat_runtime::RuntimeState::Idle | meerkat_runtime::RuntimeState::Attached => {
                Ok(false)
            }
            _ => Err(format!("Native session is not ready: {state}")),
        }
    }

    pub async fn team_snapshot(&self) -> Value {
        let mut result = json!({
            "mobId": self.mob_id,
            "kind": self.kind,
            "label": self.label,
            "consoleStatus": "unavailable",
            "accessMode": self.access_mode,
            "identities": [],
        });
        if let Some(runtime) = self.runtime.as_ref() {
            if let Some(state) = runtime.mob_runtime().agent_mob_mcp_state() {
                if let Ok(Ok(handles)) = tokio::time::timeout(Duration::from_secs(2), state.mob_handles_snapshot()).await {
                    let owner_bound = handles.iter().filter_map(|(id, handle)| {
                        handle.owner_bridge_session_lifecycle_authority().map(|_| id.to_string())
                    }).collect::<Vec<_>>();
                    let stopped = handles.into_iter().filter_map(|(id, handle)| {
                        (handle.status_observation_snapshot() == meerkat_mob::MobState::Stopped).then(|| id.to_string())
                    }).collect::<Vec<_>>();
                    result["stoppedCrewIds"] = json!(stopped);
                    result["ownerBoundCrewIds"] = json!(owner_bound);
                }
            }
        }
        let Some(console) = self.console.as_ref() else {
            result["error"] = json!("MobKit console is unavailable for this mob");
            return result;
        };
        match tokio::time::timeout(Duration::from_secs(5), console.list_identities()).await {
            Ok(Ok(identities)) => {
                result["consoleStatus"] = json!("ready");
                result["identities"] = json!(identities);
            }
            Ok(Err(error)) => {
                result["consoleStatus"] = json!("error");
                result["error"] = json!(error.to_string());
            }
            Err(_) => {
                result["consoleStatus"] = json!("error");
                result["error"] = json!("MobKit identity observation timed out");
            }
        }
        result
    }

    pub async fn snapshot(&self) -> Value {
        let status = match &self.runtime {
            Some(runtime) => runtime
                .mob_handle()
                .status()
                .await
                .map(|status| format!("{status:?}"))
                .unwrap_or_else(|error| format!("error: {error}")),
            None => "remote".to_string(),
        };
        json!({
            "mobId": self.mob_id,
            "kind": self.kind,
            "label": self.label,
            "placement": self.placement_json(),
            "coordinatorIdentity": self.coordinator_identity,
            "accessMode": self.access_mode,
            "stateRoot": self.state_root_string(),
            "configStateRoot": self.config_state_root.to_string_lossy(),
            "realmId": self.realm_id,
            "health": status,
            "status": status,
            "createdAt": self.created_at,
            "members": match &self.runtime {
                Some(runtime) => list_members(runtime).await,
                None => Vec::new(),
            },
        })
    }

    pub fn placement_json(&self) -> Value {
        match &self.placement {
            MobPlacement::Local => json!({ "kind": "local", "status": "ready" }),
            MobPlacement::RemoteTcp {
                endpoint,
                pubkey_b64,
                status,
            } => json!({
                "kind": "remote_tcp",
                "endpoint": endpoint,
                "pubkeyB64": pubkey_b64,
                "status": status,
            }),
        }
    }

    pub fn state_root_string(&self) -> String {
        self.state_root.to_string_lossy().to_string()
    }
}

/// Build a pre-connected MCP dispatcher exposing the desktop UI tools
/// (`ui_multiple_choice`) plus the flow-delegation tools (`spawn_flow`,
/// `flow_status`, `send_to_flow_member`, `collect_flow_job`, `retire_flow`) to a
/// mob member. These call back into the Electron main process over the UI bridge,
/// closing the delegation loop from the agent's side.
///
/// Returns `Ok(None)` when the bridge env is absent (headless builds, unit tests)
/// so bootstrap stays functional without the desktop shell. The dispatcher is a
/// per-spawn overlay (`SpawnMemberSpec.external_tools`): in-process only, applied
/// to fresh spawns; a mid-process member revival would not re-attach it until the
/// gateway respawns the thread, which it does per process.
async fn build_ui_mcp_dispatcher(
    include_flow_tools: bool,
) -> Option<Arc<dyn meerkat_core::AgentToolDispatcher>> {
    let bridge_url = std::env::var("MEERKAT_UI_BRIDGE_URL").ok()?;
    let bridge_token = std::env::var("MEERKAT_UI_BRIDGE_TOKEN").ok()?;
    let server_js = std::env::var("MEERKAT_UI_MCP_SERVER_JS").ok()?;
    let node_command = std::env::var("MEERKAT_UI_MCP_NODE")
        .or_else(|_| std::env::var("MEERKAT_NODE_PATH"))
        .unwrap_or_else(|_| "node".to_string());

    // Fail-closed staging requires a runtime-backed surface handle; the unbound
    // default handle rejects `stage_add`. An ephemeral handle lets us stage and
    // connect the server outside of a live session.
    let mut router = McpRouter::new_with_surface_handle(Arc::new(
        meerkat_runtime::RuntimeExternalToolSurfaceHandle::ephemeral(),
    ));
    let mut env = HashMap::new();
    env.insert("MEERKAT_UI_BRIDGE_URL".to_string(), bridge_url);
    env.insert("MEERKAT_UI_BRIDGE_TOKEN".to_string(), bridge_token);
    if !include_flow_tools {
        // Flow-delegation tools are thread-scoped; domain agents serve many
        // threads and get only the thread-independent UI tools.
        env.insert("MEERKAT_UI_MCP_FLOW_TOOLS".to_string(), "0".to_string());
    }
    if let Err(error) = router.stage_add(McpServerConfig::stdio(
        "desktop_ui",
        node_command,
        vec![server_js],
        env,
    )) {
        tracing::warn!(error = %error, "failed to stage desktop_ui MCP server; UI tools unavailable");
        return None;
    }
    if let Err(error) = router.apply_staged().await {
        tracing::warn!(error = %error, "failed to connect desktop_ui MCP server; UI tools unavailable");
        return None;
    }
    let adapter = Arc::new(McpRouterAdapter::new(router));
    // Block until the server has listed its tools so the first ingress turn sees
    // them; otherwise they would only appear at a later tool-config boundary.
    if let Err(error) = adapter.wait_until_ready(Duration::from_secs(15)).await {
        tracing::warn!(
            pending = ?error.pending,
            "desktop_ui MCP server not ready within timeout; UI tools may appear late"
        );
    }
    if let Err(error) = adapter.refresh_tools().await {
        tracing::warn!(error = %error, "failed to refresh desktop_ui MCP tools");
    }
    let dispatcher: Arc<dyn meerkat_core::AgentToolDispatcher> = adapter;
    tracing::info!(
        tool_count = dispatcher.tools().len(),
        "desktop_ui MCP dispatcher attached to ingress agent"
    );
    Some(dispatcher)
}

const PROJECT_AGENT_PROPOSAL_TOOL: &str = "ui_project_agent_proposal";

/// Only the exact app-owned proposal process has read-only authority. The
/// native MCP router rechecks this declaration at the physical transport entry.
struct PureProjectAgentProposal {
    selected: McpServerConfig,
}

#[async_trait::async_trait]
impl meerkat_mcp::McpCallContextProvider for PureProjectAgentProposal {
    async fn prepare(
        &self,
        target: meerkat_mcp::McpCallTarget<'_>,
        _call: meerkat_core::types::ToolCallView<'_>,
        _context: &meerkat_core::ToolDispatchContext,
    ) -> Result<Option<meerkat_mcp::McpCallContext>, meerkat_mcp::McpCallContextError> {
        if target.config != &self.selected || target.raw_operation != PROJECT_AGENT_PROPOSAL_TOOL {
            return Err(meerkat_mcp::McpCallContextError::Denied);
        }
        Ok(None)
    }

    fn tool_mutation_class(
        &self,
        config: &McpServerConfig,
        operation: &str,
    ) -> meerkat_core::ToolMutationClass {
        if config == &self.selected && operation == PROJECT_AGENT_PROPOSAL_TOOL {
            meerkat_core::ToolMutationClass::ReadOnly
        } else {
            meerkat_core::ToolMutationClass::Unknown
        }
    }
}

static PROJECT_AGENT_PROPOSAL_DISPATCHER: tokio::sync::OnceCell<
    Result<Arc<dyn meerkat_core::AgentToolDispatcher>, String>,
> = tokio::sync::OnceCell::const_new();

pub(crate) async fn project_agent_proposal_dispatcher(
) -> Result<Option<Arc<dyn meerkat_core::AgentToolDispatcher>>, String> {
    let Some(server_js) = std::env::var("MEERKAT_PROJECT_AGENT_PROPOSAL_MCP_SERVER_JS")
        .ok()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(None);
    };
    let node_command = std::env::var("MEERKAT_NODE_PATH").unwrap_or_else(|_| "node".to_string());
    PROJECT_AGENT_PROPOSAL_DISPATCHER
        .get_or_init(|| async {
            connect_project_agent_proposal_dispatcher(node_command, server_js).await
        })
        .await
        .clone()
        .map(Some)
}

async fn connect_project_agent_proposal_dispatcher(
    node_command: String,
    server_js: String,
) -> Result<Arc<dyn meerkat_core::AgentToolDispatcher>, String> {
    let selected = McpServerConfig::stdio(
        "project_agent_proposal",
        node_command,
        vec![server_js],
        HashMap::new(),
    );
    let mut router = McpRouter::new_with_surface_handle(Arc::new(
        meerkat_runtime::RuntimeExternalToolSurfaceHandle::ephemeral(),
    ))
    .with_call_context_provider(Arc::new(PureProjectAgentProposal {
        selected: selected.clone(),
    }));
    router
        .stage_add(selected)
        .map_err(|error| format!("failed to stage project-agent proposal tool: {error}"))?;
    tokio::time::timeout(Duration::from_secs(15), router.apply_staged())
        .await
        .map_err(|_| "project-agent proposal server connection timed out".to_string())?
        .map_err(|error| format!("failed to connect project-agent proposal tool: {error}"))?;
    let adapter = Arc::new(McpRouterAdapter::new(router));
    let notices = adapter
        .wait_until_ready(Duration::from_secs(15))
        .await
        .map_err(|error| format!("project-agent proposal server is not ready: {error:?}"))?;
    // Settled readiness also includes failed background connections. Preserve
    // their native cause rather than misreporting an empty tool catalog.
    if let Some(failure) = notices
        .iter()
        .find(|notice| notice.phase == meerkat_core::event::ExternalToolDeltaPhase::Failed)
    {
        let detail = failure
            .detail
            .as_deref()
            .unwrap_or("native MCP connection failed without a diagnostic");
        adapter.shutdown().await;
        return Err(format!(
            "failed to connect project-agent proposal tool: {detail}"
        ));
    }
    adapter
        .refresh_tools()
        .await
        .map_err(|error| format!("failed to list project-agent proposal tool: {error}"))?;
    let dispatcher: Arc<dyn meerkat_core::AgentToolDispatcher> = adapter.clone();
    if dispatcher.tools().len() != 1
        || dispatcher.tools()[0].name.as_str() != PROJECT_AGENT_PROPOSAL_TOOL
    {
        adapter.shutdown().await;
        return Err(
            "project-agent proposal server must expose only ui_project_agent_proposal".to_string(),
        );
    }
    Ok(dispatcher)
}

fn desktop_flow_instructions(
    thread_id: Option<&str>,
    available_tools: &[Arc<meerkat_core::types::ToolDef>],
) -> Option<String> {
    let thread_id = thread_id?;
    let required = [
        "spawn_flow",
        "flow_status",
        "send_to_flow_member",
        "collect_flow_job",
        "retire_flow",
    ];
    if !required.iter().all(|name| {
        available_tools
            .iter()
            .any(|tool| tool.name.as_str() == *name)
    }) {
        return None;
    }
    Some(format!(
        "The desktop flow tools are available for this thread. For a pipeline of distinct roles, \
call `spawn_flow` with a clear objective, observe progress with `flow_status`, send follow-up work with \
`send_to_flow_member`, collect results with `collect_flow_job`, and call `retire_flow` when done. \
When the user asks for a flow, use these tools and report its actual progress. \
Pass this exact `thread_id` to every desktop flow tool: `{thread_id}`."
    ))
}

#[cfg(test)]
async fn bootstrap_local_runtime(
    input: CreateMobInput,
    host_tools: Arc<HostToolTransport>,
) -> Result<MobkitMobRuntime, String> {
    bootstrap_local_runtime_inner(input, host_tools, None, None).await
}

async fn bootstrap_local_runtime_inner(
    input: CreateMobInput,
    host_tools: Arc<HostToolTransport>,
    test_llm_client: Option<Arc<dyn meerkat::LlmClient>>,
    observer_disposals: Option<&ObserverDisposalRegistry>,
) -> Result<MobkitMobRuntime, String> {
    let proposal_dispatcher = if input.kind == "thread" {
        project_agent_proposal_dispatcher().await?
    } else {
        None
    };
    bootstrap_local_runtime_with_proposal_dispatcher(
        input,
        host_tools,
        test_llm_client,
        proposal_dispatcher,
        observer_disposals,
    )
    .await
}

async fn bootstrap_local_runtime_with_proposal_dispatcher(
    input: CreateMobInput,
    host_tools: Arc<HostToolTransport>,
    test_llm_client: Option<Arc<dyn meerkat::LlmClient>>,
    proposal_dispatcher: Option<Arc<dyn meerkat_core::AgentToolDispatcher>>,
    observer_disposals: Option<&ObserverDisposalRegistry>,
) -> Result<MobkitMobRuntime, String> {
    // The desktop is the credential owner and opts into Keychain-aware native
    // persistence. Tests can exercise the same runtime with an isolated store.
    let persistence = crate::provider_auth::desktop_token_backend()
        .and_then(meerkat_providers::auth_store::TokenStoreBackend::open_with_refresh_authority)
        .map_err(|error| format!("failed to open desktop credential store: {error}"))?;
    bootstrap_local_runtime_with_provider_persistence(
        input, host_tools, test_llm_client, proposal_dispatcher, persistence,
        observer_disposals,
    ).await
}

fn local_mob_storage(
    input: &CreateMobInput,
) -> (PathBuf, meerkat_mobkit::MetaStorageLayout, PathBuf) {
    let root = input.state_root.join("mobkit").join(stable_slug(&input.mob_id));
    let layout = meerkat_mobkit::MetaStorageLayout::with_injected_roots(root.clone(), None);
    let database = root.join("mob.sqlite");
    (root, layout, database)
}

fn desktop_topology_policy() -> TopologyControlPolicy {
    TopologyControlPolicy {
        mode: TopologyControlMode::Editable,
        // The desktop picker explicitly admits at most eight frozen targets.
        allow_bulk: true,
        max_batch_size: 8,
        allow_cross_authority: true,
        receipt_limit: 256,
        idempotency_history_limit: 4_096,
    }
}

async fn bootstrap_local_runtime_with_provider_persistence(
    input: CreateMobInput,
    host_tools: Arc<HostToolTransport>,
    test_llm_client: Option<Arc<dyn meerkat::LlmClient>>,
    proposal_dispatcher: Option<Arc<dyn meerkat_core::AgentToolDispatcher>>,
    provider_auth_persistence: meerkat_providers::auth_store::ProviderAuthPersistence,
    observer_disposals: Option<&ObserverDisposalRegistry>,
) -> Result<MobkitMobRuntime, String> {
    let (mob_root, _, mob_db_path) = local_mob_storage(&input);
    std::fs::create_dir_all(&mob_root).map_err(|error| error.to_string())?;
    // Creation holds this mob's admission lock and has no native store owner.
    // Adopt the stopped installation before resolving or opening its stores.
    let mut storage_admission = storage_upgrade::prepare(&mob_root, desktop_topology_policy())
        .await.map_err(|error| format!("{error:?}"))?;
    let storage_layout = meerkat_mobkit::MetaStorageLayout::with_injected_roots(mob_root.clone(), None);
    let existing_mob = mob_db_path.exists();
    migrate_stored_mob_events_v8_to_v9(&mob_db_path)?;
    let definition_storage = open_mob_definition_storage(
        storage_layout.clone(), &mob_db_path, observer_disposals,
    )?;
    let definition = durable_mob_definition_from_storage(
        &input, &mob_db_path, definition_storage,
    ).await?;
    let coordinator_profile = definition
        .orchestrator
        .as_ref()
        .map(|orchestrator| orchestrator.profile.clone())
        .unwrap_or_else(|| ProfileName::from(input.role.as_str()));
    // Runtime mode is a desktop interaction policy, not durable project-agent
    // authority. Keep legacy definitions byte-for-byte compatible with the
    // spec store, then override the coordinator spawn below. MobKit records
    // that effective mode on MemberSpawned and the live roster.
    let coordinator_runtime_mode = runtime_mode_for_mob_kind(&input.kind);
    let definition_access_mode = if definition.profiles.get(&coordinator_profile)
        .and_then(|binding| binding.as_inline()).is_some_and(|profile| profile.tools.read_only) {
        crate::native_execution_modes::ExecutionMode::ReadOnly
    } else { crate::native_execution_modes::ExecutionMode::FullAccess };
    if input.kind == "domain" && input.access_mode == Some(crate::native_execution_modes::ExecutionMode::Approvals) {
        return Err("Supervised access is available for threads and their workers, not project agents.".into());
    }
    let desktop_access_mode = crate::native_approvals::resolve_mode(&mob_root, existing_mob, input.access_mode, definition_access_mode)?;
    if input.kind == "domain" && desktop_access_mode == crate::native_execution_modes::ExecutionMode::Approvals {
        return Err("Supervised access is available for threads and their workers. Project agents require the native responsibility-revision host, which this runtime cannot compose with the approval builder.".into());
    }
    let approvals = if desktop_access_mode == crate::native_execution_modes::ExecutionMode::Approvals {
        Some(crate::native_approvals::NativeApprovals::open(&mob_root)?)
    } else { None };
    let coordinator_instructions = definition
        .profiles
        .get(&coordinator_profile)
        .and_then(|binding| binding.as_inline())
        .map(|profile| profile.peer_description.clone())
        .unwrap_or_else(|| input.instructions.clone());
    let (storage, storage_provenance) =
        meerkat_mobkit::mob_composition_manifest::persistent_mob_storage(mob_db_path.clone())
            .map_err(|error| format!("failed to open mob storage: {error}"))?;
    let session_store = Arc::new(
        SqliteSessionStore::open(mob_root.join("sessions.sqlite"))
            .map_err(|error| format!("failed to open MobKit session store: {error}"))?,
    );
    let binary_blob_store: Arc<dyn BinaryBlobStore> = Arc::new(
        ObjectStoreBlobStore::local(mob_root.join("blobs"))
            .map_err(|error| format!("failed to open persistent MobKit blob store: {error}"))?,
    );
    let blob_store: Arc<dyn meerkat_core::BlobStore> =
        Arc::new(Base64BlobStoreAdapter::new(binary_blob_store.clone()));
    let runtime_db_path = mob_root.join("runtime.sqlite");
    let runtime_store: Arc<dyn meerkat_runtime::RuntimeStore> = Arc::new(
        meerkat_runtime::store::SqliteRuntimeStore::new(&runtime_db_path).map_err(|error| {
            format!(
                "failed to open persistent MobKit runtime store at {}: {error}",
                runtime_db_path.display()
            )
        })?,
    );
    let runtime_adapter = Arc::new(meerkat_runtime::MeerkatMachine::persistent(
        Arc::clone(&runtime_store),
        Arc::clone(&blob_store),
    ).map_err(|error| format!("failed to acquire persistent MobKit runtime: {error}"))?);
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    crate::native_process_custody::NativeProcessCustody::install(
        &runtime_adapter,
        mob_root.clone(),
    );
    let factory = AgentFactory::new(&mob_root)
        .with_provider_auth_persistence(provider_auth_persistence)
        .session_store(session_store.clone())
        .runtime_root(mob_root.clone())
        .project_root(input.project_path.clone())
        .context_root(input.project_path.clone())
        .builtins(true)
        .shell(true)
        .mob(true)
        .comms(true)
        .memory(true)
        .schedule(true)
        .workgraph(true);
    let realm_config =
        load_effective_realm_config(&input.config_project_path, &input.config_state_root).await?;
    let runtime_config_store = configured_auth::mob_config_store(
        crate::native_checkpoints::runtime_config_store(
            Arc::clone(&realm_config.head_store),
            &input,
        )?,
        &input.mob_id,
        realm_config.realm_id.clone(),
    )?;
    let mut builder = FactoryAgentBuilder::new_with_config_store(
        factory,
        realm_config.raw_head,
        runtime_config_store.clone(),
    )
    .with_realm_inheritance(
        Arc::clone(&realm_config.source),
        realm_config.realm_id.clone(),
    );
    // `test_llm_client` is reachable only through the cfg(test) constructor
    // above. Keeping it on the factory-backed session service lets the proof
    // exercise the real MobKit turn pipeline without exposing a production
    // model-substitution switch.
    if let Some(test_llm_client) = test_llm_client.as_ref() {
        builder.default_llm_client = Some(Arc::clone(test_llm_client));
    }
    builder.default_blob_store = Some(blob_store.clone());
    // Delivery and the factory share one native job store and inbox. The
    // factory rebinds the projector to each session's actual realm.
    let job_store: Arc<dyn meerkat::DetachedJobStore> = Arc::new(
        meerkat::SqliteDetachedJobStore::open(storage_layout.jobs_db()
            .map_err(|error| format!("failed to resolve persistent MobKit job store: {error}"))?)
            .map_err(|error| format!("failed to open persistent MobKit job store: {error}"))?,
    );
    let runtime_delivery = meerkat_mobkit::mob_handle_runtime::MobRuntimeDelivery::new(
        Arc::clone(&runtime_store),
        Arc::clone(&job_store),
    );
    builder.default_detached_job_store = Some(Arc::clone(&job_store));
    builder.default_shell_job_delivery_projector = Some(meerkat::JobOutboxProjector::new_for_realm(
        job_store,
        runtime_delivery.inbox(),
        storage_layout.meerkat_level_realm()
            .map_err(|error| format!("failed to resolve persistent MobKit realm: {error}"))?
            .as_str(),
    ));
    let attached_schedule =
        meerkat_mobkit::schedule_wiring::attach_schedule_tools_with_identity_targets_reporting(
            &builder, &mob_root,
        )
        .map_err(|error| format!("failed to attach durable project-agent schedules: {error}"))?;
    let schedule_bindings = Arc::new(ScheduleBindings {
        targets: attached_schedule.mob_target_registry.clone(),
        tools: Arc::clone(&builder.default_schedule_tools),
    });
    let coordination_root = input.config_state_root.join("coordination");
    std::fs::create_dir_all(&coordination_root).map_err(|error| {
        format!(
            "failed to create workspace coordination root {}: {error}",
            coordination_root.display()
        )
    })?;
    let (workgraph_service, workgraph_admission_slot) =
        meerkat_mobkit::workgraph_wiring::attach_workgraph_tools_reporting(
            &builder,
            &coordination_root,
            realm_config.realm_id.as_str(),
        )
        .map_err(|error| format!("failed to attach workspace WorkGraph tools: {error}"))?;
    let agent_mob_tools_slot = Arc::clone(&builder.default_mob_tools);
    let session_llm_default_client_slot = Arc::new(std::sync::RwLock::new(test_llm_client.clone()));
    let session_llm_reconfigure_blueprint =
        meerkat::session_runtime::llm_reconfigure::SessionRuntimeLlmReconfigureHostBlueprint::new(
            &builder,
            mob_root.join("session-llm-reconfigure-config-state.json"),
            session_llm_default_client_slot,
        );
    // Keep the ordinary concrete service so the canonical instruction
    // activation facade remains available for all existing project agents.
    // The public facade is currently specialized to FactoryAgentBuilder.
    let (normal_session_service, approval_session_service) = if approvals.is_some() || input.kind == "thread" {
        (None, Some(Arc::new(PersistentSessionService::new(
            crate::native_approvals::ApprovalAgentBuilder {
                inner: builder,
                approvals: approvals.clone(),
                browser_children: (input.kind == "thread").then(|| {
                    crate::browser_bridge::BrowserChildTools::new(
                        input.project_path.clone(),
                        input.state_root.clone(),
                        input.mob_id.clone(),
                    )
                }),
            },
            64, session_store, Arc::clone(&runtime_store), blob_store,
        ))))
    } else {
        (Some(Arc::new(PersistentSessionService::new(
            builder, 64, session_store, Arc::clone(&runtime_store), blob_store,
        ))), None)
    };
    let reconfigure_service: Arc<
        dyn meerkat::session_runtime::llm_reconfigure::SessionRuntimeLlmReconfigureService,
    > = if let Some(service) = &normal_session_service { service.clone() }
        else { Arc::new(crate::native_approvals::ApprovalReconfigureService(approval_session_service.as_ref().expect("selected approval service").clone())) };
    session_llm_reconfigure_blueprint.install(&runtime_adapter, Arc::clone(&reconfigure_service));
    if !runtime_adapter.has_session_llm_reconfigure_host() {
        return Err("failed to install the canonical session LLM reconfiguration host".to_string());
    }
    let session_service: Arc<dyn meerkat_mob::MobSessionService> = if let Some(service) = &normal_session_service { service.clone() }
        else { approval_session_service.as_ref().expect("selected approval service").clone() };
    macro_rules! session_cleanup_for {
        ($service:expr) => {{
            let service = Arc::clone($service);
            Arc::new(crate::thread_dispose::OwnedSessionCleanup::new(move || {
                let service = Arc::clone(&service);
                async move {
                    service.try_shutdown().await
                        .map_err(|error| format!("Desktop session service cleanup did not complete: {error}"))
                }
            }))
        }};
    }
    let session_cleanup = if let Some(service) = &normal_session_service {
        session_cleanup_for!(service)
    } else {
        session_cleanup_for!(approval_session_service.as_ref().expect("selected approval service"))
    };
    let disposal = Arc::new(crate::thread_dispose::NativeRuntimeDisposal::with_session_cleanup(
        Arc::clone(&session_cleanup),
    ));
    let recovery_session = if input.kind == "thread" {
        crate::thread_recovery::recovering_session(
            &input.state_root, &input.mob_id, &input.coordinator_identity,
        )?
    } else { None };
    let coordinator_resume_session_id = durable_member_session_id(
        session_service.as_ref(),
        &input.mob_id,
        coordinator_profile.as_str(),
        &input.coordinator_identity,
        input.kind == "domain",
        recovery_session.as_ref(),
    )
    .await?;
    // Native storage decides whether this is creation or resume. Rechecking
    // an obsolete creation model must not block a saved agent that now uses
    // another model. Only a fresh member consumes the creation selection.
    let initial_coordinator_profile = match (
        coordinator_resume_session_id.as_ref(), input.initial_llm.as_ref(),
    ) {
        (None, Some(request)) => {
            let selection = crate::native_model::initial_selection_with_catalog(
                &request.params, &realm_config.effective, &request.catalog,
            )
                .map_err(|error| format!("Invalid initial agent model: {error}"))?;
            let mut profile = definition.profiles.get(&coordinator_profile)
                .and_then(|binding| binding.as_inline())
                .cloned()
                .ok_or_else(|| "The coordinator has no inline profile for its initial model".to_string())?;
            profile.model = input.model.clone();
            profile.provider = Some(selection.provider);
            profile.self_hosted_server_id = selection.self_hosted_server_id;
            profile.provider_params = selection.provider_params;
            Some(profile)
        }
        _ => None,
    };
    let access_mode = if let Some(session_id) = coordinator_resume_session_id.as_ref() {
        let saved = session_service.load_persisted_session_metadata(session_id).await
            .map_err(|error| format!("Cannot read native access mode: {error}"))?
            .and_then(|metadata| metadata.session_metadata)
            .ok_or_else(|| "The saved conversation has no native access policy metadata".to_string())?;
        let native_mode = crate::native_execution_modes::persisted_mode(saved.tooling.tool_access_policy.as_ref())?;
        if native_mode != definition_access_mode { return Err("Saved native tool policy differs from the mob definition".into()); }
        desktop_access_mode
    } else { desktop_access_mode };
    let mut spec = MobBootstrapSpec::new(definition, storage, session_service)
        .with_mob_storage_provenance(storage_provenance)
        .with_child_mob_storage(meerkat_mobkit::ChildMobStorage::Durable(storage_layout.clone()))
        .with_meta_storage_layout(storage_layout)
        .with_session_runtime_adapter(runtime_adapter.clone())
        .map_err(|error| format!("failed to bind MobKit session runtime: {error}"))?
        .with_runtime_delivery(runtime_delivery)
        // Order is contractual: child mobs snapshot WorkGraph authority when
        // agent mob tools are installed.
        .with_workgraph_service(Some(workgraph_service.clone()))
        .with_agent_mob_tools(agent_mob_tools_slot)
        .map_err(|error| format!("failed to compose native child-mob delivery: {error}"))?
        .with_workgraph_admission_slot(workgraph_admission_slot)
        .with_workgraph_admission_sidecar(&coordination_root);
    // Use the native default provider so the app proposal tool is present on
    // the first turn and restored member sessions. Per-spawn overlays alone
    // do not survive native member revival.
    // The native gateway preserves each tool owner's mutation declaration.
    // ComposedExternalTools in this release does not project those declarations,
    // so file readers, questions and the pure proposal tool use their own children.
    let mut tools = meerkat_core::ToolGatewayBuilder::new()
        .add_dispatcher(crate::native_execution_modes::workspace_reader(input.project_path.clone()))
        .add_dispatcher(crate::browser_bridge::dispatcher(input.project_path.clone(), input.state_root.clone(), input.mob_id.clone()));
    if let Some(questions) = crate::user_questions::dispatcher(
        input.project_path.clone(), input.state_root.clone(), input.mob_id.clone(),
    ) {
        tools = tools.add_dispatcher(questions);
    }
    if let Some(proposal) = proposal_dispatcher {
        tools = tools.add_dispatcher(proposal);
    }
    let dispatcher: Arc<dyn meerkat_core::AgentToolDispatcher> = Arc::new(
        tools.build().map_err(|error| format!("Cannot assemble workspace read tools: {error}"))?,
    );
    spec = spec.with_default_external_tools_provider(Arc::new(move || Some(Arc::clone(&dispatcher))));
    // Reconnecting a desktop mob restores its conversation without sending
    // an unsolicited orchestrator notification or starting a model turn.
    spec.options.notify_orchestrator_on_resume = false;
    spec.runtime_adapter = Some(runtime_adapter.clone());
    spec.binary_blob_store = Some(binary_blob_store);
    let config = MetaConfig {
        modules: Vec::<ModuleConfig>::new(),
        discovery: DiscoverySpec {
            namespace: "desktop".to_string(),
            modules: Vec::new(),
        },
        pre_spawn: Vec::<PreSpawnData>::new(),
    };
    let topology = TopologyBootstrapConfig {
        policy: desktop_topology_policy(),
        state_path: Some(mob_root.join("topology-control.json")),
    };
    storage_admission.handoff_topology();
    let mut runtime = match
        UnifiedRuntime::bootstrap_with_topology(spec, config, Duration::from_secs(45), topology).await
    {
        Ok(runtime) => runtime,
        Err(error) => {
            let mut error = format!("failed to bootstrap MobKit runtime: {error}");
            if let Err(cleanup) = session_cleanup.shutdown().await {
                error.push_str(&format!("; {cleanup}"));
            }
            return Err(error);
        }
    };
    let setup_result: Result<(), String> = async {
    if let Some(child_state) = runtime.mob_runtime().agent_mob_mcp_state() {
        let child_state = Arc::downgrade(&child_state);
        runtime_config_store.bind_child_realms(Arc::new(move || {
            let child_state = child_state.clone();
            Box::pin(async move {
                let child_state = child_state.upgrade().ok_or_else(||
                    "Native child-mob configuration owner is unavailable".to_string())?;
                child_state.mob_handles_snapshot().await
                    .map_err(|error| format!("Cannot read native child-mob ownership: {error}"))?
                    .into_iter()
                    .map(|(id, _)| meerkat_core::mob_realm_id(id.as_str()).map_err(|error| error.to_string()))
                    .collect()
            })
        }))?;
    }
    let peer_key_dir = mob_root.join("peer");
    let keys = GatewayPeerKeys::load_or_create(&peer_key_dir)
        .map_err(|error| format!("failed to create MobKit peer keys: {error}"))?;
    runtime.set_gateway_peer_keys(keys);
    if matches!(input.kind.as_str(), "domain" | "thread" | "sub") {
        let store =
            match meerkat_mobkit::SqliteConsoleLogStore::open(
                meerkat_mobkit::MetaStorageLayout::with_injected_roots(mob_root.clone(), None)
                    .console_db().map_err(|error| format!("failed to resolve durable native console log: {error}"))?.path,
            ) {
                Ok(store) => store,
                Err(error) => {
                    return Err(format!(
                        "failed to open durable native console log: {error}"
                    ));
                }
            };
        runtime.set_console_log_store(Arc::new(store));
    }
    // This desktop composition has no identity-first context. Let MobKit
    // consume its deferred activation and reconcile restored topology before
    // admitting work. The public activation API owns cleanup on failure.
    runtime
        .activate_without_identity_context()
        .await
        .map_err(|error| format!("failed to activate durable desktop mob: {error}"))?;
    Ok(())
    }.await;
    let runtime = Arc::new(runtime);
    if let Err(mut error) = setup_result {
        if let Err(cleanup) = disposal.shutdown(&runtime).await {
            error.push_str(&format!("; {cleanup}"));
        }
        return Err(error);
    }
    let mut event_drain = RetainedTask::new(
        "MobKit event drain",
        Arc::clone(&runtime).spawn_event_drain_task(),
    );

    let mut labels = BTreeMap::new();
    labels.insert("app.kind".to_string(), input.kind.clone());
    labels.insert("app.label".to_string(), input.label.clone());
    labels.insert(
        "app.project_path".to_string(),
        input.project_path.to_string_lossy().to_string(),
    );
    let mut spawn = SpawnMemberSpec::new(
        coordinator_profile.to_string(),
        input.coordinator_identity.clone(),
    )
    .with_runtime_mode(coordinator_runtime_mode)
    .with_labels(labels);
    if let Some(policy) = access_mode.tool_policy() {
        spawn = spawn.with_tool_access_policy(policy);
    }
    if let Some(session_id) = coordinator_resume_session_id {
        // UnifiedRuntime's public bootstrap path creates a fresh in-process
        // roster even when the mob event store already exists. Adopt the
        // durable bridge session explicitly so a desktop restart does not
        // silently discard the project agent's conversation context.
        spawn = spawn.with_resume_bridge_session_id(session_id);
    } else {
        // A restart request can be reconstructed from a lossy app projection.
        // Keep the durable profile charter authoritative for a fresh member;
        // resumed sessions already carry their original assembled prompt.
        spawn = spawn.with_additional_instructions(vec![coordinator_instructions]);
        // Initial choices must reach the first user or peer turn. Keep them
        // off the durable definition and its resume mask: a resumed session
        // owns any later model or reasoning changes. MobKit records this
        // effective initial profile on MemberSpawned for sessionless revival.
        spawn.override_profile = initial_coordinator_profile;
    }
    let coordinator_exists = list_members(&runtime)
        .await
        .iter()
        .any(|member| member_matches_identity(member, &input.coordinator_identity));
    if !coordinator_exists {
        // Thread coordinators (ingress) get the full desktop_ui tool set —
        // including the thread-scoped flow-delegation tools. Long-lived domain
        // agents get the thread-independent UI tools only (they serve many
        // threads, so there is no single thread_id to bind flow tools to).
        // Building the dispatcher spawns a node MCP child, so skip other kinds.
        let fallback = if input.kind == "thread" || input.kind == "domain" {
            build_ui_mcp_dispatcher(input.kind == "thread").await
        } else {
            None
        };
        if input.kind == "thread" {
            if let Some(instructions) = fallback.as_ref().and_then(|dispatcher| {
                desktop_flow_instructions(input.thread_id.as_deref(), &dispatcher.tools())
            }) {
                spawn
                    .additional_instructions
                    .get_or_insert_with(Vec::new)
                    .push(instructions);
            }
        }
        let host_dispatcher: Arc<dyn meerkat_core::AgentToolDispatcher> = host_tools;
        spawn.external_tools = Some(ComposedExternalTools::over(host_dispatcher, fallback));
        if let Err(error) = runtime.spawn(spawn).await {
            // `spawn_event_drain_task` retains the runtime Arc. A failed
            // coordinator restore must therefore shut the runtime down
            // explicitly before returning; otherwise its topology controller
            // remains alive outside the registry and every retry reports that
            // this process already owns the state.
            return Err(bootstrap_failure_after_drain(
                &runtime, &disposal, &mut event_drain, format!("failed to spawn MobKit coordinator: {error}"),
            ).await);
        }
    }

    // A replayed roster entry preserves identity but can still have no live
    // session or comms runtime. Materialize that exact member through the
    // native owner before topology queries or peer connections can use it.
    // This public API runs no turn and keeps the existing bridge session.
    if let Err(error) = runtime
        .mob_handle()
        .ensure_member_live(&member_comms_id::mob_member_id(&input.coordinator_identity))
        .await
    {
        return Err(bootstrap_failure_after_drain(
            &runtime, &disposal, &mut event_drain, format!("failed to materialize MobKit coordinator: {error}"),
        ).await);
    }

    // Native child enumeration initializes persisted child state on first
    // use. Complete that host restoration here, on the creation path, before
    // exposing a child-enabled console to read-only Team observers.
    if input.include_native_workers {
        if let Some(state) = runtime.mob_runtime().agent_mob_mcp_state() {
            if let Err(error) = state.mob_handles_snapshot().await {
                return Err(bootstrap_failure_after_drain(
                    &runtime, &disposal, &mut event_drain,
                    format!("failed to initialize native worker observation: {error}"),
                ).await);
            }
        }
    }

    // Start the firing plane only after the durable coordinator member has
    // been restored or spawned. Otherwise an occurrence due during bootstrap
    // can race the member binding it targets and be recorded as a false
    // delivery failure.
    let mob_state = runtime.mob_runtime().agent_mob_mcp_state();
    attached_schedule
        .mob_target_registry
        .set_mob_state(mob_state.clone());
    if let Err(error) =
        meerkat_mobkit::schedule_wiring::repair_resumable_session_targets_to_mob_members(
            &attached_schedule.service,
            &attached_schedule.mob_target_registry,
        )
        .await
    {
        tracing::warn!(
            mob_id = %input.mob_id,
            error = %error,
            "failed to repair resumable project-agent schedules"
        );
    }
    let responsibility_host = normal_session_service.as_ref().map(|service| Arc::new(crate::native_responsibilities::NativeResponsibilities::new(
        service.clone(), runtime_adapter.clone(),
    )));
    macro_rules! schedule_for_service {
        ($service:expr) => { meerkat_mobkit::schedule_wiring::spawn_schedule_host_with_identity_runtime(
            $service, runtime_adapter.clone(), attached_schedule.service.clone(), mob_state,
            runtime.mob_handle(), None, None, Some(workgraph_service), input.mob_id.clone(),
        ) };
    }
    let Some(schedule_host) =
        (if let Some(service) = normal_session_service { schedule_for_service!(service) }
        else { schedule_for_service!(approval_session_service.expect("selected approval service")) })
    else {
        return Err(bootstrap_failure_after_drain(
            &runtime, &disposal, &mut event_drain, "failed to start the project-agent schedule host".into(),
        ).await);
    };
    attached_schedule.firing_host_binding.bind();
    let schedule_watchdog = meerkat_mobkit::schedule_wiring::spawn_schedule_claim_watchdog(
        attached_schedule.service,
        mob_root.join(meerkat_mobkit::schedule_wiring::SCHEDULE_STORE_FILE),
        Default::default(),
    );

    // Reconstruct durable native history as well as projecting live events.
    // This recovers turns completed before the native event forwarder attaches
    // after restoration. Released MobKit skips unchanged session epochs; keep
    // each background domain's history reconstruction concurrency bounded.
    //
    // The released unregister API detaches this live source during remove(),
    // including its history discovery loop, while preserving stored frames.
    let console = MetaConsoleAggregator::new_with_options(
        runtime.console_log_store(),
        console_options_for_mob_kind(&input.kind),
    );
    console.register_runtime(ConsoleRuntimeRegistration {
        runtime_key: "default".to_string(),
        runtime: Arc::clone(&runtime),
        identity_namespace: String::new(),
        visibility_policy: Arc::new(crate::media::MediaConsolePolicy {include_workers:input.include_native_workers}),
    });

    Ok(MobkitMobRuntime {
        mob_id: input.mob_id,
        kind: input.kind,
        label: input.label,
        placement: MobPlacement::Local,
        coordinator_identity: input.coordinator_identity,
        state_root: input.state_root,
        config_state_root: input.config_state_root,
        checkpoint_project_path: input.config_project_path,
        checkpoint_workspace: input.project_path,
        checkpoint_incarnation: uuid::Uuid::new_v4(),
        checkpoint_runtime_store: Some(runtime_store),
        realm_id: realm_config.realm_id.to_string(),
        runtime: Some(runtime),
        session_runtime: Some(runtime_adapter),
        _llm_reconfigure_service: Some(reconfigure_service),
        responsibility_host,
        access_mode,
        approvals,
        console: Some(console),
        schedule_host: Some(Arc::new(Mutex::new(RetainedShutdown::new(
            "Project-agent scheduler", schedule_host.shutdown(),
        )))),
        schedule_bindings: Some(schedule_bindings),
        schedule_watchdog: Some(Arc::new(Mutex::new(RetainedTask::new(
            "Project-agent schedule watchdog", schedule_watchdog,
        )))),
        event_drain: Some(Arc::new(Mutex::new(event_drain))),
        disposal,
        created_at: Utc::now(),
    })
}

async fn bootstrap_failure_after_drain(
    runtime: &Arc<UnifiedRuntime>,
    disposal: &crate::thread_dispose::NativeRuntimeDisposal,
    event_drain: &mut RetainedTask,
    mut error: String,
) -> String {
    if let Err(cleanup) = disposal.shutdown(runtime).await {
        error.push_str(&format!("; {cleanup}"));
    }
    // Failed bootstrap has no registry owner to retain a stuck observer.
    // Native shutdown already owns event draining; stop and join this leaf task.
    if let Err(join_error) = event_drain.abort_and_join().await {
        error.push_str(&format!("; {join_error}"));
    }
    error
}

const LEGACY_STORED_MOB_EVENT_SCHEMA_VERSION: u64 = 8;
const CURRENT_STORED_MOB_EVENT_SCHEMA_VERSION: u64 = 9;

/// Upgrade the event envelope written by the matched Meerkat 0.7/MobKit 0.7
/// release before any 0.8 runtime is allowed to open or append to the mob.
///
/// Meerkat 0.8's v9 decoder retains v8's public event payload and treats its
/// new replay-only fields as optional. The missing upstream upgrade is
/// therefore an envelope migration, not a semantic event rewrite. We still
/// validate every legacy payload through the current public `MobEvent` type,
/// fence the database against concurrent store operations, create a coherent
/// SQLite backup, and commit every row in one transaction.
fn migrate_stored_mob_events_v8_to_v9(mob_db_path: &std::path::Path) -> Result<usize, String> {
    if !mob_db_path.exists() {
        return Ok(0);
    }

    let _fence = meerkat_sqlite::ExclusiveFence::acquire(mob_db_path, Duration::from_secs(5))
        .map_err(|error| {
            format!(
                "failed to acquire MobKit history migration fence for {}: {error}",
                mob_db_path.display()
            )
        })?;
    let mut connection = meerkat_sqlite::open(
        mob_db_path,
        meerkat_sqlite::ConnectionProfile::Maintenance { write: true },
    )
    .map_err(|error| {
        format!(
            "failed to open MobKit history for compatibility migration at {}: {error}",
            mob_db_path.display()
        )
    })?;

    let has_event_table = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mob_events')",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("failed to inspect MobKit history schema: {error}"))?;
    if !has_event_table {
        return Ok(0);
    }

    let mut legacy_rows = Vec::new();
    {
        let mut statement = connection
            .prepare("SELECT cursor, event_json FROM mob_events ORDER BY cursor")
            .map_err(|error| format!("failed to inspect stored MobKit events: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
            })
            .map_err(|error| format!("failed to read stored MobKit events: {error}"))?;

        for row in rows {
            let (cursor, bytes) =
                row.map_err(|error| format!("failed to read stored MobKit event row: {error}"))?;
            let mut envelope: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|error| {
                    format!("stored MobKit event {cursor} is invalid JSON: {error}")
                })?;
            let object = envelope
                .as_object_mut()
                .ok_or_else(|| format!("stored MobKit event {cursor} envelope is not an object"))?;
            let version = object
                .get("schema_version")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| {
                    format!("stored MobKit event {cursor} has no numeric schema_version")
                })?;
            match version {
                CURRENT_STORED_MOB_EVENT_SCHEMA_VERSION => {}
                LEGACY_STORED_MOB_EVENT_SCHEMA_VERSION => {
                    let event = object.get("event").cloned().ok_or_else(|| {
                        format!("stored MobKit event {cursor} has no event payload")
                    })?;
                    serde_json::from_value::<meerkat_mob::MobEvent>(event).map_err(|error| {
                        format!("stored MobKit event {cursor} cannot be migrated safely: {error}")
                    })?;
                    object.insert(
                        "schema_version".to_string(),
                        serde_json::Value::from(CURRENT_STORED_MOB_EVENT_SCHEMA_VERSION),
                    );
                    let migrated = serde_json::to_vec(&envelope).map_err(|error| {
                        format!("failed to encode migrated MobKit event {cursor}: {error}")
                    })?;
                    legacy_rows.push((cursor, migrated));
                }
                unsupported => {
                    return Err(format!(
                        "stored MobKit event {cursor} uses unsupported schema_version={unsupported}; expected 8 or 9"
                    ));
                }
            }
        }
    }

    if legacy_rows.is_empty() {
        return Ok(0);
    }

    let backup_path = mob_db_path.with_file_name(format!(
        "{}.pre-event-v9.backup",
        mob_db_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("mob.sqlite")
    ));
    if !backup_path.exists() {
        let backup_path_sql = backup_path.to_str().ok_or_else(|| {
            format!(
                "MobKit history backup path is not valid UTF-8: {}",
                backup_path.display()
            )
        })?;
        connection
            .execute("VACUUM INTO ?1", rusqlite::params![backup_path_sql])
            .map_err(|error| {
                format!(
                    "failed to back up MobKit history before migration to {}: {error}",
                    backup_path.display()
                )
            })?;
    }

    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| format!("failed to start MobKit history migration: {error}"))?;
    for (cursor, migrated) in &legacy_rows {
        let changed = transaction
            .execute(
                "UPDATE mob_events SET event_json = ?1 WHERE cursor = ?2",
                rusqlite::params![migrated, cursor],
            )
            .map_err(|error| format!("failed to migrate stored MobKit event {cursor}: {error}"))?;
        if changed != 1 {
            return Err(format!(
                "stored MobKit event {cursor} changed during compatibility migration"
            ));
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit MobKit history migration: {error}"))?;

    tracing::info!(
        path = %mob_db_path.display(),
        backup = %backup_path.display(),
        migrated_events = legacy_rows.len(),
        "migrated stored MobKit event history from schema v8 to v9"
    );
    Ok(legacy_rows.len())
}

fn open_mob_definition_storage(
    layout: meerkat_mobkit::MetaStorageLayout,
    database: &std::path::Path,
    observer_disposals: Option<&ObserverDisposalRegistry>,
) -> Result<MobStorage, String> {
    let storage = MobStorage::persistent(database)
        .map_err(|error| format!("failed to open mob definition storage: {error}"))?;
    // Successful acquisition is the first observer-owning boundary. Record it
    // synchronously before any await so cancellation and later bootstrap
    // failures cannot lose the cleanup obligation. Pre-storage failures have
    // acquired nothing and must not invent a missing-path cleanup failure.
    if let Some(disposals) = observer_disposals {
        let database = database.to_path_buf();
        disposals.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(database.clone())
            .or_insert_with(|| Arc::new(MobStoreObserverDisposal::new(layout, database)));
    }
    Ok(storage)
}

#[cfg(test)]
async fn durable_mob_definition(
    input: &CreateMobInput,
    mob_db_path: &std::path::Path,
) -> Result<MobDefinition, String> {
    let storage = MobStorage::persistent(mob_db_path)
        .map_err(|error| format!("failed to open mob definition storage: {error}"))?;
    durable_mob_definition_from_storage(input, mob_db_path, storage).await
}

async fn durable_mob_definition_from_storage(
    input: &CreateMobInput,
    mob_db_path: &std::path::Path,
    storage: MobStorage,
) -> Result<MobDefinition, String> {
    let snapshot = storage
        .created_definition_snapshot()
        .await
        .map_err(|error| format!("failed to read canonical mob definition: {error}"))?;
    if let Some(snapshot) = snapshot {
        if snapshot.definition().id.as_str() != input.mob_id {
            return Err(format!(
                "stored mob definition belongs to {}, requested {}",
                snapshot.definition().id,
                input.mob_id
            ));
        }
        // Structural events own the durable definition. Update only the
        // existing maintenance capability delta through the released epoch CAS;
        // the spec store is its projection and must never lead that authority.
        let mut definition = snapshot.definition().clone();
        if input.kind == "domain" && enable_domain_maintenance_tools(&mut definition) {
            meerkat_mobkit::spec_update_ceremony::declare_spec_update(
                &storage,
                &input.mob_id,
                &definition,
                snapshot.epoch(),
            )
            .await
            .map_err(|error| {
                format!("failed to migrate project-agent tool capabilities: {error}")
            })?;
            return storage
                .created_definition()
                .await
                .map_err(|error| format!("failed to read migrated mob definition: {error}"))?
                .ok_or_else(|| "canonical mob definition disappeared after migration".to_string());
        }
        return Ok(definition);
    }

    let stores = SqliteMobStores::open(mob_db_path)
        .map_err(|error| format!("failed to inspect uncreated mob storage: {error}"))?;
    let orphan_spec = stores
        .spec_store()
        .get_spec(&MobId::from(input.mob_id.as_str()))
        .await
        .map_err(|error| format!("failed to inspect orphan mob projection: {error}"))?
        .is_some();
    if orphan_spec
        || !storage
            .is_event_log_empty()
            .await
            .map_err(|error| format!("failed to inspect mob creation history: {error}"))?
    {
        return Err(format!(
            "incomplete durable mob {} at {}: stored state has no canonical MobCreated definition",
            input.mob_id,
            mob_db_path.display()
        ));
    }
    MobDefinition::from_toml(&definition_toml(input))
        .map_err(|error| format!("invalid MobKit definition: {error}"))
}

fn enable_domain_maintenance_tools(definition: &mut MobDefinition) -> bool {
    let Some(orchestrator) = definition.orchestrator.as_ref() else {
        return false;
    };
    let Some(profile) = definition
        .profiles
        .get_mut(&orchestrator.profile)
        .and_then(|binding| binding.as_inline_mut())
    else {
        return false;
    };
    let changed = !profile.tools.schedule || !profile.tools.workgraph;
    profile.tools.schedule = true;
    profile.tools.workgraph = true;
    changed
}

async fn durable_member_session_id(
    session_service: &dyn MobSessionService,
    mob_id: &str,
    role: &str,
    agent_identity: &str,
    require_maintenance_tools: bool,
    recovery_session: Option<&meerkat_core::SessionId>,
) -> Result<Option<meerkat_core::SessionId>, String> {
    if let Some(session_id) = recovery_session {
        let metadata = session_service.load_persisted_session_metadata(session_id).await
            .map_err(|error| format!("Cannot load the original recovery session: {error}"))?
            .ok_or_else(|| "The original recovery session is missing or archived".to_string())?;
        let binding = metadata.mob_member_binding()
            .ok_or_else(|| "The original recovery session has no native member binding".to_string())?;
        if binding.mob_id != mob_id || binding.role != role || binding.member != agent_identity {
            return Err("The original recovery session belongs to a different native member".into());
        }
        return Ok(Some(session_id.clone()));
    }
    let sessions = match classify_member_session_listing(
        session_service.list(SessionQuery::default()).await,
    )? {
        MemberSessionListing::Sessions(sessions) => sessions,
        MemberSessionListing::Corrupted(corrupted_session_id) => {
            // Meerkat materializes every stored session before applying
            // SessionQuery. One corrupt historical row therefore makes the
            // complete listing fail, even when it does not belong to this mob
            // member. Continuity is no longer trustworthy, but the project
            // agent can still safely start with a new bridge session. Keep
            // genuine storage failures fatal so disk/permission problems do
            // not masquerade as an intentional fresh start.
            tracing::warn!(
                mob_id,
                role,
                agent_identity,
                corrupted_session_id = %corrupted_session_id,
                "persisted member session listing is corrupt; starting this member with a fresh session"
            );
            return Ok(None);
        }
    };
    let mut newest_match = None;
    for session in sessions {
        // Persisted activity is not a live-owner witness. Native pending
        // attachment settles interrupted tools and predecessor inputs before
        // serving, so retain the original conversation after an abrupt stop.
        let Some(metadata) = session_service
            .load_persisted_session_metadata(&session.session_id)
            .await
            .map_err(|error| {
                format!(
                    "failed to load persisted metadata for member session {}: {error}",
                    session.session_id
                )
            })?
        else {
            // The authoritative metadata seam filters archived sessions. Rows
            // from before typed mob bindings existed intentionally fresh-start.
            continue;
        };
        let Some(binding) = metadata.mob_member_binding() else {
            continue;
        };
        if binding.mob_id != mob_id || binding.role != role || binding.member != agent_identity {
            continue;
        }
        if require_maintenance_tools {
            let tooling = metadata
                .session_metadata
                .as_ref()
                .map(|session_metadata| &session_metadata.tooling);
            let has_maintenance_tools = tooling.is_some_and(|tooling| {
                tooling.schedule == meerkat_core::ToolCategoryOverride::Enable
                    && tooling.workgraph == meerkat_core::ToolCategoryOverride::Enable
            });
            if !has_maintenance_tools {
                tracing::info!(
                    mob_id,
                    role,
                    agent_identity,
                    session_id = %session.session_id,
                    "preserving legacy project-agent session as history and starting a maintenance-capable session"
                );
                continue;
            }
        }
        let replace = newest_match
            .as_ref()
            .is_none_or(|(updated_at, _)| session.updated_at > *updated_at);
        if replace {
            newest_match = Some((session.updated_at, session.session_id));
        }
    }
    Ok(newest_match.map(|(_, session_id)| session_id))
}

enum MemberSessionListing<T> {
    Sessions(T),
    Corrupted(meerkat_core::SessionId),
}

fn classify_member_session_listing<T>(
    result: Result<T, SessionError>,
) -> Result<MemberSessionListing<T>, String> {
    match result {
        Ok(sessions) => Ok(MemberSessionListing::Sessions(sessions)),
        Err(SessionError::Store(source)) => {
            if let Some(SessionStoreError::Corrupted(session_id)) =
                source.downcast_ref::<SessionStoreError>()
            {
                return Ok(MemberSessionListing::Corrupted(session_id.clone()));
            }
            Err(format!(
                "failed to list persisted member sessions: store error: {source}"
            ))
        }
        Err(error) => Err(format!("failed to list persisted member sessions: {error}")),
    }
}

fn definition_toml(input: &CreateMobInput) -> String {
    format!(
        r#"
[mob]
id = "{mob_id}"
orchestrator = "{role}"

[profiles.{role}]
model = "{model}"
runtime_mode = "{runtime_mode}"
external_addressable = true
peer_description = {instructions:?}

[profiles.{role}.tools]
builtins = true
shell = true
comms = true
mob = true
schedule = true
{access_policy}
{workgraph}

[wiring]
auto_wire_orchestrator = false
"#,
        mob_id = escape_toml_string(&input.mob_id),
        role = escape_toml_string(&input.role),
        model = escape_toml_string(&input.model),
        runtime_mode = runtime_mode_toml(&input.kind),
        instructions = input.instructions,
        access_policy = if input.access_mode == Some(crate::native_execution_modes::ExecutionMode::ReadOnly) {
            "read_only = true"
        } else { "" },
        workgraph = if input.kind == "domain" {
            "workgraph = true"
        } else {
            ""
        },
    )
}

fn runtime_mode_for_mob_kind(_kind: &str) -> MobRuntimeMode {
    // Desktop conversations are user/peer-turn driven. AutonomousHost runs an
    // unsolicited kickoff turn at spawn, whose acknowledgement or failure can
    // race and poison the first real user turn.
    MobRuntimeMode::TurnDriven
}

fn console_options_for_mob_kind(kind: &str) -> ConsoleAggregatorOptions {
    ConsoleAggregatorOptions {
        max_concurrent_session_backfills: if kind == "domain" { 1 } else { 16 },
        ..ConsoleAggregatorOptions::default()
    }
}

fn runtime_mode_toml(kind: &str) -> &'static str {
    match runtime_mode_for_mob_kind(kind) {
        MobRuntimeMode::AutonomousHost => "autonomous_host",
        MobRuntimeMode::TurnDriven => "turn_driven",
    }
}

fn escape_toml_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
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

fn member_matches_identity(member: &Value, identity: &str) -> bool {
    [
        "identity",
        "agentIdentity",
        "agent_identity",
        "memberId",
        "member_id",
        "runtimeId",
        "runtime_id",
        "id",
    ]
    .iter()
    .any(|key| member.get(*key).and_then(Value::as_str) == Some(identity))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn persistent_blob_storage_failure_refuses_runtime_bootstrap() {
        let root = std::env::temp_dir().join(format!("meerkat-blob-failure-{}",uuid::Uuid::new_v4()));
        let project = root.join("project");
        let state = root.join("state");
        let mob_root = state.join("mobkit/blob-proof");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&mob_root).unwrap();
        std::fs::write(mob_root.join("blobs"), "not a directory").unwrap();
        let registry = ProjectMobkitRegistry::new(HostToolTransport::new());
        let result = registry.create_local(CreateMobInput {
            mob_id:"blob-proof".into(),kind:"thread".into(),label:"Blob proof".into(),
            role:"ingress".into(),coordinator_identity:"ingress".into(),model:"gpt-5.5".into(), initial_llm: None,
            instructions:"Storage fixture".into(),thread_id:None,include_native_workers:false,access_mode:None,
            config_project_path:project.clone(),project_path:project,state_root:state.clone(),config_state_root:state,
        }).await;
        let error = match result { Ok(_) => panic!("durable runtime must not fall back to memory"),Err(error)=>error };
        assert!(error.contains("persistent MobKit blob store"),"{error}");
        assert!(registry.list().await.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn proposal_read_only_authority_requires_the_exact_process_and_operation() {
        use meerkat_mcp::McpCallContextProvider;
        let selected = McpServerConfig::stdio(
            "project_agent_proposal", "node", vec!["/app/proposal.mjs".into()], HashMap::new(),
        );
        let authority = PureProjectAgentProposal { selected: selected.clone() };
        assert_eq!(authority.tool_mutation_class(&selected, PROJECT_AGENT_PROPOSAL_TOOL),
            meerkat_core::ToolMutationClass::ReadOnly);
        let other_process = McpServerConfig::stdio(
            "project_agent_proposal", "node", vec!["/other/proposal.mjs".into()], HashMap::new(),
        );
        assert_eq!(authority.tool_mutation_class(&other_process, PROJECT_AGENT_PROPOSAL_TOOL),
            meerkat_core::ToolMutationClass::Unknown);
        assert_eq!(authority.tool_mutation_class(&selected, "other_operation"),
            meerkat_core::ToolMutationClass::Unknown);
    }

    const PROPOSAL_MCP_FIXTURE: &str = r#"
import readline from 'node:readline';
const tool = { name: 'ui_project_agent_proposal', description: 'Pure proposal fixture',
  inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } }, additionalProperties: false } };
for await (const line of readline.createInterface({input: process.stdin})) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize') result = {protocolVersion:'2024-11-05', capabilities:{tools:{}}, serverInfo:{name:'proposal-fixture',version:'1'}};
  else if (request.method === 'tools/list') result = {tools:[tool]};
  else if (request.method === 'tools/call') {
    const title = request.params.arguments.title.trim();
    result = title
      ? {content:[{type:'text',text:'Validated proposal fixture'}], structuredContent:{title,fixture:true}, isError:false}
      : {content:[{type:'text',text:'PROPOSAL_VALIDATION_REJECTED'}], isError:true};
  } else result = {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
}
"#;

    #[derive(Default)]
    struct ProposalFixtureLlm {
        calls: std::sync::atomic::AtomicUsize,
    }

    #[async_trait::async_trait]
    impl meerkat::LlmClient for ProposalFixtureLlm {
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
            assert!(
                request
                    .tools
                    .iter()
                    .any(|tool| tool.name.as_str() == PROJECT_AGENT_PROPOSAL_TOOL),
                "proposal tool must exist on the first and restored native turns"
            );
            let phase = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let latest_result = request.messages.iter().rev().find_map(|message| {
                if let meerkat_core::Message::ToolResults { results, .. } = message {
                    results.last()
                } else {
                    None
                }
            });
            if phase == 1 {
                let result = latest_result.expect("invalid proposal reached the model");
                assert!(result.is_error);
                assert!(result
                    .text_content()
                    .contains("PROPOSAL_VALIDATION_REJECTED"), "unexpected proposal result: {result:?}");
            }
            let events = if matches!(phase, 0 | 1 | 3) {
                vec![
                    meerkat::LlmEvent::ToolCallComplete {
                        id: format!("proposal-fixture-{phase}"),
                        name: PROJECT_AGENT_PROPOSAL_TOOL.to_string(),
                        args: json!({"title": if phase == 0 { "" } else { " Normalized proposal " }}),
                        meta: None,
                    },
                    meerkat::LlmEvent::Done {
                        outcome: meerkat::LlmDoneOutcome::Success {
                            stop_reason: meerkat_core::StopReason::ToolUse,
                        },
                    },
                ]
            } else {
                assert!(
                    matches!(phase, 2 | 4),
                    "unexpected model continuation {phase}"
                );
                let result = latest_result.expect("validated proposal reached the model");
                assert!(!result.is_error);
                let content = result.text_content();
                let (summary, structured) = content
                    .split_once('\n')
                    .expect("released MCP appends structured content to the tool text");
                assert_eq!(summary, "Validated proposal fixture");
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(structured).unwrap(),
                    json!({"fixture": true, "title": "Normalized proposal"})
                );
                assert_eq!(
                    result.tool_use_id,
                    format!("proposal-fixture-{}", phase - 1)
                );
                // Review authority is the successful native call ID and its
                // validated arguments; structured content carries the normalized result.
                let transcript = serde_json::to_value(&request.messages).unwrap();
                assert!(transcript.to_string().contains(" Normalized proposal "));
                vec![
                    meerkat::LlmEvent::TextDelta {
                        delta: "Proposal validated.".to_string(),
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

    #[test]
    fn proposal_mcp_is_ready_on_first_and_restored_turns_with_validation_results() {
        std::thread::Builder::new()
            .name("proposal-mcp-proof".to_string())
            .stack_size(32 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .thread_stack_size(16 * 1024 * 1024)
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(async {
                        for access_mode in [
                            crate::native_execution_modes::ExecutionMode::FullAccess,
                            crate::native_execution_modes::ExecutionMode::ReadOnly,
                        ] {
                            proposal_mcp_runtime_proof(access_mode).await;
                        }
                    });
            })
            .unwrap()
            .join()
            .unwrap();
    }

    async fn proposal_mcp_phase<T>(
        access_mode: crate::native_execution_modes::ExecutionMode,
        attempt: &str,
        phase: &str,
        budget: Duration,
        operation: impl std::future::Future<Output = T>,
    ) -> T {
        let started = std::time::Instant::now();
        eprintln!("proposal MCP {access_mode:?} {attempt} {phase}: started");
        let result = tokio::time::timeout(budget, operation)
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "proposal MCP {access_mode:?} {attempt} {phase} timed out after {}s",
                    budget.as_secs()
                )
            });
        eprintln!(
            "proposal MCP {access_mode:?} {attempt} {phase}: completed in {:?}",
            started.elapsed()
        );
        result
    }

    async fn proposal_mcp_runtime_proof(access_mode: crate::native_execution_modes::ExecutionMode) {
        // Let the 45s native bootstrap and 60s shutdown return their own
        // diagnostics before a fixture deadline. Each initial/restored phase
        // gets its own budget; elapsed setup cannot consume teardown's budget.
        let bootstrap_budget = Duration::from_secs(45 + 15);
        let teardown_budget = Duration::from_secs(60 + 15);
        // Connection has separate 15s apply/readiness bounds. Allow additional
        // time for catalog refresh or cleanup of the intentionally wrong server.
        let readiness_budget = Duration::from_secs(60);
        let fixture =
            std::env::temp_dir().join(format!("meerkat-proposal-mcp-{}", uuid::Uuid::new_v4()));
        let project_path = fixture.join("project");
        std::fs::create_dir_all(&project_path).unwrap();
        let server = fixture.join("proposal.mjs");
        std::fs::write(&server, PROPOSAL_MCP_FIXTURE).unwrap();
        let node = std::env::var("MEERKAT_NODE_PATH").unwrap_or_else(|_| "node".to_string());
        let dispatcher = proposal_mcp_phase(
            access_mode,
            "setup",
            "MCP readiness",
            readiness_budget,
            connect_project_agent_proposal_dispatcher(
                node.clone(),
                server.to_string_lossy().to_string(),
            ),
        )
        .await
        .unwrap();
        assert_eq!(dispatcher.tools().len(), 1);
        assert_eq!(dispatcher.tool_mutation_class(PROJECT_AGENT_PROPOSAL_TOOL), meerkat_core::ToolMutationClass::ReadOnly);
        assert_eq!(dispatcher.tool_mutation_class("unrelated_tool"), meerkat_core::ToolMutationClass::Unknown);

        let missing_command_error = proposal_mcp_phase(
            access_mode,
            "setup",
            "missing executable rejection",
            readiness_budget,
            connect_project_agent_proposal_dispatcher(
                fixture
                    .join("missing-node-executable")
                    .to_string_lossy()
                    .to_string(),
                server.to_string_lossy().to_string(),
            ),
        )
        .await
        .err()
        .expect("a missing helper executable must fail connection");
        assert!(
            missing_command_error.starts_with("failed to connect project-agent proposal tool:"),
            "must retain the connection failure instead of claiming an invalid tool catalog: {missing_command_error}"
        );
        assert!(missing_command_error.contains("Failed to spawn process"));

        let wrong_server = fixture.join("unrelated.mjs");
        std::fs::write(
            &wrong_server,
            PROPOSAL_MCP_FIXTURE.replace(PROJECT_AGENT_PROPOSAL_TOOL, "unrelated_tool"),
        )
        .unwrap();
        assert!(
            proposal_mcp_phase(
                access_mode,
                "setup",
                "unrelated catalog rejection",
                readiness_budget,
                connect_project_agent_proposal_dispatcher(
                    node,
                    wrong_server.to_string_lossy().to_string(),
                ),
            )
            .await
            .is_err(),
            "an unrelated MCP server must not establish proposal capability"
        );

        let llm = Arc::new(ProposalFixtureLlm::default());
        let host_tools = HostToolTransport::new();
        let state_root = fixture.join("state");
        let input = CreateMobInput {
            mob_id: format!("proposal-thread-{}", uuid::Uuid::new_v4()),
            kind: "thread".to_string(),
            label: "Proposal proof".to_string(),
            role: "ingress".to_string(),
            coordinator_identity: "ingress".to_string(),
            model: "gpt-5.5".to_string(), initial_llm: None,
            instructions: "Use the pure proposal tool.".to_string(),
            thread_id: None,
            include_native_workers: false,
            access_mode: Some(access_mode),
            config_project_path: project_path.clone(),
            project_path,
            state_root: state_root.clone(),
            config_state_root: state_root,
        };
        let mut prior_session = None;
        let mut prior_peer_endpoint = None;
        for attempt in 0..2 {
            let attempt_name = if attempt == 0 { "initial" } else { "restored" };
            let calls_before_bootstrap = llm.calls.load(std::sync::atomic::Ordering::SeqCst);
            let runtime = proposal_mcp_phase(
                access_mode,
                attempt_name,
                "bootstrap",
                bootstrap_budget,
                bootstrap_local_runtime_with_proposal_dispatcher(
                    input.clone(),
                    Arc::clone(&host_tools),
                    Some(llm.clone()),
                    Some(Arc::clone(&dispatcher)),
                    None,
                ),
            )
            .await
            .unwrap();
            assert_eq!(runtime.access_mode, access_mode);
            let unified = runtime.runtime.as_ref().unwrap();
            assert_eq!(
                llm.calls.load(std::sync::atomic::Ordering::SeqCst),
                calls_before_bootstrap,
                "materializing a restored coordinator must not run a model turn"
            );
            let service = unified.mob_runtime().session_service().unwrap();
            let session = proposal_mcp_phase(
                access_mode,
                attempt_name,
                "member identity and topology",
                Duration::from_secs(15),
                async {
                    let member_id = member_comms_id::mob_member_id("ingress");
                    let session = unified
                        .mob_handle()
                        .resolve_bridge_session_id(&member_id)
                        .await
                        .unwrap();
                    if let Some(prior) = prior_session.as_ref() {
                        assert_eq!(
                            prior, &session,
                            "restore must preserve the canonical member session"
                        );
                    }
                    let comms = SessionServiceCommsExt::comms_runtime(service.as_ref(), &session)
                        .await
                        .expect("the original member must have live comms before any new turn or topology operation");
                    let peer_endpoint = (
                        comms.peer_id().map(|id| id.to_string()),
                        comms.public_key(),
                    );
                    assert!(peer_endpoint.0.is_some() && peer_endpoint.1.is_some());
                    if let Some(prior) = prior_peer_endpoint.as_ref() {
                        assert_eq!(
                            prior, &peer_endpoint,
                            "restore must retain the peer identity and key"
                        );
                    }
                    prior_peer_endpoint = Some(peer_endpoint);
                    drop(comms);
                    let topology_peer = unified
                        .local_member_peer_info("ingress")
                        .await
                        .expect("the original coordinator must be addressable by public cross-mob topology before any new turn");
                    assert_eq!(
                        Some(&topology_peer.0),
                        prior_peer_endpoint.as_ref().and_then(|peer| peer.0.as_ref()),
                        "topology and the restored comms runtime must expose the same peer"
                    );
                    session
                },
            )
            .await;
            prior_session = Some(session);
            proposal_mcp_phase(
                access_mode,
                attempt_name,
                "member turn",
                Duration::from_secs(60),
                async {
                    let started = start_member_turn(
                        unified,
                        "ingress",
                        "Validate a proposal.",
                        meerkat_core::types::HandlingMode::Queue,
                        MemberTurnOptions::new(),
                        None,
                    )
                    .await
                    .unwrap();
                    started.turn.wait().await.unwrap();
                    assert_eq!(
                        llm.calls.load(std::sync::atomic::Ordering::SeqCst),
                        if attempt == 0 { 3 } else { 5 }
                    );
                },
            )
            .await;
            proposal_mcp_phase(
                access_mode,
                attempt_name,
                "teardown",
                teardown_budget,
                async {
                    let registry = ProjectMobkitRegistry::new(Arc::clone(&host_tools));
                    registry
                        .mobs
                        .write()
                        .await
                        .insert(input.mob_id.clone(), Arc::new(runtime));
                    assert!(registry.remove(&input.mob_id).await.unwrap());
                    drop(registry);
                },
            )
            .await;
        }
        drop(dispatcher);
        std::fs::remove_dir_all(fixture).unwrap();
    }
    use meerkat_mob::store::MobEventStore;
    use rusqlite::Connection;

    struct ReadOnlyFixtureLlm {
        calls: std::sync::atomic::AtomicUsize,
        marker: std::path::PathBuf,
    }

    #[async_trait::async_trait]
    impl meerkat::LlmClient for ReadOnlyFixtureLlm {
        fn project_replay_messages(&self, messages: &[meerkat_core::Message]) -> Result<Vec<meerkat_core::Message>, meerkat::LlmError> {
            Ok(messages.to_vec())
        }
        fn stream<'a>(&'a self, request: &'a meerkat::LlmRequest) -> std::pin::Pin<Box<dyn futures_util::Stream<Item = Result<meerkat::LlmEvent, meerkat::LlmError>> + Send + 'a>> {
            let phase = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) % 3;
            let latest = request.messages.iter().rev().find_map(|message| match message {
                meerkat_core::Message::ToolResults { results, .. } => results.last(),
                _ => None,
            });
            let events = match phase {
                0 => {
                    assert!(request.tools.iter().any(|tool| tool.name.as_str() == "workspace_read_file"));
                    vec![meerkat::LlmEvent::ToolCallComplete { id: "read-proof".into(), name: "workspace_read_file".into(), args: json!({"path":"source.txt"}), meta: None },
                         meerkat::LlmEvent::Done { outcome: meerkat::LlmDoneOutcome::Success { stop_reason: meerkat_core::StopReason::ToolUse } }]
                }
                1 => {
                    let result = latest.expect("read result");
                    assert!(!result.is_error, "{}", result.text_content());
                    assert!(result.text_content().contains("native reader composition works"));
                    vec![meerkat::LlmEvent::ToolCallComplete { id: "denied-shell".into(), name: "shell".into(), args: json!({"command":format!("touch '{}'", self.marker.display())}), meta: None },
                         meerkat::LlmEvent::Done { outcome: meerkat::LlmDoneOutcome::Success { stop_reason: meerkat_core::StopReason::ToolUse } }]
                }
                _ => {
                    let result = latest.expect("shell denial");
                    assert!(result.is_error);
                    assert!(result.text_content().contains("access_denied"), "{}", result.text_content());
                    assert!(!self.marker.exists());
                    vec![meerkat::LlmEvent::TextDelta { delta: "Read-only enforcement verified.".into(), meta: None },
                         meerkat::LlmEvent::Done { outcome: meerkat::LlmDoneOutcome::Success { stop_reason: meerkat_core::StopReason::EndTurn } }]
                }
            };
            Box::pin(futures_util::stream::iter(events.into_iter().map(Ok)))
        }
        fn provider(&self) -> meerkat_core::Provider { meerkat_core::Provider::Other }
        async fn health_check(&self) -> Result<(), meerkat::LlmError> { Ok(()) }
    }

    #[test]
    fn read_only_mob_enforces_tools_after_restart_with_omitted_access_preference() {
        for kind in ["sub", "domain"] {
        std::thread::Builder::new().name("read-only-mob-proof".into()).stack_size(32 * 1024 * 1024).spawn(move || {
            tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_stack_size(16 * 1024 * 1024).enable_all().build().unwrap().block_on(async {
                let fixture = std::env::temp_dir().join(format!("meerkat-read-only-mob-{}", uuid::Uuid::new_v4()));
                let project = fixture.join("project");
                std::fs::create_dir_all(&project).unwrap();
                std::fs::write(project.join("source.txt"), "native reader composition works").unwrap();
                let marker = project.join("must-not-exist");
                let llm = Arc::new(ReadOnlyFixtureLlm { calls: Default::default(), marker: marker.clone() });
                let host = HostToolTransport::new();
                let mut input = CreateMobInput {
                    mob_id: "readonly-proof".into(), kind: kind.into(), label: "Read-only proof".into(), role: "ingress".into(),
                    coordinator_identity: "ingress".into(), model: "gpt-5.5".into(), initial_llm: None, instructions: "Inspect repository files.".into(),
                    thread_id: None, include_native_workers: false, access_mode: Some(crate::native_execution_modes::ExecutionMode::ReadOnly),
                    config_project_path: project.clone(), project_path: project, state_root: fixture.join("state"), config_state_root: fixture.join("state"),
                };
                let mut saved_session = None;
                for _ in 0..2 {
                    let runtime = bootstrap_local_runtime_with_proposal_dispatcher(input.clone(), host.clone(), Some(llm.clone()), None, None).await.unwrap();
                    assert_eq!(runtime.access_mode, crate::native_execution_modes::ExecutionMode::ReadOnly);
                    let unified = runtime.runtime.as_ref().unwrap();
                    let session = unified.mob_handle().resolve_bridge_session_id(&member_comms_id::mob_member_id("ingress")).await.unwrap();
                    if let Some(previous) = &saved_session { assert_eq!(&session, previous); }
                    saved_session = Some(session);
                    let started = start_member_turn(unified, "ingress", "Read the source, then attempt the denied mutation.", meerkat_core::types::HandlingMode::Queue, MemberTurnOptions::new(), None).await.unwrap();
                    started.turn.wait().await.unwrap();
                    assert!(!marker.exists());
                    let registry = ProjectMobkitRegistry::new(host.clone());
                    registry.mobs.write().await.insert(input.mob_id.clone(), Arc::new(runtime));
                    assert!(registry.remove(&input.mob_id).await.unwrap());
                    input.access_mode = None;
                }
                assert_eq!(llm.calls.load(std::sync::atomic::Ordering::SeqCst), 6);
                std::fs::remove_dir_all(fixture).unwrap();
            });
        }).unwrap().join().unwrap();
        }
    }

    #[tokio::test]
    async fn realm_config_normalizes_legacy_fallback_but_rejects_new_invalid_policy() {
        let fixture = std::env::temp_dir().join(format!(
            "meerkat-realm-fallback-policy-{}",
            uuid::Uuid::new_v4()
        ));
        let project_path = fixture.join("project");
        let state_root = fixture.join("state");
        let global_path = realm_global_config_path(&state_root);
        std::fs::create_dir_all(global_path.parent().expect("global parent"))
            .expect("create global fixture");
        let global_document = "[model_fallback]\nenabled = true\n\n[realm.global]\n";
        std::fs::write(&global_path, global_document).expect("write legacy global policy");
        let realm_id = derive_workspace_realm_id(&project_path);
        let head_path = state_root.join(&realm_id).join("config.toml");
        std::fs::create_dir_all(head_path.parent().expect("realm parent"))
            .expect("create realm fixture");
        let head_document = format!("[realm.{realm_id}]\nparent = \"global\"\n");
        std::fs::write(&head_path, &head_document).expect("write explicit global inheritance");

        let inherited = load_effective_realm_config(&project_path, &state_root)
            .await
            .expect("native persisted-config migration must load the legacy default");
        assert!(!inherited.effective.model_fallback.is_enabled());
        assert!(inherited.effective.model_fallback.chain.is_empty());
        let (_, warnings) = EffectiveConfigReader::new(inherited.source.clone())
            .effective_config_over_head_with_warnings(
                &inherited.realm_id,
                inherited.raw_head.clone(),
            )
            .await
            .expect("read canonical migration warnings");
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].realm, RealmId::global());
        assert_eq!(
            warnings[0].warning,
            meerkat_core::config::ConfigWarning::LegacyModelFallbackDefault,
        );
        // Only persisted legacy documents are normalized. A new explicit
        // enabled policy still needs a reviewed chain at the native write gate.
        let mut invalid_candidate = inherited.raw_head.clone();
        invalid_candidate.model_fallback.enabled = Some(true);
        let error = inherited.head_store.set(invalid_candidate).await
            .expect_err("a newly authored fallback policy needs an explicit chain");
        assert!(
            error.to_string().contains("requires a nonempty explicit chain"),
            "{error}"
        );
        assert_eq!(std::fs::read_to_string(&head_path).unwrap(), head_document);

        std::fs::write(
            &head_path,
            format!("{head_document}\n[model_fallback]\nenabled = false\n"),
        )
        .expect("write explicit realm policy");
        let configured = load_effective_realm_config(&project_path, &state_root)
            .await
            .expect("explicit realm override must compose");
        assert_eq!(configured.effective.model_fallback.enabled, Some(false));
        assert!(configured.effective.model_fallback.chain.is_empty());
        assert_eq!(
            std::fs::read_to_string(&global_path).expect("read global policy"),
            global_document,
            "composition must preserve inherited policy at its source"
        );
        std::fs::remove_dir_all(&fixture).expect("remove fallback fixture");
    }

    #[test]
    fn flow_guidance_requires_the_connected_dispatchers_complete_tool_set() {
        let names = [
            "spawn_flow",
            "flow_status",
            "send_to_flow_member",
            "collect_flow_job",
            "retire_flow",
        ];
        let tools: Vec<_> = names
            .iter()
            .map(|name| {
                Arc::new(meerkat_core::types::ToolDef {
                    name: (*name).into(),
                    description: String::new(),
                    input_schema: json!({"type": "object"}),
                    provenance: None,
                    audience: Default::default(),
                })
            })
            .collect();
        assert!(desktop_flow_instructions(Some("thread-1"), &[]).is_none());
        assert!(desktop_flow_instructions(None, &tools).is_none());
        for missing in 0..tools.len() {
            let partial = tools
                .iter()
                .enumerate()
                .filter(|(index, _)| *index != missing)
                .map(|(_, tool)| Arc::clone(tool))
                .collect::<Vec<_>>();
            assert!(desktop_flow_instructions(Some("thread-1"), &partial).is_none());
        }
        let instructions = desktop_flow_instructions(Some("thread-1"), &tools).unwrap();
        for name in names {
            assert!(instructions.contains(&format!("`{name}`")));
        }
        assert!(instructions.contains("`thread-1`"));
    }

    #[test]
    fn background_domain_history_recovery_has_bounded_concurrency() {
        let domain = console_options_for_mob_kind("domain");
        assert!(domain.session_history_backfill_enabled);
        assert_eq!(domain.max_concurrent_session_backfills, 1);

        let thread = console_options_for_mob_kind("thread");
        assert!(thread.session_history_backfill_enabled);
    }

    #[tokio::test]
    async fn local_bootstrap_singleflight_is_scoped_by_mob_identity() {
        let registry = ProjectMobkitRegistry::new(HostToolTransport::new());
        let first = {
            let mut locks = registry.local_bootstrap_locks.lock().await;
            Arc::clone(
                locks
                    .entry("thread-a".to_string())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let same = {
            let mut locks = registry.local_bootstrap_locks.lock().await;
            Arc::clone(
                locks
                    .entry("thread-a".to_string())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let different = {
            let mut locks = registry.local_bootstrap_locks.lock().await;
            Arc::clone(
                locks
                    .entry("thread-b".to_string())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };

        assert!(Arc::ptr_eq(&first, &same));
        assert!(!Arc::ptr_eq(&first, &different));
    }

    #[test]
    fn legacy_mob_event_envelopes_migrate_atomically_with_backup() {
        let fixture = std::env::temp_dir().join(format!(
            "meerkat-mob-event-v8-migration-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&fixture).expect("create fixture");
        let mob_db_path = fixture.join("mob.sqlite");
        let connection = Connection::open(&mob_db_path).expect("open fixture database");
        connection
            .execute_batch(
                "CREATE TABLE mob_events (
                    cursor INTEGER PRIMARY KEY,
                    mob_id TEXT,
                    event_json BLOB NOT NULL
                );",
            )
            .expect("create event table");
        let event = serde_json::json!({
            "cursor": 1,
            "timestamp": "2026-07-26T10:00:00Z",
            "mob_id": "migration-fixture",
            "kind": {
                "type": "mob_completed"
            }
        });
        let v8 = serde_json::to_vec(&serde_json::json!({
            "schema_version": 8,
            "event": event,
        }))
        .expect("encode v8 event");
        let v9 = serde_json::to_vec(&serde_json::json!({
            "schema_version": 9,
            "event": {
                "cursor": 2,
                "timestamp": "2026-07-26T10:00:01Z",
                "mob_id": "migration-fixture",
                "kind": {
                    "type": "mob_completed"
                }
            },
        }))
        .expect("encode v9 event");
        connection
            .execute(
                "INSERT INTO mob_events (cursor, mob_id, event_json) VALUES (?1, ?2, ?3)",
                rusqlite::params![1_i64, "migration-fixture", v8],
            )
            .expect("insert v8 event");
        connection
            .execute(
                "INSERT INTO mob_events (cursor, mob_id, event_json) VALUES (?1, ?2, ?3)",
                rusqlite::params![2_i64, "migration-fixture", v9.clone()],
            )
            .expect("insert v9 event");
        drop(connection);

        assert_eq!(
            migrate_stored_mob_events_v8_to_v9(&mob_db_path).expect("migrate"),
            1
        );
        let backup_path = fixture.join("mob.sqlite.pre-event-v9.backup");
        assert!(
            backup_path.is_file(),
            "migration must leave a recovery copy"
        );

        let migrated = Connection::open(&mob_db_path).expect("reopen migrated database");
        let versions: Vec<u64> = migrated
            .prepare("SELECT event_json FROM mob_events ORDER BY cursor")
            .expect("prepare migrated query")
            .query_map([], |row| row.get::<_, Vec<u8>>(0))
            .expect("query migrated rows")
            .map(|row| {
                let bytes = row.expect("read migrated event");
                serde_json::from_slice::<serde_json::Value>(&bytes).expect("parse migrated event")
                    ["schema_version"]
                    .as_u64()
                    .expect("numeric migrated version")
            })
            .collect();
        assert_eq!(versions, vec![9, 9]);
        let untouched_v9: Vec<u8> = migrated
            .query_row(
                "SELECT event_json FROM mob_events WHERE cursor = 2",
                [],
                |row| row.get(0),
            )
            .expect("read untouched v9 event");
        assert_eq!(untouched_v9, v9, "current events must remain byte-for-byte");
        drop(migrated);

        let backup = Connection::open(backup_path).expect("open migration backup");
        let backup_version: u64 = serde_json::from_slice::<serde_json::Value>(
            &backup
                .query_row(
                    "SELECT event_json FROM mob_events WHERE cursor = 1",
                    [],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .expect("read backup event"),
        )
        .expect("parse backup event")["schema_version"]
            .as_u64()
            .expect("backup schema version");
        assert_eq!(backup_version, 8);
        drop(backup);

        assert_eq!(
            migrate_stored_mob_events_v8_to_v9(&mob_db_path).expect("idempotent migration"),
            0
        );
        let _ = std::fs::remove_dir_all(&fixture);
    }

    #[test]
    fn peer_send_receipts_preserve_typed_delivery_outcomes() {
        let envelope_id = uuid::Uuid::new_v4();
        let handed_off = send_receipt_to_json(SendReceipt::PeerMessageSent {
            envelope_id,
            delivery: PeerDeliveryOutcome::VolatileHandedOff,
        });
        assert_eq!(handed_off["kind"], "peer_message_sent");
        assert_eq!(handed_off["envelopeId"], envelope_id.to_string());
        assert_eq!(handed_off["delivery"], "volatile_handed_off");
        assert_eq!(handed_off["deliveryOutcome"], "volatile_handed_off");
        assert_eq!(handed_off["acked"], false);

        let acked = send_receipt_to_json(SendReceipt::PeerMessageSent {
            envelope_id,
            delivery: PeerDeliveryOutcome::Acked,
        });
        assert_eq!(acked["delivery"], "acked");
        assert_eq!(acked["acked"], true);

        for outcome in [
            meerkat_core::interaction::PeerIngressTerminalOutcomeKind::Accepted,
            meerkat_core::interaction::PeerIngressTerminalOutcomeKind::Deduplicated,
            meerkat_core::interaction::PeerIngressTerminalOutcomeKind::Rejected,
        ] {
            let delivery = PeerDeliveryOutcome::DurablyResolved { outcome };
            let message = send_receipt_to_json(SendReceipt::PeerMessageSent {
                envelope_id,
                delivery,
            });
            assert_eq!(message["delivery"], "durably_resolved");
            assert_eq!(
                message["deliveryOutcome"]["durably_resolved"]["outcome"],
                json!(outcome)
            );
            assert_eq!(message["acked"], false);
            let lifecycle = send_receipt_to_json(SendReceipt::PeerLifecycleSent {
                envelope_id,
                delivery,
            });
            assert_eq!(lifecycle["deliveryOutcome"], json!(delivery));
        }
    }

    #[test]
    fn corrupt_member_session_listing_fresh_starts_without_hiding_store_failures() {
        let corrupted_session_id = meerkat_core::SessionId::new();
        let classification = classify_member_session_listing::<Vec<()>>(Err(SessionError::Store(
            Box::new(SessionStoreError::Corrupted(corrupted_session_id.clone())),
        )))
        .expect("corrupt history should be recoverable");

        match classification {
            MemberSessionListing::Corrupted(actual) => {
                assert_eq!(actual, corrupted_session_id);
            }
            MemberSessionListing::Sessions(_) => {
                panic!("corrupt history must not be treated as a valid session listing");
            }
        }

        let fatal = classify_member_session_listing::<Vec<()>>(Err(SessionError::Store(Box::new(
            SessionStoreError::Io(std::io::Error::other("session database unavailable")),
        ))))
        .err()
        .expect("I/O failures must remain fatal");
        assert!(fatal.contains("session database unavailable"));
    }

    fn seed_legacy_creation_event(path: &std::path::Path, definition: &MobDefinition) {
        // This historical fixture predates sealed native event constructors.
        // Only tests write the stored wire format; production uses MobKit's CAS.
        let stored = json!({
            "schema_version": 9,
            "event": {
                "cursor": 1,
                "timestamp": "2026-07-26T10:00:00Z",
                "mob_id": definition.id,
                "kind": {
                    "type": "mob_created",
                    "definition": definition,
                },
            },
        });
        let mut connection = Connection::open(path).expect("open historical event fixture");
        let transaction = connection.transaction().expect("begin historical fixture");
        transaction
            .execute(
                "INSERT INTO mob_events (cursor, mob_id, event_json) VALUES (1, ?1, ?2)",
                rusqlite::params![definition.id.as_str(), serde_json::to_vec(&stored).unwrap()],
            )
            .expect("write historical creation");
        transaction
            .execute(
                "INSERT OR REPLACE INTO mob_event_meta (key, value) VALUES ('next_cursor', 2)",
                [],
            )
            .expect("write historical cursor");
        transaction.commit().expect("commit historical fixture");
    }

    fn legacy_definition(input: &CreateMobInput) -> MobDefinition {
        let mut definition =
            MobDefinition::from_toml(&definition_toml(input)).expect("parse legacy definition");
        for profile in definition
            .profiles
            .values_mut()
            .filter_map(|binding| binding.as_inline_mut())
        {
            profile.runtime_mode = MobRuntimeMode::AutonomousHost;
            profile.tools.workgraph = false;
        }
        definition
    }

    #[tokio::test]
    async fn persisted_domain_definition_receives_only_maintenance_tool_migration() {
        let fixture = std::env::temp_dir().join(format!(
            "meerkat-durable-mob-definition-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&fixture).expect("create fixture");
        let mob_db_path = fixture.join("mob.sqlite");
        let original = CreateMobInput {
            mob_id: "domain-runtime".to_string(),
            kind: "domain".to_string(),
            label: "Runtime Steward".to_string(),
            role: "domain".to_string(),
            coordinator_identity: "runtime-steward".to_string(),
            model: "gpt-5.5".to_string(), initial_llm: None,
            instructions: "Original durable project charter.".to_string(),
            thread_id: None,
            include_native_workers: false,
            access_mode: None,
            config_project_path: fixture.clone(),
            project_path: fixture.clone(),
            state_root: fixture.clone(),
            config_state_root: fixture.clone(),
        };
        let original_definition = legacy_definition(&original);
        let stores = SqliteMobStores::open(&mob_db_path).expect("open spec store");
        seed_legacy_creation_event(&mob_db_path, &original_definition);
        stores
            .spec_store()
            .put_spec(
                &MobId::from(original.mob_id.as_str()),
                &original_definition,
                None,
            )
            .await
            .expect("persist original definition");

        let changed = CreateMobInput {
            role: "runtime-steward".to_string(),
            model: "gpt-5.4".to_string(),
            instructions: "A lossy or newer registration prompt.".to_string(),
            ..original
        };
        let restored = durable_mob_definition(&changed, &mob_db_path)
            .await
            .expect("restore durable definition");

        let orchestrator_profile = restored
            .orchestrator
            .as_ref()
            .expect("persisted orchestrator")
            .profile
            .clone();
        assert_eq!(orchestrator_profile.as_str(), "domain");
        let profile = restored
            .profiles
            .get(&orchestrator_profile)
            .and_then(|binding| binding.as_inline())
            .expect("persisted inline profile");
        assert_eq!(profile.model, "gpt-5.5");
        assert_eq!(
            profile.peer_description,
            "Original durable project charter."
        );
        assert_eq!(profile.runtime_mode, MobRuntimeMode::AutonomousHost);
        assert!(profile.tools.schedule);
        assert!(profile.tools.workgraph);

        let (stored_after_restore, revision) = stores
            .spec_store()
            .get_spec(&MobId::from(changed.mob_id.as_str()))
            .await
            .expect("reload persisted definition")
            .expect("persisted definition exists");
        assert_eq!(stored_after_restore, restored);
        assert_eq!(
            revision, 2,
            "maintenance capability migration must be one durable CAS update"
        );
        let _ = std::fs::remove_dir_all(&fixture);
    }

    #[test]
    fn persistent_runtime_store_failure_aborts_mob_bootstrap() {
        std::thread::Builder::new()
            .name("durable-runtime-bootstrap-test".to_string())
            .stack_size(32 * 1024 * 1024)
            .spawn(|| {
                let test_runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .thread_stack_size(16 * 1024 * 1024)
                    .enable_all()
                    .build()
                    .expect("build test runtime");
                test_runtime.block_on(async {
                    let fixture = std::env::temp_dir().join(format!(
                        "meerkat-durable-runtime-bootstrap-{}",
                        uuid::Uuid::new_v4()
                    ));
                    let project_path = fixture.join("project");
                    let state_root = fixture.join("state");
                    let runtime_db = state_root.join("mobkit/thread-runtime/runtime.sqlite");
                    std::fs::create_dir_all(&project_path).expect("create project fixture");
                    std::fs::create_dir_all(runtime_db.parent().unwrap())
                        .expect("create mob fixture");
                    let corrupt = b"invalid sqlite state must not be silently replaced";
                    std::fs::write(&runtime_db, corrupt).expect("write corrupt runtime fixture");
                    let result = bootstrap_local_runtime(
                        CreateMobInput {
                            mob_id: "thread-runtime".to_string(),
                            kind: "thread".to_string(),
                            label: "Runtime persistence proof".to_string(),
                            role: "ingress".to_string(),
                            coordinator_identity: "ingress".to_string(),
                            model: "gpt-5.5".to_string(), initial_llm: None,
                            instructions: "Never discard durable runtime authority.".to_string(),
                            thread_id: None,
                            include_native_workers: false,
            access_mode: None,
                            config_project_path: project_path.clone(),
                            project_path,
                            state_root: state_root.clone(),
                            config_state_root: state_root,
                        },
                        HostToolTransport::new(),
                    )
                    .await;
                    let error = match result {
                        Err(error) => error,
                        Ok(_) => panic!("corrupt runtime storage must refuse mob bootstrap"),
                    };
                    assert!(
                        error.contains("Cannot upgrade saved conversation storage")
                            && error.contains("file is not a database"),
                        "{error}"
                    );
                    assert!(error.contains(runtime_db.to_str().unwrap()), "{error}");
                    assert_eq!(std::fs::read(&runtime_db).unwrap(), corrupt);
                    let _ = std::fs::remove_dir_all(fixture);
                });
            })
            .expect("spawn persistence test thread")
            .join()
            .expect("persistence test thread");
    }

    #[test]
    fn legacy_autonomous_spec_bootstraps_with_turn_driven_member_projection() {
        std::thread::Builder::new()
            .name("legacy-mob-bootstrap-test".to_string())
            .stack_size(32 * 1024 * 1024)
            .spawn(|| {
                let test_runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .thread_stack_size(16 * 1024 * 1024)
                    .enable_all()
                    .build()
                    .expect("build test runtime");
                test_runtime.block_on(assert_legacy_autonomous_spec_bootstrap());
            })
            .expect("spawn bootstrap test thread")
            .join()
            .expect("bootstrap test thread");
    }

    async fn assert_legacy_autonomous_spec_bootstrap() {
        let fixture = std::env::temp_dir().join(format!(
            "meerkat-legacy-autonomous-bootstrap-{}",
            uuid::Uuid::new_v4()
        ));
        let project_path = fixture.join("project");
        let state_root = fixture.join("state");
        std::fs::create_dir_all(&project_path).expect("create project fixture");

        let original = CreateMobInput {
            mob_id: "domain-runtime".to_string(),
            kind: "domain".to_string(),
            label: "Runtime Steward".to_string(),
            role: "domain".to_string(),
            coordinator_identity: "runtime-steward".to_string(),
            model: "gpt-5.5".to_string(), initial_llm: None,
            instructions: "Original durable project charter.".to_string(),
            thread_id: None,
            include_native_workers: false,
            access_mode: None,
            config_project_path: project_path.clone(),
            project_path: project_path.clone(),
            state_root: state_root.clone(),
            config_state_root: state_root.clone(),
        };
        let original_definition = legacy_definition(&original);
        let mob_root = state_root
            .join("mobkit")
            .join(stable_slug(&original.mob_id));
        std::fs::create_dir_all(&mob_root).expect("create legacy mob root");
        let mob_db_path = mob_root.join("mob.sqlite");
        let stores = SqliteMobStores::open(&mob_db_path).expect("open legacy spec store");
        seed_legacy_creation_event(&mob_db_path, &original_definition);
        stores
            .spec_store()
            .put_spec(
                &MobId::from(original.mob_id.as_str()),
                &original_definition,
                None,
            )
            .await
            .expect("persist legacy autonomous definition");
        drop(stores);

        // Simulate a lossy app projection on restart. The durable profile is
        // still the authority for role/model/charter, while the desktop spawn
        // policy must prevent the legacy autonomous kickoff.
        let restarted = CreateMobInput {
            role: "runtime-steward".to_string(),
            model: "gpt-5.4".to_string(),
            instructions: "A newer registration prompt that must not win.".to_string(),
            ..original
        };
        let host_tools = HostToolTransport::new();
        let runtime = bootstrap_local_runtime(restarted, Arc::clone(&host_tools))
            .await
            .expect("bootstrap legacy persisted mob");
        let unified = runtime.runtime.as_ref().expect("local unified runtime");

        let status = mobkit_rpc(unified, "mobkit/status", json!({})).await
            .expect("legacy app RPC reaches the released Meta dispatcher");
        assert!(status.get("contract_version").is_some());
        let native_status = mobkit_rpc(unified, "meta/status", json!({})).await
            .expect("native Meta RPC remains available");
        assert_eq!(status["contract_version"], native_status["contract_version"]);

        let members = list_members(unified).await;
        assert_eq!(members.len(), 1);
        assert_eq!(
            members[0].get("agent_identity").and_then(Value::as_str),
            Some("runtime-steward")
        );
        assert_eq!(
            members[0].get("role").and_then(Value::as_str),
            Some("domain")
        );
        assert_eq!(
            members[0].get("runtime_mode").and_then(Value::as_str),
            Some("turn_driven")
        );
        assert!(
            members[0].get("kickoff").is_none(),
            "turn-driven member must not expose autonomous kickoff state"
        );

        let stores = SqliteMobStores::open(&mob_db_path).expect("reopen bootstrapped mob store");
        let (stored_after_bootstrap, revision) = stores
            .spec_store()
            .get_spec(&MobId::from("domain-runtime"))
            .await
            .expect("load durable definition after bootstrap")
            .expect("durable definition after bootstrap");
        let mut migrated_definition = original_definition.clone();
        assert!(enable_domain_maintenance_tools(&mut migrated_definition));
        assert_eq!(stored_after_bootstrap, migrated_definition);
        assert_eq!(
            revision, 2,
            "bootstrap must record the maintenance capability migration once"
        );

        let events = stores
            .event_store()
            .replay_all()
            .await
            .expect("replay bootstrapped mob events");
        let created_definition = events
            .iter()
            .rev()
            .find_map(|event| match &event.kind {
                meerkat_mob::MobEventKind::MobCreated { definition } => Some(definition.as_ref()),
                _ => None,
            })
            .expect("MobCreated event");
        assert_eq!(created_definition, &original_definition);
        let updates = events
            .iter()
            .filter_map(|event| match &event.kind {
                meerkat_mob::MobEventKind::MobDefinitionUpdated { epoch, definition } => {
                    Some((*epoch, definition.as_ref()))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(updates, vec![(2, &migrated_definition)]);
        let spawned_mode = events.iter().rev().find_map(|event| match &event.kind {
            meerkat_mob::MobEventKind::MemberSpawned(member) => Some(member.runtime_mode),
            _ => None,
        });
        assert_eq!(spawned_mode, Some(MobRuntimeMode::TurnDriven));
        assert!(
            !events.iter().any(|event| matches!(
                event.kind,
                meerkat_mob::MobEventKind::MemberKickoffUpdated { .. }
            )),
            "turn-driven bootstrap must not emit autonomous kickoff events"
        );

        let member_id = member_comms_id::mob_member_id("runtime-steward");
        let first_session_id = unified
            .mob_handle()
            .resolve_bridge_session_id(&member_id)
            .await
            .expect("first durable bridge session");
        let _ = unified.shutdown().await;
        drop(runtime);
        drop(stores);

        let resumed_runtime = bootstrap_local_runtime(
            CreateMobInput {
                mob_id: "domain-runtime".to_string(),
                kind: "domain".to_string(),
                label: "Runtime Steward".to_string(),
                role: "runtime-steward".to_string(),
                coordinator_identity: "runtime-steward".to_string(),
                model: "gpt-5.4".to_string(), initial_llm: None,
                instructions: "Another lossy restart prompt that must not win.".to_string(),
                thread_id: None,
                include_native_workers: false,
            access_mode: None,
                config_project_path: project_path.clone(),
                project_path,
                state_root: state_root.clone(),
                config_state_root: state_root.clone(),
            },
            host_tools,
        )
        .await
        .expect("restart persisted desktop mob");
        let resumed_unified = resumed_runtime
            .runtime
            .as_ref()
            .expect("resumed local unified runtime");
        let resumed_session_id = resumed_unified
            .mob_handle()
            .resolve_bridge_session_id(&member_id)
            .await
            .expect("resumed durable bridge session");
        assert_eq!(
            resumed_session_id, first_session_id,
            "desktop restart must adopt the prior member session instead of losing context"
        );
        let durable_sessions = resumed_unified
            .mob_runtime()
            .session_service()
            .expect("runtime-owned session catalog")
            .list(SessionQuery::default())
            .await
            .expect("list durable member sessions");
        assert_eq!(
            durable_sessions.len(),
            1,
            "restart must not mint a second bridge session for the same member"
        );
        assert_eq!(durable_sessions[0].session_id, resumed_session_id);
        let storage = MobStorage::persistent(&mob_db_path).expect("open resumed definition store");
        let snapshot = storage
            .created_definition_snapshot()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.epoch(), 2, "restart must not repeat the migration");
        assert_eq!(snapshot.definition(), &migrated_definition);
        assert!(matches!(
            storage.definition_projection_health().await.unwrap(),
            Some(meerkat_mob::MobDefinitionProjectionHealth::Healthy {
                authority_epoch: 2,
                projection_revision: 2
            })
        ));
        let _ = resumed_unified.shutdown().await;
        drop(resumed_runtime);
        let _ = std::fs::remove_dir_all(&fixture);
    }
}

#[cfg(test)]
#[path = "thread_dispose/registry_tests.rs"]
mod disposal_admission_tests;
