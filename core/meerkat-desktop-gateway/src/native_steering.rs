//! Typed User ingress for an existing native member, with native replay and fencing.
use crate::mobkit_registry::{ConsoleExpectedTarget, MobkitMobRuntime};
use crate::GatewayError;
use meerkat_core::{ContentInput, InputId, SessionId};
use meerkat_runtime::completion::CompletionHandle;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(crate) const KEY_PREFIX: &str = "meerkat-app:steer:v1:";

fn failure(error: impl std::fmt::Display) -> GatewayError {
    GatewayError::conflict(
        "Native steering is unavailable",
        Some(json!({"error":error.to_string()})),
    )
}

pub(crate) fn native_key(
    mob: &str,
    expected: &ConsoleExpectedTarget,
    request: &str,
) -> Result<String, GatewayError> {
    let encoded = serde_json::to_vec(&(
        mob,
        &expected.runtime_key,
        &expected.identity,
        &expected.runtime_member_id,
        &expected.session_id,
        &expected.source_mob_id,
        request,
    ))
    .map_err(failure)?;
    Ok(format!("{KEY_PREFIX}{:x}", Sha256::digest(encoded)))
}

pub(crate) fn input(content: ContentInput, key: String) -> meerkat_runtime::input::Input {
    use meerkat_core::lifecycle::run_primitive::RuntimeTurnMetadata;
    use meerkat_core::lifecycle::{ConversationAppend, ConversationAppendRole, CoreRenderable};
    use meerkat_runtime::input::{Input, PromptInput};
    let mut prompt = PromptInput::new(
        "",
        Some(RuntimeTurnMetadata {
            handling_mode: Some(meerkat_core::types::HandlingMode::Steer),
            ..Default::default()
        }),
    );
    prompt.header.idempotency_key = Some(meerkat_runtime::identifiers::IdempotencyKey::new(key));
    prompt.typed_turn_appends.push(ConversationAppend {
        runtime_source: None,
        role: ConversationAppendRole::User,
        content: match content {
            ContentInput::Text(text) => CoreRenderable::Text { text },
            ContentInput::Blocks(blocks) => CoreRenderable::Blocks { blocks },
        },
        identity: None,
    });
    Input::Prompt(prompt)
}

pub(crate) struct Admission {
    pub session: SessionId,
    pub input_id: InputId,
    pub completion: Option<CompletionHandle>,
}

pub(crate) async fn admit(
    mob: &MobkitMobRuntime,
    expected: &ConsoleExpectedTarget,
    content: ContentInput,
    key: String,
) -> Result<Admission, GatewayError> {
    let session = SessionId::parse(
        expected
            .session_id
            .as_deref()
            .ok_or_else(|| failure("Agent session is missing"))?,
    )
    .map_err(failure)?;
    let unified = mob
        .runtime
        .as_ref()
        .ok_or_else(|| failure("Native mob is unavailable"))?;
    let handle = match &expected.source_mob_id {
        None => unified.mob_handle(),
        Some(source) => unified
            .mob_runtime()
            .agent_mob_mcp_state()
            .ok_or_else(|| failure("Native child runtime is unavailable"))?
            .mob_handles_snapshot()
            .await
            .map_err(failure)?
            .into_iter()
            .find(|(id, _)| id.as_str() == source)
            .map(|(_, handle)| handle)
            .ok_or_else(|| failure("Native child mob is no longer available"))?,
    };
    let member = handle
        .list_members_observation_snapshot()
        .await
        .into_iter()
        .find(|member| {
            meerkat_mobkit::member_comms_id::runtime_alias_str(member.agent_identity.as_str())
                == expected.runtime_member_id
        })
        .ok_or_else(|| failure("Native member is no longer available"))?;
    if member.status == meerkat_mob::MobMemberStatus::Retiring {
        return Err(failure("Native member is retiring"));
    }
    if handle
        .resolve_bridge_session_id_observation(&member.agent_identity)
        .await
        .as_ref()
        != Some(&session)
    {
        return Err(failure("Native member session changed before steering"));
    }
    // Preserve the public console's current-model image admission contract.
    meerkat_mobkit::mob_handle_runtime::assert_member_accepts_images(
        &handle,
        unified.mob_runtime().session_service(),
        &expected.runtime_member_id,
        &content,
    )
    .await
    .map_err(failure)?;
    let runtime = mob
        .session_runtime
        .as_ref()
        .ok_or_else(|| failure("Native runtime is unavailable"))?;
    let attachment = runtime
        .current_executor_attachment_witness(&session)
        .await
        .ok_or_else(|| failure("Agent executor is unavailable"))?;
    let member = runtime.member_incarnation(&session);
    mob.validate_console_incarnation(expected)
        .await
        .map_err(failure)?;
    let native_input = input(content, key);
    // These native fences are checked together before durable admission. The
    // public API has no expected-run argument; callers retain their work precheck.
    let (outcome, mut completion) = runtime
        .accept_input_with_completion_for_attachment_and_member_residency(
            &attachment,
            native_input.clone(),
            member.as_ref(),
        )
        .await
        .map_err(failure)?;
    let input_id = match outcome {
        meerkat_runtime::AcceptOutcome::Accepted { input_id, .. } => input_id,
        meerkat_runtime::AcceptOutcome::Deduplicated { existing_id, .. } => {
            // The fenced path is KeyOnly. Its replay does not dispatch. Ask the
            // native ExactPrompt policy to reject a changed payload for this key.
            let (validated, replay_completion) = runtime
                .accept_input_with_completion_for_attachment_and_replay_policy(
                    &attachment,
                    native_input,
                    meerkat_runtime::accept::InputReplayPolicy::ExactPrompt,
                )
                .await
                .map_err(failure)?;
            match validated {
                meerkat_runtime::AcceptOutcome::Deduplicated {
                    existing_id: validated_id,
                    ..
                } if validated_id == existing_id => {
                    if completion.is_none() {
                        completion = replay_completion;
                    }
                    existing_id
                }
                other => {
                    return Err(failure(format!(
                        "Steering replay changed its admitted input: {other:?}"
                    )))
                }
            }
        }
        other => {
            return Err(failure(format!(
                "Native steering was not accepted: {other:?}"
            )))
        }
    };
    Ok(Admission {
        session,
        input_id,
        completion,
    })
}

