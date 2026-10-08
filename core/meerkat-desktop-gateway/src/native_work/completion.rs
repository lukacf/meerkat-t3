//! Read finalized native input receipts. Console admissions retain their own
//! identity; unkeyed run-start work retains its native session/input/run tuple.
use crate::mobkit_registry::{ConsoleExpectedTarget, MobkitMobRuntime};
use crate::GatewayError;
use meerkat_core::{
    event::{AgentEvent, InteractionFailureReason},
    interaction::InteractionId,
    lifecycle::run_primitive::RunApplyBoundary,
    RunId, SessionId,
};
use meerkat_mobkit::{ConsoleFrame, ConsoleFrameSourceKind};
use meerkat_runtime::{
    completion::{interaction_terminal_event, CompletionOutcome},
    identifiers::LogicalRuntimeId,
    terminal_status::{InputTerminalReceiptRead, InteractionSelector, TerminalWitnessSource},
    MeerkatMachine, RuntimeStore, SessionServiceRuntimeExt,
};
use serde_json::{json, Map, Value};
use std::{collections::HashSet, path::PathBuf};

#[derive(Clone, Debug, PartialEq)]
enum CompletionIdentity {
    Console(String),
    RuntimeInput {
        session_id: String,
        input_id: String,
        run_id: String,
    },
}
impl CompletionIdentity {
    fn fields(&self) -> Value {
        match self {
            Self::Console(interaction) => json!({"interactionId":interaction}),
            Self::RuntimeInput {
                session_id,
                input_id,
                run_id,
            } => json!({
                "kind":"runtime_input", "sessionId":session_id,
                "inputId":input_id, "runId":run_id,
            }),
        }
    }
    fn matches(&self, value: &Value) -> bool {
        self.fields().as_object().is_some_and(|fields| {
            fields
                .iter()
                .all(|(key, field)| value.get(key) == Some(field))
        })
    }
}

pub(super) struct Completion {
    identity: CompletionIdentity,
    status: &'static str,
    timestamp_ms: u64,
    text: String,
    is_latest_input: bool,
    input_timestamp_ms: u64,
    evidence: Value,
}

fn failure(error: impl std::fmt::Display) -> GatewayError {
    GatewayError::conflict(
        "Native completion evidence is unavailable",
        Some(json!({"error":error.to_string()})),
    )
}

fn exact_admission(frame: &ConsoleFrame, expected: &ConsoleExpectedTarget) -> bool {
    expected.session_id.is_some()
        && frame.session_id == expected.session_id
        && frame.identity == expected.identity
        && frame.runtime_key == expected.runtime_key
        && frame.kind == "user_input"
        && frame.source.kind == ConsoleFrameSourceKind::Send
        && frame.interaction_id.is_some()
        && frame.payload.get("handling_mode").and_then(Value::as_str) != Some("steer")
}

fn terminal(
    session: &SessionId,
    interaction: InteractionId,
    outcome: CompletionOutcome,
) -> Result<Option<(&'static str, String)>, GatewayError> {
    // A native result names its session. Never borrow another session's text,
    // even if a corrupt adapter gave its receipt the requested input id.
    if let CompletionOutcome::Completed(result) = &outcome {
        if result.session_id != *session {
            return Err(failure(
                "Completion result belongs to a different native session",
            ));
        }
    }
    // A context-only append is not completed user work. Callback boundaries
    // remain pending. All success/failure classification, including extraction
    // errors, otherwise stays with Meerkat's public canonical mapping.
    if matches!(outcome, CompletionOutcome::CompletedWithoutResult) {
        return Ok(None);
    }
    Ok(match interaction_terminal_event(interaction, outcome) {
        AgentEvent::InteractionComplete { result, .. } => Some(("completed", result)),
        AgentEvent::InteractionFailed { reason, .. } => Some(("failed", reason.to_string())),
        _ => None,
    })
}

