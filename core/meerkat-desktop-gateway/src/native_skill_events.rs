//! Project native skill resolution evidence through the existing presentation outbox.
use chrono::{TimeZone, Utc};
use meerkat_core::event::{AgentEvent, EventEnvelope};
use meerkat_desktop_contracts::EventEmit;
use serde_json::json;
use tokio::sync::broadcast;

use crate::{thread_deliveries, thread_followups::Attribution, GatewayError};

fn projection_error(message: &str) -> GatewayError {
    GatewayError::policy(
        message,
        Some(json!({"kind": "skill_receipt_projection_failed"})),
    )
}

pub(crate) fn emit(
    envelope: &EventEnvelope<AgentEvent>,
    thread_id: &str,
    run_id: &str,
    scope: Option<&Attribution>,
    events_tx: &broadcast::Sender<EventEmit>,
) -> Result<(), GatewayError> {
    let kind = match &envelope.payload {
        AgentEvent::SkillsResolved { .. } => "skills.resolved",
        AgentEvent::SkillResolutionFailed { .. } => "skills.resolution-failed",
        _ => {
            return Err(projection_error(
                "Native event is not a skill resolution receipt",
            ));
        }
    };
    // Resolution precedes native RunStarted. Only the envelope and the
    // existing per-input attribution can establish this receipt's ownership;
    // the assembler may still contain a previous native session or segment.
    let session = envelope
        .source
        .session_id()
        .ok_or_else(|| projection_error("Native skill receipt has no source session identity"))?;
    let scope = scope
        .ok_or_else(|| projection_error("Native skill receipt has no target input attribution"))?;
    let session_id = session.to_string();
    if scope.session_id != session_id || scope.thread_id != thread_id || scope.run_id != run_id {
        return Err(projection_error(
            "Native skill receipt does not match its target input attribution",
        ));
    }
    let timestamp_ms = i64::try_from(envelope.timestamp_ms)
        .map_err(|_| projection_error("Native skill receipt timestamp is out of range"))?;
    let timestamp = Utc
        .timestamp_millis_opt(timestamp_ms)
        .single()
        .ok_or_else(|| projection_error("Native skill receipt timestamp is out of range"))?;
    let native_event = serde_json::to_value(envelope).map_err(|error| {
        GatewayError::policy(
            "Native skill receipt could not be serialized",
            Some(json!({"kind": "skill_receipt_projection_failed", "error": error.to_string()})),
        )
    })?;
    let source_id = format!("evt-agent-{}", envelope.event_id);
    let event_id = format!("meerkat-output:{run_id}:{session_id}:{source_id}");
    let delivery = EventEmit {
        event_id: event_id.clone(),
        kind: kind.into(),
        timestamp,
        thread_id: Some(thread_id.into()),
        run_id: Some(run_id.into()),
        payload: json!({
            "nativeEvent": native_event,
            "nativeSourceEventId": source_id,
            "nativeSessionId": session_id,
            "nativeDeliveryId": event_id,
        }),
        trace_id: event_id.clone(),
    };
    // An absent listener must not discard the receipt. The caller retains
    // the original envelope on failure and retries this same stable delivery.
    // Skill evidence is not an assistant final and never completes a followup.
    thread_deliveries::persist(scope, &delivery)?;
    let _ = events_tx.send(delivery);
    Ok(())
}

#[cfg(test)]
mod tests;
