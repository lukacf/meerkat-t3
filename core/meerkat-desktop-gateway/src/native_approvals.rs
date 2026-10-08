//! Human decisions use Meerkat's durable approval authority. Only the exact
//! awaiting native dispatch can consume a decision; records never replay tools.
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};

use meerkat::{
    CreateSessionRequest, FactoryAgent, FactoryAgentBuilder, SessionAgentBuilder, SessionError,
};
use meerkat_core::{
    ApprovalDecision, ApprovalId, ApprovalListFilter, ApprovalOwnerRef, ApprovalPrincipalId,
    ApprovalRecord, ApprovalRequest, ApprovalService, ApprovalStatus, ToolDispatchAdmission,
    ToolDispatchContext, ToolError,
};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

mod reconfigure;
pub(crate) use reconfigure::ApprovalReconfigureService;

const DECISION_SECONDS: i64 = 540;

/// Immutable desktop access intent, captured before runtime construction.
/// Legacy mobs inherit their native read-only/full-access policy. A reconnect
/// cannot add or remove the human gate on an existing conversation.
pub(crate) fn resolve_mode(
    root: &Path,
    existing_mob: bool,
    requested: Option<crate::native_execution_modes::ExecutionMode>,
    native_mode: crate::native_execution_modes::ExecutionMode,
) -> Result<crate::native_execution_modes::ExecutionMode, String> {
    use std::io::Write;
    let path = root.join("desktop-access-mode.json");
    let saved = match std::fs::read(&path) {
        Ok(bytes) => Some(
            serde_json::from_slice::<crate::native_execution_modes::ExecutionMode>(&bytes)
                .map_err(|_| "Invalid saved desktop access mode")?,
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Cannot read saved desktop access mode: {error}")),
    };
    let mode = saved.unwrap_or(if existing_mob {
        native_mode
    } else {
        requested.unwrap_or(native_mode)
    });
    crate::native_execution_modes::validate_requested_mode(requested, mode)?;
    if (mode == crate::native_execution_modes::ExecutionMode::ReadOnly)
        != (native_mode == crate::native_execution_modes::ExecutionMode::ReadOnly)
    {
        return Err("Desktop access mode does not match the native tool policy".into());
    }
    if saved.is_none() {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| format!("Cannot create desktop access mode: {error}"))?;
        file.write_all(&serde_json::to_vec(&mode).map_err(|error| error.to_string())?)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
    }
    Ok(mode)
}

pub(crate) struct NativeApprovals {
    service: ApprovalService,
    waiting: Mutex<HashMap<ApprovalId, oneshot::Sender<ApprovalDecision>>>,
}

pub(crate) async fn dispatch(
    gateway: &crate::MeerkatGateway,
    params: Option<&Value>,
    decide: bool,
) -> Result<Value, crate::GatewayError> {
    let params = crate::object_params(params)?;
    let project = crate::required_nonempty_string(params, "projectPath")?;
    let state = crate::optional_string(params, "stateRoot");
    let locator = crate::derive_project_locator(&project, state.as_deref())?;
    let mob_id = crate::required_nonempty_string(params, "mobId")?;
    let session = crate::required_nonempty_string(params, "sessionId")?;
    let registry = gateway
        .inner
        .mobkit_registries
        .lock()
        .await
        .get(&locator.state_root)
        .cloned()
        .ok_or_else(|| crate::GatewayError::conflict("This native runtime is not loaded", None))?;
    let mob = registry
        .get(&mob_id)
        .await
        .ok_or_else(|| crate::GatewayError::conflict("This native mob is not loaded", None))?;
    if crate::normalize_project_path(&mob.checkpoint_project_path.to_string_lossy())?
        != locator.project_path
        && crate::normalize_project_path(&mob.checkpoint_workspace.to_string_lossy())?
            != locator.project_path
    {
        return Err(crate::GatewayError::conflict(
            "Approval scope belongs to another project",
            None,
        ));
    }
    let Some(approvals) = &mob.approvals else {
        return if decide {
            Err(crate::GatewayError::conflict(
                "This conversation does not use supervised access",
                None,
            ))
        } else {
            Ok(json!({"approvals":[]}))
        };
    };
    let result = if decide {
        let decision =
            serde_json::from_value(params.get("decision").cloned().unwrap_or(Value::Null))
                .map_err(|_| crate::GatewayError::invalid("Choose approve or deny", None))?;
        approvals.decide(
            &session,
            &crate::required_nonempty_string(params, "approvalId")?,
            decision,
        )
    } else {
        approvals.list(Some(&session))
    };
    result.map_err(|error| crate::GatewayError::conflict(error, None))
}

fn principal(value: &str) -> ApprovalPrincipalId {
    ApprovalPrincipalId::new(value).expect("constant nonempty approval principal")
}