pub(crate) fn receipt(
    expected: &ConsoleExpectedTarget,
    admission: &Admission,
    request: &str,
    key: &str,
) -> Value {
    accepted(
        expected,
        &admission.session,
        &admission.input_id,
        request,
        key,
    )
}

fn accepted(
    expected: &ConsoleExpectedTarget,
    session: &SessionId,
    input: &InputId,
    request: &str,
    key: &str,
) -> Value {
    json!({"kind":"runtime_input", "status":"accepted", "identity":expected.identity,
        "sessionId":session, "inputId":input, "requestId":request, "idempotencyKey":key,
        "handling_mode":"steer"})
}

/// Cold admission lookup. This reads native truth and never attaches an executor.
pub(crate) async fn read_receipt(params: Option<&Value>) -> Result<Value, GatewayError> {
    let object = crate::object_params(params)?;
    let project =
        crate::normalize_project_path(&crate::required_nonempty_string(object, "projectPath")?)?;
    let state = crate::optional_string(object, "stateRoot")
        .map(|value| crate::normalize_state_root_path(&value))
        .transpose()?
        .unwrap_or_else(|| project.join(".rkat"));
    let mob = crate::required_mob_id(object)?;
    let expected = crate::console_expected_target(object)?;
    let request = crate::required_nonempty_string(object, "idempotencyKey")?;
    let session = SessionId::parse(
        expected
            .session_id
            .as_deref()
            .ok_or_else(|| failure("Receipt lookup needs the original session"))?,
    )
    .map_err(failure)?;
    let key = native_key(&mob, &expected, &request)?;
    let path = state
        .join("mobkit")
        .join(crate::stable_slug(&mob))
        .join("runtime.sqlite");
    let identity = expected.identity.clone();
    let receipt = tokio::task::spawn_blocking(move || {
        crate::coordinator_work::read_steering_input(&path, &session, &key)
            .map(|id| id.map(|id| accepted(&expected, &session, &id, &request, &key)))
    })
    .await
    .map_err(failure)??;
    match receipt {
        Some(receipt) => {
            Ok(json!({"mobId":mob,"identity":identity,"found":true,"receipt":receipt}))
        }
        None => crate::native_receipt::read(params).await,
    }
}

pub(crate) async fn wait(admission: Admission) -> Result<(), crate::RunFailure> {
    let completion = admission.completion.ok_or_else(|| {
        crate::RunFailure::Failed("Native steering admission has no completion witness".into())
    })?;
    completion_result(&admission.session, completion.wait().await)
}

pub(super) fn completion_result(
    session: &SessionId,
    outcome: Result<
        meerkat_runtime::completion::CompletionOutcome,
        meerkat_runtime::completion::CompletionWaitError,
    >,
) -> Result<(), crate::RunFailure> {
    use meerkat_runtime::completion::CompletionOutcome;
    // Delivery failures are reserved for retrying the application's retained
    // projection writes. Native failures have no such local repair path.
    match outcome.map_err(|error| crate::RunFailure::Failed(error.to_string()))? {
        CompletionOutcome::Completed(result) if result.session_id != *session => {
            Err(crate::RunFailure::Failed(
                "Native steering completion belongs to another session".into(),
            ))
        }
        CompletionOutcome::Completed(result) => match result.extraction_error {
            Some(error) => Err(crate::RunFailure::from_interaction(
                &meerkat_core::event::InteractionFailureReason::ExtractionFailed {
                    last_output: error.last_output,
                    attempts: error.attempts,
                    reason: error.reason,
                },
            )),
            None => Ok(()),
        },
        CompletionOutcome::CompletedWithoutResult => Ok(()),
        CompletionOutcome::Cancelled => Err(crate::RunFailure::Cancelled),
        CompletionOutcome::Abandoned { reason, .. }
        | CompletionOutcome::AbandonedWithError { reason, .. }
        | CompletionOutcome::RuntimeTerminated { reason, .. } => {
            Err(crate::RunFailure::Failed(reason))
        }
        CompletionOutcome::CompletedWithFinalizationFailure { error } => {
            Err(crate::RunFailure::Failed(error.detail.unwrap_or_else(
                || "Native steering finalization failed".into(),
            )))
        }
        CompletionOutcome::CallbackPending { .. }
        | CompletionOutcome::CallbackBatchPending { .. } => Err(crate::RunFailure::Failed(
            "Native steering stopped at an unresolved callback".into(),
        )),
    }
}

#[cfg(test)]
mod tests;
