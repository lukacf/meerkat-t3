//! Submission correspondence and explicit cleanup, never a replacement for native terminal truth.
use crate::{GatewayError, MeerkatGateway, object_params, required_nonempty_string};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

static OWNER: LazyLock<String> = LazyLock::new(|| uuid::Uuid::new_v4().to_string());
#[derive(Default)]
struct Ownership {
    locks: HashMap<PathBuf, File>,
    gateways: HashMap<PathBuf, String>,
    recovering: HashSet<PathBuf>,
}
static OWNERSHIP: LazyLock<Mutex<Ownership>> = LazyLock::new(|| Mutex::new(Ownership::default()));

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Submission {
    version: u8,
    pub run_id: String,
    pub thread_id: String,
    pub mob_id: String,
    pub agent_identity: String,
    fingerprint: String,
    owner: String,
    pub status: String,
    pub native_session_id: Option<String>,
    pub native_receipt: Option<Value>,
    /// Construction provenance, not proof of process cessation or completion.
    /// Older builds did not put native tools in durable custody.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_custody_version: Option<u8>,
    /// Recovery began before dispatch was durably attempted. Retain that
    /// witness across cleanup errors or another process death.
    #[serde(default)]
    recovery_before_dispatch: bool,
}
impl Submission {
    pub(crate) fn owner(&self) -> &str {
        &self.owner
    }

    pub(crate) fn supports_native_recovery(&self) -> bool {
        cfg!(any(target_os = "linux", target_os = "macos"))
            && self.native_custody_version == Some(1)
            && self.native_session_id.is_some()
    }

    pub(crate) fn may_have_dispatched(&self) -> bool {
        ["dispatching", "admitted"].contains(&self.status.as_str())
            || (self.status == "recovering" && !self.recovery_before_dispatch)
    }

    fn begin_recovery(&mut self) {
        self.recovery_before_dispatch |= self.status == "submitted";
        self.status = "recovering".into();
    }
}
fn error(cause: impl std::fmt::Display) -> GatewayError {
    GatewayError::policy(
        "Thread recovery needs attention",
        Some(json!({"kind":"thread_recovery","error":cause.to_string()})),
    )
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn record_path(root: &Path, run: &str) -> PathBuf {
    root.join("thread-recovery")
        .join(format!("{}.json", digest(run)))
}
fn lock_path(root: &Path, mob: &str) -> PathBuf {
    root.join("thread-recovery")
        .join(format!("{}.owner", digest(mob)))
}
fn write(root: &Path, value: &Submission) -> Result<(), GatewayError> {
    let target = record_path(root, &value.run_id);
    let directory = target.parent().unwrap();
    std::fs::create_dir_all(directory).map_err(error)?;
    let temporary = directory.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), GatewayError> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(error)?;
        file.write_all(&serde_json::to_vec(value).map_err(error)?)
            .map_err(error)?;
        file.sync_all().map_err(error)?;
        std::fs::rename(&temporary, &target).map_err(error)?;
        File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(error)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}
pub(crate) fn read(root: &Path, run: &str) -> Result<Option<Submission>, GatewayError> {
    let bytes = match std::fs::read(record_path(root, run)) {
        Ok(bytes) => bytes,
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(cause) => return Err(error(cause)),
    };
    let record: Submission = serde_json::from_slice(&bytes).map_err(error)?;
    if record.version != 1 || record.run_id != run {
        return Err(error("submission identity mismatch"));
    }
    Ok(Some(record))
}