impl NativeApprovals {
    pub(crate) fn open(root: &Path) -> Result<Arc<Self>, String> {
        let store = meerkat_store::FileApprovalStore::open(root.join("tool-approvals.json"))
            .map_err(|error| error.to_string())?;
        let service =
            ApprovalService::with_store(Arc::new(store)).map_err(|error| error.to_string())?;
        // A process-local invocation cannot survive a gateway restart. Preserve
        // its audit record, but never turn a later click into a replacement run.
        for record in service
            .list(ApprovalListFilter {
                status: Some(ApprovalStatus::Pending),
            })
            .map_err(|error| error.to_string())?
        {
            service.decide(&record.approval_id, ApprovalDecision::Deny, principal("desktop-runtime"),
                Some("The native invocation ended before this gateway started. Ask the agent to retry if still needed.".into()), None)
                .map_err(|error| error.to_string())?;
        }
        Ok(Arc::new(Self {
            service,
            waiting: Mutex::new(HashMap::new()),
        }))
    }

    pub(crate) fn list(&self, session_id: Option<&str>) -> Result<Value, String> {
        let waiting = self
            .waiting
            .lock()
            .map_err(|_| "Approval service unavailable")?;
        let mut records = self
            .service
            .list(ApprovalListFilter::default())
            .map_err(|error| error.to_string())?;
        records.retain(|record| session_id.is_none_or(|session| owned_by(record, session)));
        records.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        records.truncate(100);
        Ok(json!({"approvals": records.into_iter().map(|record| {
            let actionable = record.status == ApprovalStatus::Pending && waiting.contains_key(&record.approval_id);
            json!({"record":record,"actionable":actionable})
        }).collect::<Vec<_>>()}))
    }

    pub(crate) fn decide(
        &self,
        session_id: &str,
        id: &str,
        decision: ApprovalDecision,
    ) -> Result<Value, String> {
        let id = id
            .parse::<ApprovalId>()
            .map_err(|_| "Invalid approval ID")?;
        let mut waiting = self
            .waiting
            .lock()
            .map_err(|_| "Approval service unavailable")?;
        let record = self.service.get(&id).map_err(|error| error.to_string())?;
        if !owned_by(&record, session_id) {
            return Err("Approval belongs to another agent session".into());
        }
        let sender = waiting
            .get(&id)
            .ok_or("This native tool invocation is no longer waiting")?;
        if sender.is_closed() {
            return Err("This native tool invocation has ended".into());
        }
        let record = self
            .service
            .decide(&id, decision, principal("desktop-user"), None, None)
            .map_err(|error| error.to_string())?;
        // Keep the durable decision authoritative even if cancellation wins
        // this race. Returning an error must never resend or replay the tool.
        waiting
            .remove(&id)
            .expect("validated exact waiter")
            .send(decision)
            .map_err(|_| "Decision recorded, but the native invocation ended before delivery")?;
        Ok(json!({"record":record,"actionable":false}))
    }

    fn withdraw(&self, id: &ApprovalId) {
        if let Ok(mut waiting) = self.waiting.lock() {
            if waiting.remove(id).is_some() {
                let _ = self.service.decide(
                    id,
                    ApprovalDecision::Deny,
                    principal("desktop-runtime"),
                    Some("The native tool invocation was cancelled or timed out.".into()),
                    None,
                );
            }
        }
    }
}

fn owned_by(record: &ApprovalRecord, session: &str) -> bool {
    matches!(&record.owner, ApprovalOwnerRef::Session { session_id } if session_id.to_string() == session)
}

struct PendingGuard {
    approvals: Arc<NativeApprovals>,
    id: ApprovalId,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.approvals.withdraw(&self.id);
    }
}

struct ApprovalAdmission {
    approvals: Arc<NativeApprovals>,
    preceding: Option<Arc<dyn ToolDispatchAdmission>>,
}

#[async_trait::async_trait]
impl ToolDispatchAdmission for ApprovalAdmission {
    async fn await_dispatch_admission(
        &self,
        call: meerkat_core::types::ToolCallView<'_>,
        context: Option<&ToolDispatchContext>,
        effect: meerkat_core::LiveBridgeEffectKind,
    ) -> Result<(), ToolError> {
        if let Some(preceding) = &self.preceding {
            preceding
                .await_dispatch_admission(call, context, effect)
                .await?;
        }
        let context = context.ok_or_else(|| ToolError::AccessDenied {
            name: call.name.into(),
        })?;
        let session_id = context
            .origin_session_id()
            .ok_or_else(|| ToolError::AccessDenied {
                name: call.name.into(),
            })?;
        let run_id = context.run_id().ok_or_else(|| ToolError::AccessDenied {
            name: call.name.into(),
        })?;
        self.wait_for_decision(call, session_id, run_id, effect)
            .await
    }

