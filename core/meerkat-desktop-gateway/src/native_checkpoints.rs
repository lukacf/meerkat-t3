//! Canonical execution scope for explicit workspace snapshots.
//!
//! Automatic HTTP hooks remain test-only: the released adapter serializes the
//! entire native input under the user's payload policy. Installing one would
//! reject otherwise valid long prompts. Production keeps native hooks intact.
#[cfg(test)]
use std::path::PathBuf;
use std::{path::Path, sync::Arc};

#[cfg(test)]
mod proof_overlay;
#[cfg(test)]
pub(crate) use proof_overlay::runtime_config_store;
#[cfg(test)]
use proof_overlay::*;

#[cfg(not(test))]
pub(crate) fn runtime_config_store(
    store: Arc<dyn meerkat_core::ConfigStore>,
    _input: &crate::mobkit_registry::CreateMobInput,
) -> Result<Arc<dyn meerkat_core::ConfigStore>, String> {
    Ok(store)
}

/// Resolve a hook scope without waiting on the agent currently awaiting that
/// hook. The released metadata seam reads committed runtime storage directly.
pub(crate) async fn resolve_scope(
    gateway: &crate::MeerkatGateway,
    params: Option<&serde_json::Value>,
) -> Result<serde_json::Value, crate::GatewayError> {
    let params = crate::object_params(params)?;
    let mob_id = crate::required_nonempty_string(params, "mobId")?;
    let session =
        meerkat_core::SessionId::parse(&crate::required_nonempty_string(params, "sessionId")?)
            .map_err(|_| crate::GatewayError::invalid("Invalid checkpoint session", None))?;
    let state_root =
        crate::normalize_state_root_path(&crate::required_nonempty_string(params, "stateRoot")?)?;
    let registry = gateway
        .inner
        .mobkit_registries
        .lock()
        .await
        .get(&state_root)
        .cloned()
        .ok_or_else(|| crate::GatewayError::conflict("Checkpoint runtime is not loaded", None))?;
    let mob = registry
        .get(&mob_id)
        .await
        .ok_or_else(|| crate::GatewayError::conflict("Checkpoint mob is not loaded", None))?;
    let requested_workspace =
        crate::normalize_project_path(&crate::required_nonempty_string(params, "workspace")?)?;
    let requested_project =
        crate::normalize_project_path(&crate::required_nonempty_string(params, "projectPath")?)?;
    if requested_workspace
        != crate::normalize_project_path(&mob.checkpoint_workspace.to_string_lossy())?
        || requested_project
            != crate::normalize_project_path(&mob.checkpoint_project_path.to_string_lossy())?
    {
        return Err(crate::GatewayError::conflict(
            "Checkpoint scope does not match the native execution workspace",
            None,
        ));
    }
    let runtime = mob.runtime.as_ref().ok_or_else(|| {
        crate::GatewayError::policy("Remote workspaces do not support local checkpoints", None)
    })?;
    let service = runtime.mob_runtime().session_service().ok_or_else(|| {
        crate::GatewayError::policy("Native session storage is unavailable", None)
    })?;
    let metadata = service
        .load_persisted_session_metadata(&session)
        .await
        .map_err(|error| {
            crate::GatewayError::policy(
                "Cannot read checkpoint session authority",
                Some(serde_json::json!({"error":error.to_string()})),
            )
        })?;
    if metadata.is_none() {
        return Err(crate::GatewayError::conflict(
            "Checkpoint session is not owned by this native runtime",
            None,
        ));
    }
    let mut scope = serde_json::json!({
        "mobId":mob.mob_id,"sessionId":session,
        "projectPath":requested_project,"workspace":requested_workspace,"stateRoot":state_root,
        "runtimeGeneration":mob.checkpoint_incarnation,
    });
    if params
        .get("includeWorkspaceStatus")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
    {
        let status = workspace_status(gateway, &requested_workspace).await;
        scope["workspaceBusy"] = serde_json::json!(status.status != "idle");
        scope["workspaceStatus"] = serde_json::json!(status.status);
        scope["workspaceGeneration"] = serde_json::json!(status.generation);
        // A read cannot exclude a new peer input or an external writer after
        // this response. Callers must retain file guards and recheck ownership.
        scope["workspaceAdmissionFenced"] = serde_json::json!(false);
    }
    let same_registry = gateway
        .inner
        .mobkit_registries
        .lock()
        .await
        .get(&state_root)
        .is_some_and(|current| Arc::ptr_eq(current, &registry));
    let same_mob = registry
        .get(&mob_id)
        .await
        .is_some_and(|current| Arc::ptr_eq(&current, &mob));
    if !same_registry || !same_mob {
        return Err(crate::GatewayError::conflict(
            "The checkpoint runtime changed while reading its scope",
            None,
        ));
    }
    Ok(scope)
}