pub(super) async fn read(
    mob: &MobkitMobRuntime,
    expected: &ConsoleExpectedTarget,
    path: PathBuf,
) -> Result<Option<Completion>, GatewayError> {
    let Some(runtime) = mob.session_runtime.as_ref() else {
        return Ok(None);
    };
    let (inputs, runs) = tokio::try_join!(
        crate::native_history::recent_work_inputs(path.clone(), expected.clone()),
        crate::native_history::recent_work_runs(path, expected.clone()),
    )?;
    let console = read_inputs(runtime, expected, &inputs).await?;
    let native = if let Some(store) = &mob.checkpoint_runtime_store {
        read_runs(runtime, store.as_ref(), expected, &runs).await?
    } else {
        None
    };
    let mut latest = console
        .into_iter()
        .chain(native)
        .max_by_key(|item| item.timestamp_ms);
    if let Some(completion) = &mut latest {
        completion.is_latest_input &= !inputs.iter().chain(&runs).any(|frame| {
            frame.kind == "user_input" && frame.timestamp_ms > completion.input_timestamp_ms
                || frame.kind == "run_started" && frame.timestamp_ms > completion.timestamp_ms
        });
    }
    Ok(latest)
}

async fn read_inputs(
    runtime: &MeerkatMachine,
    expected: &ConsoleExpectedTarget,
    inputs: &[ConsoleFrame],
) -> Result<Option<Completion>, GatewayError> {
    let Some(session) = expected.session_id.as_ref() else {
        return Ok(None);
    };
    let session: SessionId = serde_json::from_value(json!(session)).map_err(failure)?;
    for (index, frame) in inputs
        .iter()
        .filter(|frame| exact_admission(frame, expected))
        .enumerate()
    {
        let interaction: InteractionId =
            serde_json::from_value(json!(frame.interaction_id)).map_err(failure)?;
        // Released MobKit send_console_human_on_mob uses input_frame_id as
        // MobDeliveryIdentity.idempotency_key. Its correlation id is the
        // console interaction, while Meerkat mints a separate runtime InputId.
        let Some(read) = runtime
            .input_terminal_receipt(
                &session,
                InteractionSelector::IdempotencyKey(frame.id.clone()),
            )
            .await
            .map_err(failure)?
        else {
            continue;
        };
        let witness = match read.source {
            TerminalWitnessSource::LiveRuntime => "live_runtime",
            TerminalWitnessSource::DurableStore => "durable_store",
        };
        let InputTerminalReceiptRead::Finalized(receipt) = read.report else {
            continue;
        };
        let Some(stored) = runtime
            .input_state_by_idempotency_key(&session, &frame.id)
            .await
            .map_err(failure)?
        else {
            return Err(failure(
                "Finalized completion lost its native input witness",
            ));
        };
        if stored.state.input_id != *receipt.input_id()
            || stored
                .state
                .idempotency_key
                .as_ref()
                .map(|key| key.0.as_str())
                != Some(frame.id.as_str())
            || stored.seed.terminal_outcome.as_ref() != Some(receipt.terminal())
        {
            return Err(failure(
                "Completion receipt does not match its admitted input",
            ));
        }
        let Some((status, text)) = terminal(&session, interaction, receipt.outcome().clone())?
        else {
            continue;
        };
        let timestamp_ms =
            u64::try_from(stored.state.updated_at.timestamp_millis()).map_err(failure)?;
        let evidence = json!({
            "source":"runtime_input_receipt", "witness":witness, "sessionId":session,
            "inputFrameId":frame.id, "interactionId":interaction,
            "inputId":receipt.input_id(), "runId":receipt.run_id(),
            "recipientInputIds":receipt.recipient_input_ids(),
            "timestampMs":timestamp_ms, "outcome":receipt.outcome(),
        });
        return Ok(Some(Completion {
            identity: CompletionIdentity::Console(interaction.to_string()),
            status,
            timestamp_ms,
            text,
            is_latest_input: index == 0,
            input_timestamp_ms: frame.timestamp_ms,
            evidence,
        }));
    }
    Ok(None)
}