    async fn record_dispatch_outcome(
        &self,
        call: meerkat_core::types::ToolCallView<'_>,
        context: Option<&ToolDispatchContext>,
        effect: meerkat_core::LiveBridgeEffectKind,
        outcome: meerkat_core::LiveBridgeEffectOutcome,
    ) -> Result<(), ToolError> {
        if let Some(preceding) = &self.preceding {
            preceding
                .record_dispatch_outcome(call, context, effect, outcome)
                .await?;
        }
        Ok(())
    }
}

impl ApprovalAdmission {
    async fn wait_for_decision(
        &self,
        call: meerkat_core::types::ToolCallView<'_>,
        session_id: &meerkat_core::SessionId,
        run_id: &meerkat_core::RunId,
        effect: meerkat_core::LiveBridgeEffectKind,
    ) -> Result<(), ToolError> {
        let (sender, receiver) = oneshot::channel();
        let record = {
            let mut waiting = self
                .approvals
                .waiting
                .lock()
                .map_err(|_| ToolError::Other("Approval service unavailable".into()))?;
            let record = self.approvals.service.request(ApprovalRequest {
                requester: principal("native-tool-dispatch"),
                owner: ApprovalOwnerRef::Session { session_id: session_id.clone() },
                resource: meerkat_core::ApprovalResourceRef { kind: meerkat_core::ApprovalResourceKind::ToolCall, id: meerkat_core::ApprovalResourceId::new(call.id) },
                proposed_action: meerkat_core::ApprovalProposedAction { kind: meerkat_core::ApprovalActionKind::ToolCall, summary: format!("Run {}", call.name), body: Some(json!({"toolName":call.name,"arguments":call.parse_args::<Value>().map_err(|error| ToolError::Other(error.to_string()))?})) },
                risk: meerkat_core::ApprovalRisk::Medium,
                request_body: Some(json!({"sessionId":session_id,"runId":run_id,"toolCallId":call.id,"effect":effect})),
                allowed_decisions: [ApprovalDecision::Approve, ApprovalDecision::Deny].into_iter().collect(),
                expires_at: Some(chrono::Utc::now() + chrono::Duration::seconds(DECISION_SECONDS)),
                metadata: Default::default(), request_provenance: None,
            }).map_err(|error| ToolError::Other(format!("Cannot request approval: {error}")))?;
            waiting.insert(record.approval_id.clone(), sender);
            record
        };
        let _guard = PendingGuard {
            approvals: self.approvals.clone(),
            id: record.approval_id,
        };
        match tokio::time::timeout(
            std::time::Duration::from_secs(DECISION_SECONDS as u64),
            receiver,
        )
        .await
        {
            Ok(Ok(ApprovalDecision::Approve)) => Ok(()),
            _ => Err(ToolError::AccessDenied {
                name: call.name.into(),
            }),
        }
    }
}

/// The typed build seam is used for fresh, resumed, peer-revived and helper
/// agents. It preserves the native factory and composes any preceding gate.
pub(crate) struct ApprovalAgentBuilder {
    pub(crate) inner: FactoryAgentBuilder,
    pub(crate) approvals: Option<Arc<NativeApprovals>>,
    pub(crate) browser_children: Option<crate::browser_bridge::BrowserChildTools>,
}

#[async_trait::async_trait]
impl SessionAgentBuilder for ApprovalAgentBuilder {
    type Agent = FactoryAgent;

    async fn model_supports_inline_video(
        &self,
        identity: &meerkat_core::SessionLlmIdentity,
    ) -> Option<bool> {
        self.inner.model_supports_inline_video(identity).await
    }

    async fn abort_absent_session_compaction_stages(
        &self,
        session_id: &meerkat_core::SessionId,
    ) -> Result<(), SessionError> {
        self.inner
            .abort_absent_session_compaction_stages(session_id)
            .await
    }

    async fn build_agent(
        &self,
        req: &CreateSessionRequest,
        event_tx: mpsc::Sender<meerkat_core::AgentEvent>,
    ) -> Result<FactoryAgent, SessionError> {
        if self.approvals.is_none() && self.browser_children.is_none() {
            return self.inner.build_agent(req, event_tx).await;
        }
        let mut build = req.build.clone().unwrap_or_default();
        if let Some(browser_children) = &self.browser_children {
            browser_children.compose(&mut build);
        }
        if let Some(approvals) = &self.approvals {
            build.tool_dispatch_admission = Some(Arc::new(ApprovalAdmission {
                approvals: approvals.clone(),
                preceding: build.tool_dispatch_admission.take(),
            }));
        }
        let gated = CreateSessionRequest {
            model: req.model.clone(),
            prompt: req.prompt.clone(),
            injected_context: req.injected_context.clone(),
            system_prompt: req.system_prompt.clone(),
            max_tokens: req.max_tokens,
            event_tx: req.event_tx.clone(),
            initial_turn: req.initial_turn,
            deferred_prompt_policy: req.deferred_prompt_policy,
            build: Some(build),
            labels: req.labels.clone(),
        };
        self.inner.build_agent(&gated, event_tx).await
    }
}

