//! Thread controls project canonical native inputs without creating an application turn.
use crate::mobkit_registry::{ConsoleExpectedTarget, MobkitMobRuntime};
use crate::{
    console_expected_target, object_params, required_nonempty_string, GatewayError, MeerkatGateway,
};
use meerkat_runtime::{input_state::InputLifecycleState, SessionServiceRuntimeExt};
use serde_json::{json, Value};

mod receipt;
pub(crate) use receipt::read as coordinator_steer_receipt;
pub(crate) use receipt::read_input as read_steering_input;
#[cfg(test)]
use crate::native_steering::input as steer_input;

fn failure(error: impl std::fmt::Display) -> GatewayError {
    GatewayError::conflict(
        "Native coordinator work is unavailable",
        Some(json!({"error":error.to_string()})),
    )
}
async fn validate(
    mob: &MobkitMobRuntime,
    expected: &ConsoleExpectedTarget,
) -> Result<meerkat_core::SessionId, GatewayError> {
    mob.validate_console_incarnation(expected)
        .await
        .map_err(failure)?;
    if mob.kind != "thread"
        || expected.identity != mob.coordinator_identity
        || expected.runtime_member_id != mob.coordinator_identity
        || expected.source_mob_id.is_some()
    {
        return Err(failure("This target is not the thread coordinator"));
    }
    serde_json::from_value(json!(expected
        .session_id
        .as_ref()
        .ok_or_else(|| failure("Coordinator session is missing"))?))
    .map_err(failure)
}
async fn read(
    mob: &MobkitMobRuntime,
    expected: &ConsoleExpectedTarget,
) -> Result<Value, GatewayError> {
    let session = validate(mob, expected).await?;
    let runtime = mob
        .session_runtime
        .as_ref()
        .ok_or_else(|| failure("Native runtime is unavailable"))?;
    let busy = mob.console_target_busy(expected).await.map_err(failure)?;
    let mut inputs = Vec::new();
    for id in runtime
        .list_active_inputs(&session)
        .await
        .map_err(failure)?
    {
        if let Some(stored) = runtime.input_state(&session, &id).await.map_err(failure)? {
            if matches!(
                stored.seed.phase,
                InputLifecycleState::Staged
                    | InputLifecycleState::Applied
                    | InputLifecycleState::AppliedPendingConsumption
            ) {
                if let Some(run) = stored.seed.last_run_id {
                    let original = stored.state.persisted_input.as_ref();
                    let started_at = original.map(|input| input.header().timestamp);
                    inputs.push(json!({"inputId":id.to_string(),"runId":run.to_string(),"startedAt":started_at}));
                }
            }
        }
    }
    validate(mob, expected).await?;
    Ok(json!({"sessionId":session.to_string(),"busy":busy,"inputs":inputs}))
}
fn selected_input(
    params: &serde_json::Map<String, Value>,
) -> Result<(meerkat_core::lifecycle::InputId, String), GatewayError> {
    let id = required_nonempty_string(params, "inputId")?;
    Ok((
        serde_json::from_value(json!(id)).map_err(failure)?,
        required_nonempty_string(params, "nativeRunId")?,
    ))
}
impl MeerkatGateway {
    pub(crate) async fn mobs_coordinator_work(
        &self,
        params: Option<&Value>,
    ) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let expected = console_expected_target(params)?;
        let mob = self
            .mob_for_params(params, &required_nonempty_string(params, "mobId")?)
            .await?;
        read(&mob, &expected).await
    }
    pub(crate) async fn mobs_coordinator_stop(
        &self,
        params: Option<&Value>,
    ) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let expected = console_expected_target(params)?;
        let mob = self
            .mob_for_params(params, &required_nonempty_string(params, "mobId")?)
            .await?;
        let session = validate(&mob, &expected).await?;
        let (input, run) = selected_input(params)?;
        let runtime = mob
            .session_runtime
            .as_ref()
            .ok_or_else(|| failure("Native runtime is unavailable"))?;
        let stored = runtime
            .input_state(&session, &input)
            .await
            .map_err(failure)?
            .ok_or_else(|| failure("The selected input is no longer available"))?;
        if stored
            .seed
            .last_run_id
            .as_ref()
            .map(ToString::to_string)
            .as_deref()
            != Some(run.as_str())
        {
            return Err(failure(
                "The selected input belongs to a different native run",
            ));
        }
        let expected_run = serde_json::from_value(json!(run)).map_err(failure)?;
        // The native run fence stops every joined contributor atomically and
        // leaves queued inputs and any successor run untouched.
        let receipt = runtime
            .stop_run(&session, &expected_run, "Stopped from thread conversation")
            .await
            .map_err(failure)?;
        let accepted = matches!(receipt, meerkat_runtime::RunStopReceipt::Stopped { .. });
        Ok(
            json!({"accepted":accepted,"sessionId":session.to_string(),"inputId":input.to_string(),"nativeRunId":run}),
        )
    }
    pub(crate) async fn mobs_coordinator_steer(
        &self,
        params: Option<&Value>,
    ) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let expected = console_expected_target(params)?;
        let mob_id = required_nonempty_string(params, "mobId")?;
        let mob = self.mob_for_params(params, &mob_id).await?;
        let session = validate(&mob, &expected).await?;
        let key = required_nonempty_string(params, "idempotencyKey")?;
        let content = crate::media::parse_content(params, "content")?;
        let encoded = serde_json::to_value(&content).map_err(failure)?;
        let console = mob
            .console
            .as_ref()
            .ok_or_else(|| failure("Native console is unavailable"))?;
        // Reconcile an already accepted send before inspecting current activity.
        // This keeps a response-loss retry from following a newer native run.
        let native_key = format!(
            "send:{}:{}:meerkat-app:{}",
            expected.runtime_key, expected.identity, key
        );
        if let Some(frame) = console
            .store()
            .frame_by_dedupe_key(&native_key)
            .await
            .map_err(failure)?
        {
            if frame.session_id != expected.session_id
                || frame.payload.get("content") != Some(&encoded)
                || frame.payload.get("handling_mode").and_then(Value::as_str) != Some("steer")
            {
                return Err(failure(
                    "Steering receipt belongs to another session or message",
                ));
            }
            return Ok(
                json!({"mobId":mob_id,"identity":expected.identity,"receipt":{
                    "accepted":true,"identity":frame.identity,"input_frame_id":frame.id,"cursor":frame.cursor,
                    "interaction_id":frame.interaction_id,"status":frame.status,
                    "session_id":frame.session_id,"conversation_id":frame.conversation_id,
                }}),
            );
        }
        let (input, run) = selected_input(params)?;
        let runtime = mob
            .session_runtime
            .as_ref()
            .ok_or_else(|| failure("Native runtime is unavailable"))?;
        let native_key = receipt::native_key(&mob_id, &expected, &key)?;
        let replay = runtime
            .input_state_by_idempotency_key(&session, &native_key)
            .await
            .map_err(failure)?
            .is_some();
        if !replay {
            let stored = runtime
                .input_state(&session, &input)
                .await
                .map_err(failure)?
                .ok_or_else(|| failure("The selected input ended; refresh before sending"))?;
            if stored.seed.terminal_outcome.is_some()
                || stored
                    .seed
                    .last_run_id
                    .as_ref()
                    .map(ToString::to_string)
                    .as_deref()
                    != Some(run.as_str())
                || !mob.console_target_busy(&expected).await.map_err(failure)?
            {
                return Err(failure(
                    "The selected native work ended; send this as a new message",
                ));
            }
        }
        let blobs = console
            .binary_blob_store_for_identity(&expected.identity)
            .await
            .map_err(failure)?;
        crate::media::validate_content(blobs, &content).await?;
        let admission = crate::native_steering::admit(&mob, &expected, content, native_key.clone()).await?;
        let input_id = admission.input_id;
        let receipt = receipt::accepted(&expected, &session, &input_id, &key, &native_key);
        Ok(json!({"mobId":mob_id,"identity":expected.identity,"receipt":receipt}))
    }
}

#[cfg(test)]
mod tests;