/// Freeze recovery to its original native conversation before any bootstrap
/// can choose a fresh member session. This journal owns correspondence only;
/// the native metadata owner still validates whether that session can resume.
pub(crate) fn recovering_session(
    root: &Path,
    mob: &str,
    member: &str,
) -> Result<Option<meerkat_core::SessionId>, String> {
    let entries = match std::fs::read_dir(root.join("thread-recovery")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut original = None;
    for entry in entries {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let record: Submission = serde_json::from_slice(
            &std::fs::read(path).map_err(|error| error.to_string())?,
        ).map_err(|error| error.to_string())?;
        if record.mob_id != mob || record.status != "recovering" {
            continue;
        }
        if record.agent_identity != member || !record.supports_native_recovery() {
            return Err("The recovering operation has no matching native session binding".into());
        }
        let session = meerkat_core::SessionId::parse(
            record.native_session_id.as_deref().expect("validated recovery session"),
        ).map_err(|error| error.to_string())?;
        if original.replace(session).is_some() {
            return Err("More than one interrupted operation requires recovery for this thread".into());
        }
    }
    Ok(original)
}
pub(crate) fn gateway_owner(gateway: &MeerkatGateway) -> String {
    format!(
        "{}:{:p}:{}",
        &*OWNER,
        std::sync::Arc::as_ptr(&gateway.inner),
        gateway.inner.booted_at
    )
}
fn acquire(
    owner: &mut Ownership,
    root: &Path,
    mob: &str,
    gateway: &str,
) -> Result<PathBuf, GatewayError> {
    let path = lock_path(root, mob);
    std::fs::create_dir_all(path.parent().unwrap()).map_err(error)?;
    let path = path
        .parent()
        .unwrap()
        .canonicalize()
        .map_err(error)?
        .join(path.file_name().unwrap());
    if owner
        .gateways
        .get(&path)
        .is_some_and(|current| current != gateway)
    {
        return Err(error(
            "Another gateway in this process still owns the thread. Reconnect to that gateway before recovery.",
        ));
    }
    if !owner.locks.contains_key(&path) {
        std::fs::create_dir_all(path.parent().unwrap()).map_err(error)?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(error)?;
        file.try_lock().map_err(|_| {
            error("Another gateway still owns this thread. Reconnect to it before recovery.")
        })?;
        // Held until this process exits. Mere absence from an app run map never proves quiescence.
        owner.locks.insert(path.clone(), file);
        owner.gateways.insert(path.clone(), gateway.to_string());
    }
    Ok(path)
}
pub(crate) fn reserve(
    root: &Path,
    params: &serde_json::Map<String, Value>,
    run: &str,
    gateway: &str,
) -> Result<(), GatewayError> {
    let thread = required_nonempty_string(params, "threadId")?;
    let mob = required_nonempty_string(params, "mobId")?;
    let agent = params
        .get("agentIdentity")
        .and_then(Value::as_str)
        .unwrap_or("ingress");
    let fingerprint = digest(&serde_json::to_string(params).map_err(error)?);
    let mut owner = OWNERSHIP.lock().map_err(error)?;
    let key = acquire(&mut owner, root, &mob, gateway)?;
    if owner.recovering.contains(&key) {
        return Err(error("Thread cleanup is in progress"));
    }
    if let Some(existing) = read(root, run)? {
        let reason = if existing.thread_id != thread
            || existing.mob_id != mob
            || existing.agent_identity != agent
            || existing.fingerprint != fingerprint
        {
            "This operation ID already belongs to a different submission"
        } else {
            "This operation was already recorded. Reconcile its status; it will not be submitted again"
        };
        return Err(error(reason));
    }
    // An unresolved earlier submission fences this mob even if a client lost
    // its local marker. Only witnessed terminality or explicit cleanup clears it.
    for entry in std::fs::read_dir(root.join("thread-recovery")).map_err(error)? {
        let path = entry.map_err(error)?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let mut previous: Submission =
            serde_json::from_slice(&std::fs::read(path).map_err(error)?).map_err(error)?;
        if previous.mob_id == mob
            && !["recovered", "recovering"].contains(&previous.status.as_str())
        {
            // The terminal outbox/receipt commits before this correspondence
            // record. A crash between them must not hide its exact witness.
            if let Some(terminal) = crate::lookup_terminal_run(root, &previous.run_id) {
                if terminal.get("threadId").and_then(Value::as_str)
                    == Some(previous.thread_id.as_str())
                {
                    if let Some(status) = terminal
                        .get("status")
                        .and_then(Value::as_str)
                        .filter(|status| ["completed", "failed", "cancelled"].contains(status))
                    {
                        previous.status = status.to_string();
                        write(root, &previous)?;
                    }
                }
            }
        }
        if previous.mob_id == mob
            && !["completed", "failed", "cancelled", "recovered"]
                .contains(&previous.status.as_str())
        {
            return Err(error(
                "An earlier operation is unresolved. Reconcile or explicitly recover it before submitting new work.",
            ));
        }
    }
    write(
        root,
        &Submission {
            version: 1,
            run_id: run.into(),
            thread_id: thread,
            mob_id: mob,
            agent_identity: agent.into(),
            fingerprint,
            owner: gateway.to_string(),
            status: "submitted".into(),
            native_session_id: None,
            native_receipt: None,
            native_custody_version: cfg!(any(target_os = "linux", target_os = "macos"))
                .then_some(1),
            recovery_before_dispatch: false,
        },
    )
}
pub(crate) fn dispatching(
    root: &Path,
    run: &str,
    session: Option<String>,
) -> Result<(), GatewayError> {
    let _owner = OWNERSHIP.lock().map_err(error)?;
    let Some(mut record) = read(root, run)? else {
        return Err(error("submission is missing"));
    };
    if record.status != "submitted" {
        return Err(error("submission is no longer admissible"));
    }
    record.status = "dispatching".into();
    record.native_session_id = session;
    write(root, &record)
}
pub(crate) fn admitted(
    root: &Path,
    run: &str,
    session: Option<String>,
    receipt: Value,
) -> Result<(), GatewayError> {
    let _owner = OWNERSHIP.lock().map_err(error)?;
    let Some(mut record) = read(root, run)? else {
        return Err(error("submission is missing"));
    };
    if record.status != "dispatching" {
        return Err(error("submission is no longer admissible"));
    }
    record.native_session_id = session;
    record.native_receipt = Some(receipt);
    record.status = "admitted".into();
    write(root, &record)
}
pub(crate) fn terminal(root: &Path, run: &str, status: &str) -> Result<(), GatewayError> {
    let _owner = OWNERSHIP.lock().map_err(error)?;
    let Some(mut record) = read(root, run)? else {
        return Ok(());
    };
    if ["recovered", "recovering"].contains(&record.status.as_str()) {
        return Ok(());
    }
    if !["completed", "failed", "cancelled"].contains(&status) {
        return Err(error("invalid terminal witness"));
    }
    record.status = status.into();
    write(root, &record)
}

impl MeerkatGateway {
    pub(crate) async fn mobs_recover_thread(
        &self,
        params: Option<&Value>,
    ) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let thread = required_nonempty_string(params, "threadId")?;
        let mob = required_nonempty_string(params, "mobId")?;
        let run = required_nonempty_string(params, "runId")?;
        let handle = self.project_runtime_handle_for_mob_params(params).await?;
        let root = handle.state.lock().await.locator.state_root.clone();
        let record = read(&root,&run)?.ok_or_else(||error("This legacy dispatch has no ownership record. Its outcome cannot be safely cleared."))?;
        if record.thread_id != thread || record.mob_id != mob {
            return Err(error(
                "Recovery target does not match the recorded operation",
            ));
        }
        let (key, mut record) = {
            let state = handle.state.lock().await;
            let mut owner = OWNERSHIP.lock().map_err(error)?;
            let key = acquire(&mut owner, &root, &mob, &gateway_owner(self))?;
            if owner.recovering.contains(&key) {
                return Err(error("Thread cleanup is already in progress"));
            }
            let mut record = read(&root, &run)?.ok_or_else(|| error("submission disappeared"))?;
            if record.status == "recovered" {
                return Ok(
                    json!({"runId":run,"recovered":true,"cleanupCompleted":true,"outcome":"unresolved"}),
                );
            }
            if ["completed", "failed", "cancelled"].contains(&record.status.as_str()) {
                return Err(error(
                    "This operation already has a terminal receipt. Refresh to continue.",
                ));
            }
            if record.owner != gateway_owner(self)
                && record.may_have_dispatched()
                && !record.supports_native_recovery()
            {
                return Err(error(
                    "This operation predates native process custody or lost its session binding. Its tool cleanup cannot be proven, so the unresolved operation remains fenced.",
                ));
            }
            if state.active_runs.iter().any(|(active_thread, active)| {
                (active_thread == &thread || active.mob_id == mob)
                    && (active.run_id != run || active.mob_id != mob)
            }) {
                return Err(error(
                    "A newer run owns this thread. Refresh before recovery.",
                ));
            }
            drop(state);
            record.begin_recovery();
            write(&root, &record)?;
            owner.recovering.insert(key.clone());
            (key, record)
        };
        // Cold recovery preserves the original conversation and lets native
        // custody settle interrupted inputs before that session serves again.
        // A successful recovery deliberately makes no claim about tool effects.
        let result = if record.owner != gateway_owner(self) && record.supports_native_recovery() {
            self.recover_native_thread(params, &root, &record).await
        } else {
            self.mobs_destroy(Some(&Value::Object(params.clone())))
                .await
                .map(|_| ())
        };
        let mut owner = OWNERSHIP.lock().map_err(error)?;
        owner.recovering.remove(&key);
        result?;
        record.status = "recovered".into();
        write(&root, &record)?;
        Ok(json!({"runId":run,"recovered":true,"cleanupCompleted":true,"outcome":"unresolved"}))
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    async fn recover_native_thread(
        &self,
        params: &serde_json::Map<String, Value>,
        root: &Path,
        record: &Submission,
    ) -> Result<(), GatewayError> {
        use meerkat_runtime::SessionServiceRuntimeExt;

        let session = meerkat_core::SessionId::parse(
            record.native_session_id.as_deref().ok_or_else(|| error("native session is missing"))?,
        ).map_err(error)?;
        // Keep this exact native custody handle alive through materialization.
        // The runtime's evidence source and factory share it; only the native
        // pending-attachment protocol settles inputs and records notices.
        let mob_root = root.join("mobkit").join(crate::stable_slug(&record.mob_id));
        // Include native helpers that are not otherwise materialized during
        // reconnect. The native sweep reports each scope's refusal separately.
        crate::native_process_custody::NativeProcessCustody::settle_realm(&mob_root)
            .await.map_err(error)?;
        let _custody = crate::native_process_custody::NativeProcessCustody::settle(
            mob_root, &session,
        ).await.map_err(error)?;
        let handle = self.project_runtime_handle_for_mob_params(params).await?;
        let registry = handle.state.lock().await.mobkit.clone();
        if registry.get(&record.mob_id).await.is_none() {
            let mut reconnect = params.clone();
            reconnect.insert("ingressAgentIdentity".into(), Value::String(record.agent_identity.clone()));
            // The canonical MobCreated definition and native session metadata
            // own model, instructions and access policy on this reconnect.
            reconnect.remove("model");
            reconnect.remove("accessMode");
            self.mobs_create_thread_mob(Some(&Value::Object(reconnect))).await?;
        }
        let mob = registry.get(&record.mob_id).await
            .ok_or_else(|| error("native thread did not reconnect"))?;
        let runtime = mob.runtime.as_ref().ok_or_else(|| error("native runtime is unavailable"))?;
        let member = meerkat_mobkit::member_comms_id::mob_member_id(&record.agent_identity);
        let restored = runtime.mob_handle().resolve_bridge_session_id(&member).await;
        if restored.as_ref() != Some(&session) {
            return Err(error("Recovery did not preserve the original native session"));
        }
        runtime.mob_handle().ensure_member_live(&member).await.map_err(error)?;
        let machine = mob.session_runtime.as_ref().ok_or_else(|| error("native machine is unavailable"))?;
        if !machine.list_active_inputs(&session).await.map_err(error)?.is_empty() {
            return Err(error("Native work is still active. Refresh before recovering this operation."));
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    async fn recover_native_thread(
        &self,
        _params: &serde_json::Map<String, Value>,
        _root: &Path,
        _record: &Submission,
    ) -> Result<(), GatewayError> {
        Err(error("Native process recovery is unavailable on this platform"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn recovering_correspondence_keeps_exact_session_and_rejects_other_members() {
        let root = std::env::temp_dir().join(format!("thread-recovery-binding-{}", uuid::Uuid::new_v4()));
        let params = json!({"threadId":"thread", "mobId":"mob", "input":"once"});
        let session = meerkat_core::SessionId::new();
        reserve(&root, params.as_object().unwrap(), "operation", "gateway").unwrap();
        dispatching(&root, "operation", Some(session.to_string())).unwrap();
        assert!(recovering_session(&root, "mob", "ingress").unwrap().is_none());
        let mut record = read(&root, "operation").unwrap().unwrap();
        record.status = "recovering".into();
        write(&root, &record).unwrap();
        assert_eq!(recovering_session(&root, "mob", "ingress").unwrap(), Some(session));
        assert!(recovering_session(&root, "mob", "replacement").is_err());
        record.native_custody_version = None;
        write(&root, &record).unwrap();
        assert!(recovering_session(&root, "mob", "ingress").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn subprocess_owner() {
        let Some(root) = std::env::var_os("T3_THREAD_RECOVERY_CHILD_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        reserve(
            &root,
            json!({"threadId":"thread","mobId":"mob","input":"once"})
                .as_object()
                .unwrap(),
            "child-operation",
            "child-gateway",
        )
        .unwrap();
        if std::env::var_os("T3_THREAD_RECOVERY_CHILD_DISPATCH").is_some() {
            dispatching(&root, "child-operation", None).unwrap();
            std::fs::write(root.join("dispatched"), "yes").unwrap();
        }
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    }

    #[tokio::test]
    async fn recovery_requires_dead_owner_and_permanently_fences_the_original_operation() {
        let root =
            std::env::temp_dir().join(format!("thread-recovery-process-{}", uuid::Uuid::new_v4()));
        let project = root.join("project");
        let state = root.join("state");
        std::fs::create_dir_all(&project).unwrap();
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut child = Child(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "thread_recovery::tests::subprocess_owner",
                    "--nocapture",
                ])
                .env("T3_THREAD_RECOVERY_CHILD_ROOT", &state)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !record_path(&state, "child-operation").is_file() {
            assert!(
                std::time::Instant::now() < deadline,
                "child did not reserve submission"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let gateway = MeerkatGateway::new();
        let params = json!({"projectPath":project,"stateRoot":state,"threadId":"thread","mobId":"mob","runId":"child-operation"});
        assert!(gateway.mobs_recover_thread(Some(&params)).await.is_err());
        assert_eq!(
            read(&state, "child-operation").unwrap().unwrap().status,
            "submitted"
        );
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        let recovered = gateway.mobs_recover_thread(Some(&params)).await.unwrap();
        assert_eq!(recovered["cleanupCompleted"], true);
        assert_eq!(recovered["outcome"], "unresolved");
        assert_eq!(
            gateway.mobs_run_status(Some(&params)).await.unwrap()["status"],
            "recovered"
        );
        assert!(
            reserve(
                &state,
                params.as_object().unwrap(),
                "child-operation",
                &gateway_owner(&gateway)
            )
            .is_err()
        );
        reserve(
            &state,
            params.as_object().unwrap(),
            "fresh-operation",
            &gateway_owner(&gateway),
        )
        .unwrap();
        assert!(
            reserve(
                &state,
                params.as_object().unwrap(),
                "third-operation",
                &gateway_owner(&gateway)
            )
            .is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn never_dispatched_recovery_can_retry_after_cleanup_owner_disappears() {
        let root = std::env::temp_dir().join(format!("thread-recovery-retry-{}", uuid::Uuid::new_v4()));
        let project = root.join("project");
        let state = root.join("state");
        std::fs::create_dir_all(&project).unwrap();
        let mut record = Submission {
            version: 1,
            run_id: "not-dispatched".into(),
            thread_id: "thread".into(),
            mob_id: "mob".into(),
            agent_identity: "ingress".into(),
            fingerprint: "original-submission".into(),
            owner: "dead-gateway".into(),
            status: "submitted".into(),
            native_session_id: None,
            native_receipt: None,
            native_custody_version: None,
            recovery_before_dispatch: false,
        };
        // This is the durable state left if cleanup fails, or its owner dies,
        // after the recovering transition and before cleanup completes.
        record.begin_recovery();
        record.begin_recovery();
        write(&state, &record).unwrap();
        let reopened = read(&state, "not-dispatched").unwrap().unwrap();
        assert_eq!(reopened.status, "recovering");
        assert!(!reopened.may_have_dispatched());
        assert!(dispatching(&state, "not-dispatched", None).is_err(), "a delayed dispatch must stay fenced during cleanup");
        let gateway = MeerkatGateway::new();
        let params = json!({"projectPath":project, "stateRoot":state, "threadId":"thread", "mobId":"mob", "runId":"not-dispatched"});
        assert_eq!(gateway.mobs_run_status(Some(&params)).await.unwrap()["canRecover"], true);
        let recovered = gateway.mobs_recover_thread(Some(&params)).await.unwrap();
        assert_eq!(recovered["cleanupCompleted"], true);
        assert_eq!(read(&state, "not-dispatched").unwrap().unwrap().status, "recovered");
        assert!(reserve(&state, params.as_object().unwrap(), "not-dispatched", &gateway_owner(&gateway)).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn cold_dispatch_remains_fenced_without_native_tool_containment_receipt() {
        let root =
            std::env::temp_dir().join(format!("thread-recovery-unknown-{}", uuid::Uuid::new_v4()));
        let project = root.join("project");
        let state = root.join("state");
        std::fs::create_dir_all(&project).unwrap();
        let params = json!({"projectPath":project,"stateRoot":state,"threadId":"thread","mobId":"mob","runId":"uncertain"});
        write(
            &state,
            &Submission {
                version: 1,
                run_id: "uncertain".into(),
                thread_id: "thread".into(),
                mob_id: "mob".into(),
                agent_identity: "ingress".into(),
                fingerprint: "unknown".into(),
                owner: "dead-gateway".into(),
                status: "dispatching".into(),
                native_session_id: None,
                native_receipt: None,
                native_custody_version: None,
                recovery_before_dispatch: false,
            },
        )
        .unwrap();
        let gateway = MeerkatGateway::new();
        assert!(gateway.mobs_recover_thread(Some(&params)).await.is_err());
        assert_eq!(
            gateway.mobs_run_status(Some(&params)).await.unwrap()["status"],
            "unknown"
        );
        assert_eq!(
            read(&state, "uncertain").unwrap().unwrap().status,
            "dispatching"
        );
        assert!(
            reserve(
                &state,
                params.as_object().unwrap(),
                "fresh-operation",
                &gateway_owner(&gateway)
            )
            .is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn journal_survives_reopen_and_never_replays_or_changes_operation_identity() {
        let root = std::env::temp_dir().join(format!("thread-recovery-{}", uuid::Uuid::new_v4()));
        let params = json!({"threadId":"thread","mobId":"mob","input":"once"});
        reserve(
            &root,
            params.as_object().unwrap(),
            "known-before-io",
            "test-gateway",
        )
        .unwrap();
        assert_eq!(
            read(&root, "known-before-io").unwrap().unwrap().status,
            "submitted"
        );
        assert!(
            reserve(
                &root,
                params.as_object().unwrap(),
                "known-before-io",
                "test-gateway"
            )
            .is_err()
        );
        dispatching(&root, "known-before-io", None).unwrap();
        admitted(
            &root,
            "known-before-io",
            Some("native-session".into()),
            json!({"identity":"ingress","handling_mode":"queue"}),
        )
        .unwrap();
        assert_eq!(
            read(&root, "known-before-io")
                .unwrap()
                .unwrap()
                .native_session_id
                .as_deref(),
            Some("native-session")
        );
        assert!(read(&root, "other").unwrap().is_none());
        terminal(&root, "known-before-io", "completed").unwrap();
        assert_eq!(
            read(&root, "known-before-io").unwrap().unwrap().status,
            "completed"
        );
        assert!(
            reserve(
                &root,
                params.as_object().unwrap(),
                "known-before-io",
                "test-gateway"
            )
            .is_err()
        );
        reserve(
            &root,
            params.as_object().unwrap(),
            "terminal-window",
            "test-gateway",
        )
        .unwrap();
        dispatching(&root, "terminal-window", None).unwrap();
        crate::record_terminal_run(&root, "terminal-window", "thread", "completed", None).unwrap();
        reserve(
            &root,
            params.as_object().unwrap(),
            "after-terminal-window",
            "test-gateway",
        )
        .unwrap();
        assert_eq!(
            read(&root, "terminal-window").unwrap().unwrap().status,
            "completed"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