// The public finalized outcome is already classified by the runtime. Render it
// without manufacturing a console InteractionId for native run-start work.
fn native_terminal(
    session: &SessionId,
    outcome: &CompletionOutcome,
) -> Result<Option<(&'static str, String)>, GatewayError> {
    let failure_reason = match outcome {
        CompletionOutcome::Completed(result) => {
            if result.session_id != *session {
                return Err(failure(
                    "Completion result belongs to a different native session",
                ));
            }
            if let Some(error) = &result.extraction_error {
                InteractionFailureReason::ExtractionFailed {
                    last_output: error.last_output.clone(),
                    attempts: error.attempts,
                    reason: error.reason.clone(),
                }
            } else {
                return Ok(Some(("completed", result.text.clone())));
            }
        }
        CompletionOutcome::CompletedWithoutResult
        | CompletionOutcome::CallbackPending { .. }
        | CompletionOutcome::CallbackBatchPending { .. } => return Ok(None),
        CompletionOutcome::Cancelled => InteractionFailureReason::Cancelled,
        CompletionOutcome::Abandoned { reason, .. }
        | CompletionOutcome::AbandonedWithError { reason, .. }
        | CompletionOutcome::RuntimeTerminated { reason, .. } => {
            InteractionFailureReason::abandoned(reason.clone())
        }
        CompletionOutcome::CompletedWithFinalizationFailure { error } => {
            InteractionFailureReason::finalization_failed(
                error
                    .detail
                    .clone()
                    .unwrap_or_else(|| "turn finalization failed".into()),
            )
        }
    };
    Ok(Some(("failed", failure_reason.to_string())))
}