#[cfg(test)]
mod lifecycle_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::{Future, poll_fn},
        task::Poll,
    };

    #[tokio::test]
    async fn approval_decisions_are_exact_once_and_cancelled_invocations_cannot_resume() {
        let root =
            std::env::temp_dir().join(format!("native-approval-proof-{}", uuid::Uuid::new_v4()));
        let approvals = NativeApprovals::open(&root).unwrap();
        let gate = ApprovalAdmission {
            approvals: approvals.clone(),
            preceding: None,
        };
        let session = meerkat_core::SessionId::new();
        let run = meerkat_core::RunId::new();
        let args =
            serde_json::value::RawValue::from_string("{\"command\":\"touch approved\"}".into())
                .unwrap();
        let call = meerkat_core::types::ToolCallView {
            id: "exact-call",
            name: "shell",
            args: &args,
        };
        let mut future = Box::pin(gate.wait_for_decision(
            call,
            &session,
            &run,
            meerkat_core::LiveBridgeEffectKind::ToolDispatch,
        ));
        poll_fn(|cx| {
            assert!(future.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        let rows = approvals.list(Some(&session.to_string())).unwrap();
        let id = rows["approvals"][0]["record"]["approval_id"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(rows["approvals"][0]["actionable"], true);
        assert!(
            approvals
                .decide(
                    &meerkat_core::SessionId::new().to_string(),
                    &id,
                    ApprovalDecision::Approve
                )
                .is_err()
        );
        approvals
            .decide(&session.to_string(), &id, ApprovalDecision::Approve)
            .unwrap();
        future.await.unwrap();
        assert!(
            approvals
                .decide(&session.to_string(), &id, ApprovalDecision::Approve)
                .is_err()
        );

        let mut future = Box::pin(gate.wait_for_decision(
            call,
            &session,
            &run,
            meerkat_core::LiveBridgeEffectKind::ToolDispatch,
        ));
        poll_fn(|cx| {
            assert!(future.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        let rows = approvals.list(None).unwrap();
        let cancelled = rows["approvals"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["actionable"] == true)
            .unwrap()["record"]["approval_id"]
            .as_str()
            .unwrap()
            .to_string();
        drop(future);
        assert!(
            approvals
                .decide(&session.to_string(), &cancelled, ApprovalDecision::Approve)
                .is_err()
        );
        assert_eq!(
            approvals
                .service
                .get(&cancelled.parse().unwrap())
                .unwrap()
                .status,
            ApprovalStatus::Denied
        );
        drop(gate);
        drop(approvals);
        let restarted = NativeApprovals::open(&root).unwrap();
        assert_eq!(
            restarted.service.get(&id.parse().unwrap()).unwrap().status,
            ApprovalStatus::Approved
        );
        assert!(
            restarted.list(None).unwrap()["approvals"]
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| entry["actionable"] == false)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn access_mode_is_immutable_and_interrupted_requests_are_denied_on_restart() {
        use crate::native_execution_modes::ExecutionMode::*;
        let root =
            std::env::temp_dir().join(format!("native-approval-restart-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(
            resolve_mode(&root, false, Some(Approvals), FullAccess).unwrap(),
            Approvals
        );
        assert_eq!(
            resolve_mode(&root, true, None, FullAccess).unwrap(),
            Approvals
        );
        assert!(resolve_mode(&root, true, Some(FullAccess), FullAccess).is_err());
        let approvals = NativeApprovals::open(&root).unwrap();
        let record = approvals
            .service
            .request(ApprovalRequest {
                requester: principal("test"),
                owner: ApprovalOwnerRef::Session {
                    session_id: meerkat_core::SessionId::new(),
                },
                resource: meerkat_core::ApprovalResourceRef {
                    kind: meerkat_core::ApprovalResourceKind::ToolCall,
                    id: meerkat_core::ApprovalResourceId::new("lost"),
                },
                proposed_action: meerkat_core::ApprovalProposedAction {
                    kind: meerkat_core::ApprovalActionKind::ToolCall,
                    summary: "Lost dispatch".into(),
                    body: None,
                },
                risk: meerkat_core::ApprovalRisk::Medium,
                request_body: None,
                allowed_decisions: [ApprovalDecision::Approve, ApprovalDecision::Deny]
                    .into_iter()
                    .collect(),
                expires_at: None,
                metadata: Default::default(),
                request_provenance: None,
            })
            .unwrap();
        drop(approvals);
        let restarted = NativeApprovals::open(&root).unwrap();
        assert_eq!(
            restarted.service.get(&record.approval_id).unwrap().status,
            ApprovalStatus::Denied
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
