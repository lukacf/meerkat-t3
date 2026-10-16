use super::*;
use meerkat_core::lifecycle::{
    core_executor::{CoreApplyOutput, CoreExecutor, CoreExecutorError},
    run_primitive::RunPrimitive,
    RunBoundaryReceiptDraft,
};
use std::sync::Arc;

struct ResultExecutor(SessionId);
#[async_trait::async_trait]
impl CoreExecutor for ResultExecutor {
    async fn apply(
        &mut self,
        run: RunId,
        primitive: RunPrimitive,
    ) -> Result<CoreApplyOutput, CoreExecutorError> {
        Ok(CoreApplyOutput::with_run_result(
            RunBoundaryReceiptDraft {
                run_id: run,
                boundary: RunApplyBoundary::RunStart,
                contributing_input_ids: primitive.contributing_input_ids().to_vec(),
                conversation_digest: None,
                message_count: 0,
            },
            None,
            result(&self.0),
        ))
    }
    async fn cancel_after_boundary(&mut self, _: String) -> Result<(), CoreExecutorError> {
        Ok(())
    }
    async fn stop_runtime_executor(&mut self, _: String) -> Result<(), CoreExecutorError> {
        Ok(())
    }
}

fn run_frame(session: &SessionId, run: &RunId) -> ConsoleFrame {
    let mut frame = admission(session, InteractionId::new());
    frame.id = "native-run-start".into();
    frame.kind = "run_started".into();
    frame.source.kind = ConsoleFrameSourceKind::ConsoleEvent;
    frame.source_event_id = Some("native-event".into());
    frame.interaction_id = None;
    frame.run_id = Some(run.to_string());
    frame.payload = json!({"source_event_type":"run_started"});
    frame
}

#[tokio::test]
async fn native_run_start_completion_uses_real_receipt_and_survives_cold_read() {
    let store = Arc::new(meerkat_runtime::store::InMemoryRuntimeStore::new());
    let machine = Arc::new(MeerkatMachine::persistent(
        store.clone(),
        Arc::new(meerkat_store::MemoryBlobStore::new()),
    ).unwrap());
    let session = SessionId::new();
    machine
        .register_session_with_executor(session.clone(), Box::new(ResultExecutor(session.clone())))
        .await
        .unwrap();
    let input_id = InputId::new();
    let input = Input::Prompt(PromptInput {
        header: InputHeader {
            id: input_id.clone(),
            timestamp: chrono::Utc::now(),
            source: InputOrigin::Operator,
            durability: InputDurability::Durable,
            visibility: InputVisibility::default(),
            idempotency_key: None,
            supersession_key: None,
            correlation_id: None,
            authority_association: None,
            ingress_context: None,
            retained_resume: None,
        },
        content: "Initial worker task".into(),
        typed_turn_appends: vec![],
        injected_context: vec![],
        turn_metadata: None,
    });
    let (_, handle) = machine
        .accept_input_with_completion(&session, input)
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), handle.unwrap().wait())
        .await
        .unwrap()
        .unwrap();
    let state = machine
        .input_state(&session, &input_id)
        .await
        .unwrap()
        .unwrap();
    let run = state.seed.last_run_id.unwrap();
    let frame = run_frame(&session, &run);
    let completion = read_runs(
        &machine,
        store.as_ref(),
        &target(&session),
        &[frame.clone()],
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        completion.identity,
        CompletionIdentity::RuntimeInput {
            session_id: session.to_string(),
            input_id: input_id.to_string(),
            run_id: run.to_string(),
        }
    );
    assert_eq!(completion.text, "Exact native result");
    assert_eq!(completion.status, "completed");
    let mut work = Map::new();
    merge(&mut work, Some(&completion), false);
    assert_eq!(work["latestCompletion"]["kind"], "runtime_input");
    assert!(work["latestCompletion"].get("interactionId").is_none());
    assert!(read_runs(
        &machine,
        store.as_ref(),
        &target(&SessionId::new()),
        &[frame.clone()]
    )
    .await
    .unwrap()
    .is_none());
    let cold = MeerkatMachine::persistent_without_blobs(store.clone()).unwrap();
    let restored = read_runs(&cold, store.as_ref(), &target(&session), &[frame])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restored.identity, completion.identity);
    assert_eq!(restored.timestamp_ms, completion.timestamp_ms);
    assert_eq!(restored.evidence["witness"], "durable_store");
    let previous = work.clone();
    merge(&mut work, Some(&restored), false);
    assert_eq!(work["latestCompletion"], previous["latestCompletion"]);
    // A console task in the same session keeps its actual interaction ID,
    // even when the run-start candidate is also visible.
    let console = admission(&session, InteractionId::new());
    let keyed_input = Input::Prompt(PromptInput {
        header: InputHeader {
            id: InputId::new(),
            timestamp: chrono::Utc::now(),
            source: InputOrigin::Operator,
            durability: InputDurability::Durable,
            visibility: InputVisibility::default(),
            idempotency_key: Some(IdempotencyKey::new(console.id.clone())),
            supersession_key: None,
            correlation_id: None,
            authority_association: None,
            ingress_context: None,
            retained_resume: None,
        },
        content: "Later console task".into(),
        typed_turn_appends: vec![],
        injected_context: vec![],
        turn_metadata: None,
    });
    let keyed_id = keyed_input.id().clone();
    let (_, handle) = machine
        .accept_input_with_completion(&session, keyed_input)
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), handle.unwrap().wait())
        .await
        .unwrap()
        .unwrap();
    let keyed_run = machine
        .input_state(&session, &keyed_id)
        .await
        .unwrap()
        .unwrap()
        .seed
        .last_run_id
        .unwrap();
    assert!(read_runs(
        &machine,
        store.as_ref(),
        &target(&session),
        &[run_frame(&session, &keyed_run)]
    )
    .await
    .unwrap()
    .is_none());
    assert_eq!(
        read_inputs(&machine, &target(&session), &[console.clone()])
            .await
            .unwrap()
            .unwrap()
            .identity,
        CompletionIdentity::Console(console.interaction_id.unwrap())
    );
    machine.retire_runtime(&session).await.unwrap();
}

#[test]
fn native_outcomes_keep_non_work_pending_and_report_extraction_failure() {
    let session = SessionId::new();
    assert_eq!(
        native_terminal(&session, &CompletionOutcome::CompletedWithoutResult).unwrap(),
        None
    );
    assert_eq!(
        native_terminal(
            &session,
            &CompletionOutcome::CallbackBatchPending {
                pending_tool_calls: vec![],
            }
        )
        .unwrap(),
        None
    );
    assert_eq!(
        native_terminal(&session, &CompletionOutcome::Cancelled).unwrap(),
        Some(("failed", "cancelled".into()))
    );
    assert!(native_terminal(
        &SessionId::new(),
        &CompletionOutcome::Completed(Box::new(result(&session)))
    )
    .is_err());
    let mut invalid = result(&session);
    invalid.extraction_error = Some(meerkat_core::types::ExtractionError {
        last_output: "Invalid result".into(),
        attempts: 1,
        reason: "Schema failure".into(),
    });
    assert_eq!(
        native_terminal(&session, &CompletionOutcome::Completed(Box::new(invalid)))
            .unwrap()
            .unwrap()
            .0,
        "failed"
    );
}