async fn read_runs(
    runtime: &MeerkatMachine,
    store: &dyn RuntimeStore,
    expected: &ConsoleExpectedTarget,
    runs: &[ConsoleFrame],
) -> Result<Option<Completion>, GatewayError> {
    let Some(session) = &expected.session_id else {
        return Ok(None);
    };
    let session: SessionId = serde_json::from_value(json!(session)).map_err(failure)?;
    let runtime_id = LogicalRuntimeId::for_session(&session);
    let mut seen = HashSet::new();
    let mut latest = None::<Completion>;
    for frame in runs {
        if frame.identity != expected.identity
            || frame.runtime_key != expected.runtime_key
            || frame.session_id != expected.session_id
            || frame.kind != "run_started"
            || frame.interaction_id.is_some()
            || frame.source.kind != ConsoleFrameSourceKind::ConsoleEvent
        {
            continue;
        }
        let Some(run) = &frame.run_id else { continue };
        if !seen.insert(run.clone()) {
            continue;
        }
        let run: RunId = serde_json::from_value(json!(run)).map_err(failure)?;
        // The exact first committed boundary names actual run-start input IDs.
        // It discovers candidates; it is not itself terminal evidence.
        let Some(boundary) = store
            .load_boundary_receipt(&runtime_id, &run, 1)
            .await
            .map_err(failure)?
        else {
            continue;
        };
        if boundary.run_id != run || boundary.sequence != 1 {
            return Err(failure(
                "Native run-start receipt belongs to a different run",
            ));
        }
        if boundary.boundary != RunApplyBoundary::RunStart {
            continue;
        }
        let mut owners = HashSet::new();
        for input_id in &boundary.contributing_input_ids {
            let Some(stored) = runtime
                .input_state(&session, input_id)
                .await
                .map_err(failure)?
            else {
                return Err(failure("Run-start receipt lost its native input"));
            };
            // Console and directed work already have their native interaction
            // path. Restrict this additive path to unkeyed initialization so
            // old admissions outside the recent page cannot get a second ID.
            if stored.state.idempotency_key.is_some()
                || stored.state.directed_run_started_attribution.is_some()
            {
                continue;
            }
            let Some(read) = runtime
                .input_terminal_receipt(&session, InteractionSelector::InputId(input_id.clone()))
                .await
                .map_err(failure)?
            else {
                continue;
            };
            let witness = match read.source {
                TerminalWitnessSource::LiveRuntime => "live_runtime",
                TerminalWitnessSource::DurableStore => "durable_store",
            };
            let InputTerminalReceiptRead::Finalized(receipt) = read.report else {
                continue;
            };
            let Some(stored) = runtime
                .input_state(&session, input_id)
                .await
                .map_err(failure)?
            else {
                return Err(failure("Finalized receipt lost its native input"));
            };
            // A retried input may now belong to a later run. This candidate
            // cannot borrow that later result.
            if receipt.run_id() != Some(&run) || stored.seed.last_run_id.as_ref() != Some(&run) {
                continue;
            }
            if receipt.input_id() != input_id
                || stored.state.input_id != *input_id
                || stored.seed.terminal_outcome.as_ref() != Some(receipt.terminal())
                || !receipt.recipient_input_ids().contains(input_id)
                || !receipt
                    .recipient_input_ids()
                    .contains(receipt.owner_input_id())
            {
                return Err(failure(
                    "Completion receipt does not match its native run-start input",
                ));
            }
            if !owners.insert(receipt.owner_input_id().clone()) {
                continue;
            }
            let batch = store
                .load_input_states_by_ids(&runtime_id, receipt.recipient_input_ids())
                .await
                .map_err(failure)?;
            if batch.iter().any(Option::is_none) {
                return Err(failure("Finalized receipt lost a native recipient"));
            }
            // A mixed batch with an admitted console/directed input keeps its
            // existing interaction notification, never a second native ID.
            // Typed steering has no separate work notification. It can join
            // an unkeyed child kickoff without suppressing that run's result.
            if batch.iter().flatten().any(|item| {
                item.state.idempotency_key.as_ref().is_some_and(|key| {
                    !key.0.starts_with(crate::native_steering::KEY_PREFIX)
                        && !key.0.starts_with("meerkat-app:coordinator-steer:v1:")
                }) || item.state.directed_run_started_attribution.is_some()
            }) {
                continue;
            }
            let owner = batch
                .iter()
                .flatten()
                .find(|item| item.state.input_id == *receipt.owner_input_id())
                .ok_or_else(|| failure("Finalized receipt lost its native owner"))?;
            let Some((status, text)) = native_terminal(&session, receipt.outcome())? else {
                continue;
            };
            let timestamp_ms =
                u64::try_from(owner.state.updated_at.timestamp_millis()).map_err(failure)?;
            let completion = Completion {
                identity: CompletionIdentity::RuntimeInput {
                    session_id: session.to_string(),
                    input_id: receipt.owner_input_id().to_string(),
                    run_id: run.to_string(),
                },
                status,
                timestamp_ms,
                text,
                is_latest_input: true,
                input_timestamp_ms: u64::try_from(owner.state.created_at.timestamp_millis())
                    .map_err(failure)?,
                evidence: json!({"source":"runtime_input_receipt", "witness":witness,
                    "sessionId":session, "inputId":receipt.owner_input_id(), "runId":run,
                    "recipientInputIds":receipt.recipient_input_ids(),
                    "timestampMs":timestamp_ms, "outcome":receipt.outcome()}),
            };
            if latest
                .as_ref()
                .is_none_or(|previous| previous.timestamp_ms < timestamp_ms)
            {
                latest = Some(completion);
            }
        }
    }
    Ok(latest)
}

pub(super) fn merge(out: &mut Map<String, Value>, completion: Option<&Completion>, busy: bool) {
    let Some(completion) = completion else { return };
    let previous = out.get("latestCompletion");
    let same = previous.is_some_and(|value| completion.identity.matches(value));
    if !same
        && previous
            .and_then(|value| value.get("timestampMs"))
            .and_then(Value::as_u64)
            .is_some_and(|time| time > completion.timestamp_ms)
    {
        return;
    }
    // Keep a live event's original timestamp for the same interaction. Repeated
    // receipt observations never create a second completion identity.
    if !same {
        let mut value = completion.identity.fields();
        value["status"] = json!(completion.status);
        value["timestampMs"] = json!(completion.timestamp_ms);
        out.insert("latestCompletion".into(), value);
    }
    out.insert("completionEvidence".into(), completion.evidence.clone());
    if !busy && completion.is_latest_input {
        if let Some(text) = super::short_text(&json!(completion.text)) {
            out.insert("outcome".into(), json!(text));
        }
    } else {
        out.remove("outcome");
    }
}

#[cfg(test)]
mod tests;