struct WorkspaceStatus {
    status: &'static str,
    generation: String,
}

async fn loaded_workspace_mobs(
    gateway: &crate::MeerkatGateway,
    workspace: &Path,
) -> Result<Vec<Arc<crate::mobkit_registry::MobkitMobRuntime>>, crate::GatewayError> {
    let registries = gateway
        .inner
        .mobkit_registries
        .lock()
        .await
        .values()
        .cloned()
        .collect::<Vec<_>>();
    let mut mobs = Vec::new();
    for registry in registries {
        for mob in registry.list().await {
            if mob.runtime.is_none() {
                continue;
            }
            let actual =
                crate::normalize_project_path(&mob.checkpoint_workspace.to_string_lossy())?;
            if actual == workspace {
                mobs.push(mob);
            }
        }
    }
    mobs.sort_by_key(|mob| mob.checkpoint_incarnation);
    Ok(mobs)
}

fn workspace_generation(
    mobs: &[Arc<crate::mobkit_registry::MobkitMobRuntime>],
    sessions: &[String],
) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for mob in mobs {
        hash.update(mob.checkpoint_incarnation.as_bytes());
    }
    for session in sessions {
        hash.update(session.as_bytes());
        hash.update([0]);
    }
    format!("{:x}", hash.finalize())
}

/// Observes every loaded native service sharing this execution root. The
/// runtime's complete catalog includes dynamically created and retired sessions.
/// Unknown states fail closed for file restore. No runtime is materialized.
async fn workspace_status(gateway: &crate::MeerkatGateway, workspace: &Path) -> WorkspaceStatus {
    use meerkat_runtime::{RuntimeState, SessionServiceRuntimeExt};
    let fallback = || WorkspaceStatus {
        status: "unknown",
        generation: String::new(),
    };
    let read = async {
        let mobs = loaded_workspace_mobs(gateway, workspace).await.ok()?;
        if mobs.is_empty() {
            return None;
        }
        let mut busy = false;
        let mut unknown = false;
        let mut bindings = Vec::new();
        let mut catalogs = Vec::new();
        for mob in &mobs {
            let store = mob.checkpoint_runtime_store.as_ref()?;
            let machine = mob.session_runtime.as_ref()?;
            let sessions = store
                .list_runtime_session_catalog_entries(meerkat_core::SessionFilter::default())
                .await
                .ok()?;
            if sessions.is_empty() {
                unknown = true;
            }
            let mut ids = sessions
                .iter()
                .map(|entry| entry.session_id().to_string())
                .collect::<Vec<_>>();
            ids.sort();
            for session in sessions {
                bindings.push(format!(
                    "{}:{}",
                    mob.checkpoint_incarnation,
                    session.session_id()
                ));
                let (state, pending) = tokio::join!(
                    machine.runtime_state(session.session_id()),
                    machine.list_active_inputs(session.session_id())
                );
                match (state, pending) {
                    (Ok(RuntimeState::Running), _) => busy = true,
                    (Ok(RuntimeState::Idle | RuntimeState::Attached), Ok(pending)) => {
                        busy |= !pending.is_empty();
                    }
                    _ => unknown = true,
                }
            }
            catalogs.push((store, ids));
        }
        // Catch membership replacement or a newly created child during the
        // observation, rather than reporting a stale set as an idle workspace.
        let current = loaded_workspace_mobs(gateway, workspace).await.ok()?;
        if current.len() != mobs.len() || current.iter().zip(&mobs).any(|(a, b)| !Arc::ptr_eq(a, b))
        {
            return None;
        }
        for (store, ids) in catalogs {
            let mut current = store
                .list_runtime_session_catalog_entries(meerkat_core::SessionFilter::default())
                .await
                .ok()?
                .into_iter()
                .map(|entry| entry.session_id().to_string())
                .collect::<Vec<_>>();
            current.sort();
            if current != ids {
                return None;
            }
        }
        bindings.sort();
        Some(WorkspaceStatus {
            status: if busy {
                "busy"
            } else if unknown {
                "unknown"
            } else {
                "idle"
            },
            generation: workspace_generation(&mobs, &bindings),
        })
    };
    match tokio::time::timeout(std::time::Duration::from_secs(3), read).await {
        Ok(Some(status)) => status,
        _ => fallback(),
    }
}

#[cfg(test)]
mod tests;
