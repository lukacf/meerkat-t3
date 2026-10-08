//! Forward the public runtime transaction seams for the gated builder.
//! The native host still resolves and admits every model change.
use meerkat::session_runtime::llm_reconfigure::SessionRuntimeLlmReconfigureService;
use meerkat::{PersistentSessionService, SessionError};
use meerkat_core::{AgentLlmClient, SessionId, SessionLlmIdentity, SessionToolVisibilityState};
use std::sync::Arc;

pub(crate) struct ApprovalReconfigureService(
    pub(crate) Arc<PersistentSessionService<super::ApprovalAgentBuilder>>,
);

#[async_trait::async_trait]
impl SessionRuntimeLlmReconfigureService for ApprovalReconfigureService {
    async fn synchronize_live_session_from_durable_authority(
        &self,
        id: &SessionId,
    ) -> Result<(), SessionError> {
        self.0
            .synchronize_live_session_for_runtime_turn(id)
            .await
            .map(|_discarded| ())
    }

    async fn acquire_runtime_turn_finalization_guard(
        &self,
        id: &SessionId,
    ) -> Result<Box<dyn meerkat_core::lifecycle::CoreExecutorTurnFinalizationGuard>, SessionError>
    {
        Ok(Box::new(
            self.0.acquire_runtime_turn_finalization_guard(id).await,
        ))
    }
    async fn live_llm_identity(&self, id: &SessionId) -> Result<SessionLlmIdentity, SessionError> {
        self.0.live_session_llm_identity(id).await
    }
    async fn live_session_has_instruction_activations(
        &self,
        id: &SessionId,
    ) -> Result<bool, SessionError> {
        Ok(self.0.export_live_session(id).await?.messages().iter().any(|message| matches!(message, meerkat_core::Message::System(system) if system.instruction_activation.is_some())))
    }
    async fn live_realm_id(
        &self,
        id: &SessionId,
    ) -> Result<Option<meerkat_core::RealmId>, SessionError> {
        Ok(self
            .0
            .export_live_session(id)
            .await?
            .session_metadata()
            .and_then(|metadata| metadata.realm_id))
    }
    async fn live_tool_visibility_state(
        &self,
        id: &SessionId,
    ) -> Result<Option<SessionToolVisibilityState>, SessionError> {
        self.0
            .export_live_session(id)
            .await?
            .try_tool_visibility_state()
            .map_err(|error| {
                SessionError::Agent(meerkat_core::AgentError::InternalError(error.to_string()))
            })
    }
    async fn live_web_search_override(
        &self,
        id: &SessionId,
    ) -> Result<meerkat_core::ToolCategoryOverride, SessionError> {
        Ok(self
            .0
            .export_live_session(id)
            .await?
            .session_metadata()
            .map(|metadata| metadata.tooling.web_search)
            .unwrap_or(meerkat_core::ToolCategoryOverride::Inherit))
    }
    async fn live_tool_scope_snapshot(
        &self,
        id: &SessionId,
    ) -> Result<Option<meerkat_core::ToolScopeSnapshot>, SessionError> {
        self.0.tool_scope_snapshot(id).await
    }
    async fn apply_live_llm_identity_under_runtime_turn_boundary(
        &self,
        id: &SessionId,
        client: Arc<dyn AgentLlmClient>,
        identity: SessionLlmIdentity,
        request_policy: meerkat_core::SessionLlmRequestPolicy,
    ) -> Result<(), SessionError> {
        self.0
            .apply_runtime_session_llm_identity_under_runtime_turn_boundary(
                id,
                client,
                identity,
                request_policy,
            )
            .await
    }
    async fn apply_live_tool_visibility_state_under_runtime_turn_boundary(
        &self,
        id: &SessionId,
        state: Option<SessionToolVisibilityState>,
    ) -> Result<(), SessionError> {
        self.0
            .apply_runtime_session_tool_visibility_state_under_runtime_turn_boundary(id, state)
            .await
    }
    async fn persist_live_under_runtime_turn_boundary(
        &self,
        id: &SessionId,
    ) -> Result<(), SessionError> {
        self.0
            .persist_live_session_now_under_runtime_turn_boundary(id)
            .await
            .map(|_| ())
    }
    async fn discard_live_under_runtime_turn_boundary(
        &self,
        id: &SessionId,
    ) -> Result<(), SessionError> {
        self.0
            .discard_live_session_under_runtime_turn_boundary(id)
            .await
    }
    async fn live_model_routing_control_history(
        &self,
        id: &SessionId,
    ) -> Result<
        meerkat_core::session::model_routing_control::SessionModelRoutingControlHistory,
        SessionError,
    > {
        if let Some(session) = self.0.observe_authoritative_session_body(id).await? {
            return Ok(session.model_routing_control().clone());
        }
        match self.0.export_live_session(id).await {
            Ok(session) => Ok(session.model_routing_control().clone()),
            Err(SessionError::NotFound { .. }) => Ok(Default::default()),
            Err(error) => Err(error),
        }
    }
    async fn commit_model_routing_control_record_durable_first(
        self: Arc<Self>,
        id: &SessionId,
        record: meerkat_core::session::model_routing_control::SessionModelRoutingControlRecord,
    ) -> Result<(), SessionError> {
        Arc::clone(&self.0)
            .commit_model_routing_control_record_durable_first(id, record)
            .await
    }
}
