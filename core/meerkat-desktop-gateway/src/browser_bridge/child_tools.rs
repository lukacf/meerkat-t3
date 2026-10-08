//! Late-bound browser tools for native child sessions. The grant remains the
//! authority; constructing a child does not grant it access to any browser.
use super::{BrowserDispatcher, Scope, denied, scoped};
use crate::mobkit_registry::{ConsoleExpectedTarget, MobkitMobRuntime};
use meerkat_core::{
    AgentToolDispatcher, DynamicToolComposite, MobMemberBinding, RuntimeBuildMode, SessionId,
    ToolDispatchContext, ToolDispatchOutcome, ToolError, ToolMutationClass,
    service::SessionBuildOptions,
    types::{ToolCallView, ToolDef},
};
use std::{
    path::PathBuf,
    sync::{Arc, Weak},
};

pub(crate) struct BrowserChildTools {
    owner_mob_id: String,
    proxy: Arc<BrowserDispatcher>,
}

impl BrowserChildTools {
    pub(crate) fn new(project: PathBuf, state: PathBuf, mob: String) -> Self {
        Self {
            owner_mob_id: mob.clone(),
            proxy: scoped(Scope {
                project,
                state,
                mob,
            }),
        }
    }

    pub(crate) fn compose(&self, build: &mut SessionBuildOptions) {
        let Some(binding) = &build.mob_member_binding else {
            return;
        };
        if binding.mob_id == self.owner_mob_id {
            // The top-level MobBuilder already owns its external-tool wiring.
            return;
        }
        let RuntimeBuildMode::SessionOwned(runtime) = &build.runtime_build_mode else {
            return;
        };
        let browser: Arc<dyn AgentToolDispatcher> = Arc::new(SessionBrowserTools {
            session: runtime.session_id().clone(),
            binding: binding.clone(),
            proxy: self.proxy.clone(),
        });
        // Keep the empty dispatcher attached: an explicit grant may arrive
        // after the child was built. Native composition rejects live duplicates.
        build.external_tools = Some(match build.external_tools.take() {
            Some(existing) => Arc::new(DynamicToolComposite::new(vec![existing, browser])),
            None => browser,
        });
    }
}

struct SessionBrowserTools {
    session: SessionId,
    binding: MobMemberBinding,
    proxy: Arc<BrowserDispatcher>,
}

impl SessionBrowserTools {
    fn granted_dispatcher(&self) -> Option<Arc<dyn AgentToolDispatcher>> {
        let grants = self.proxy.grants.read().ok()?;
        let grant = grants.get(&self.session.to_string())?;
        let guard = grant.child_guard.as_ref()?;
        (guard.binding() == &self.binding).then(|| grant.dispatcher.clone())
    }
}

#[async_trait::async_trait]
impl AgentToolDispatcher for SessionBrowserTools {
    fn tools(&self) -> Arc<[Arc<ToolDef>]> {
        self.granted_dispatcher()
            .map(|dispatcher| {
                dispatcher
                    .tools()
                    .iter()
                    .filter(|tool| tool.name.starts_with("preview_"))
                    .cloned()
                    .collect::<Vec<_>>()
                    .into()
            })
            .unwrap_or_else(|| Arc::from([]))
    }

    fn tool_mutation_class(&self, name: &str) -> ToolMutationClass {
        self.granted_dispatcher()
            .filter(|dispatcher| {
                dispatcher
                    .tools()
                    .iter()
                    .any(|tool| tool.name == name && name.starts_with("preview_"))
            })
            .map(|dispatcher| dispatcher.tool_mutation_class(name))
            .unwrap_or_default()
    }

    fn execution_binding_epoch(&self, name: &str) -> u64 {
        self.proxy.execution_binding_epoch(name)
    }

    async fn dispatch(&self, call: ToolCallView<'_>) -> Result<ToolDispatchOutcome, ToolError> {
        Ok(denied(&call))
    }

    async fn dispatch_with_context(
        &self,
        call: ToolCallView<'_>,
        context: &ToolDispatchContext,
    ) -> Result<ToolDispatchOutcome, ToolError> {
        if context.origin_session_id() != Some(&self.session) || self.granted_dispatcher().is_none()
        {
            return Ok(denied(&call));
        }
        self.proxy.dispatch_with_context(call, context).await
    }
}

/// Native profile/session checks are kept with the grant, so every entry point
/// (including status and the original top-level dispatcher) rechecks them.
#[async_trait::async_trait]
pub(super) trait ChildGrantGuard: Send + Sync {
    fn binding(&self) -> &MobMemberBinding;
    async fn validate(&self) -> Result<(), String>;
}

struct NativeChildGrant {
    owner: Weak<MobkitMobRuntime>,
    expected: ConsoleExpectedTarget,
    binding: MobMemberBinding,
}

fn allows_browser_source(sources: &[String]) -> bool {
    sources.is_empty() || sources.iter().any(|source| source == "t3_preview")
}

async fn current_child_binding(
    owner: &MobkitMobRuntime,
    expected: &ConsoleExpectedTarget,
) -> Result<MobMemberBinding, String> {
    let record = owner.validate_console_incarnation(expected).await?;
    let source = record
        .labels
        .get("source_mob_id")
        .ok_or("Target is not a native child")?;
    let runtime = owner.runtime.as_ref().ok_or("Native runtime unavailable")?;
    let state = runtime
        .mob_runtime()
        .agent_mob_mcp_state()
        .ok_or("Native child runtime unavailable")?;
    let handle = state
        .mob_handles_snapshot()
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|(id, _)| id.as_str() == source)
        .map(|(_, handle)| handle)
        .ok_or("Native child mob is no longer available")?;
    let member = handle
        .list_members_observation_snapshot()
        .await
        .into_iter()
        .find(|member| {
            meerkat_mobkit::member_comms_id::runtime_alias_str(member.agent_identity.as_str())
                == record.runtime_member_id
        })
        .ok_or("Native child member is no longer available")?;
    let session = handle
        .resolve_bridge_session_id_observation(&member.agent_identity)
        .await;
    if session.as_ref().map(ToString::to_string) != expected.session_id || session.is_none() {
        return Err("Native child session changed".into());
    }
    let profile = handle
        .effective_member_profile(&member.agent_identity)
        .await
        .map_err(|error| error.to_string())?;
    if !allows_browser_source(&profile.tools.mcp) {
        return Err("Native child profile does not allow the t3_preview MCP source".into());
    }
    Ok(MobMemberBinding {
        mob_id: handle.mob_id().as_str().to_owned(),
        role: member.role.as_str().to_owned(),
        member: member.agent_identity.as_str().to_owned(),
    })
}

#[async_trait::async_trait]
impl ChildGrantGuard for NativeChildGrant {
    fn binding(&self) -> &MobMemberBinding {
        &self.binding
    }

    async fn validate(&self) -> Result<(), String> {
        let owner = self
            .owner
            .upgrade()
            .ok_or("Native browser owner is no longer available")?;
        if current_child_binding(&owner, &self.expected).await? != self.binding {
            return Err("Native child member binding changed".into());
        }
        Ok(())
    }
}

pub(super) async fn child_grant(
    owner: &Arc<MobkitMobRuntime>,
    expected: &ConsoleExpectedTarget,
) -> Result<Option<Arc<dyn ChildGrantGuard>>, String> {
    if expected.source_mob_id.is_none() {
        return Ok(None);
    }
    let binding = current_child_binding(owner, expected).await?;
    Ok(Some(Arc::new(NativeChildGrant {
        owner: Arc::downgrade(owner),
        expected: expected.clone(),
        binding,
    })))
}

#[cfg(test)]
mod tests;
