use super::*;
use meerkat_core::{types::HandlingMode, InputId, Usage};
use meerkat_runtime::{
    identifiers::IdempotencyKey,
    input::{Input, InputDurability, InputHeader, InputOrigin, InputVisibility, PromptInput},
};

fn result(session: &SessionId) -> meerkat_core::RunResult {
    serde_json::from_value(json!({
        "session_id":session,"text":"Exact native result", "usage":Usage::default(),
        "turns":1,"tool_calls":0,
    }))
    .unwrap()
}

fn admission(session: &SessionId, interaction: InteractionId) -> ConsoleFrame {
    serde_json::from_value(json!({
        "cursor":"console:1","id":"accepted-input-frame","dedupe_key":"send:key",
        "timestamp_ms":1,"runtime_key":"default","identity":"reviewer",
        "session_id":session,"kind":"user_input","status":"delivered","frame_version":1,
        "payload":{"handling_mode":"queue","content":"Review"},
        "source":{"kind":"send"},"interaction_id":interaction,
    }))
    .unwrap()
}

fn target(session: &SessionId) -> ConsoleExpectedTarget {
    ConsoleExpectedTarget {
        identity: "reviewer".into(),
        runtime_key: "default".into(),
        runtime_member_id: "reviewer".into(),
        session_id: Some(session.to_string()),
        source_mob_id: None,
    }
}

#[test]
fn receipt_projection_rejects_foreign_sessions_and_non_work_boundaries() {
    let session = SessionId::new();
    let interaction = InteractionId::new();
    assert_eq!(
        terminal(
            &session,
            interaction,
            CompletionOutcome::Completed(Box::new(result(&session)))
        )
        .unwrap(),
        Some(("completed", "Exact native result".into()))
    );
    assert!(terminal(
        &SessionId::new(),
        interaction,
        CompletionOutcome::Completed(Box::new(result(&session)))
    )
    .is_err());
    for outcome in [
        CompletionOutcome::CompletedWithoutResult,
        CompletionOutcome::CallbackPending {
            tool_use_id: "callback".into(),
            tool_name: "decision".into(),
            args: json!({}),
        },
        CompletionOutcome::CallbackBatchPending {
            pending_tool_calls: vec![],
        },
    ] {
        assert!(terminal(&session, interaction, outcome).unwrap().is_none());
    }
    assert_eq!(
        terminal(&session, interaction, CompletionOutcome::Cancelled).unwrap(),
        Some(("failed", "cancelled".into()))
    );
    let mut failed = result(&session);
    failed.extraction_error = Some(meerkat_core::types::ExtractionError {
        last_output: "Unusable answer".into(),
        attempts: 2,
        reason: "Schema rejected".into(),
    });
    assert_eq!(
        terminal(
            &session,
            interaction,
            CompletionOutcome::Completed(Box::new(failed))
        )
        .unwrap()
        .unwrap()
        .0,
        "failed"
    );
}

#[test]
fn admissions_require_exact_session_runtime_and_native_send_origin() {
    let session = SessionId::new();
    let interaction = InteractionId::new();
    let original = admission(&session, interaction);
    let expected = target(&session);
    assert!(exact_admission(&original, &expected));
    let mut changed = original.clone();
    changed.session_id = Some(SessionId::new().to_string());
    assert!(!exact_admission(&changed, &expected));
    let mut changed = original.clone();
    changed.runtime_key = "replacement".into();
    assert!(!exact_admission(&changed, &expected));
    let mut changed = original.clone();
    changed.source.kind = ConsoleFrameSourceKind::SessionHistory;
    assert!(!exact_admission(&changed, &expected));
    let mut changed = original.clone();
    changed.payload["handling_mode"] = json!("steer");
    assert!(!exact_admission(&changed, &expected));
    let mut changed = original;
    changed.interaction_id = None;
    assert!(!exact_admission(&changed, &expected));
}

#[tokio::test]
async fn real_runtime_receipts_keep_pending_distinct_and_bind_the_accepted_key() {
    let machine = MeerkatMachine::ephemeral();
    let session = SessionId::new();
    machine.register_session(session.clone()).await.unwrap();
    let frame = admission(&session, InteractionId::new());
    let input_id = InputId::new();
    let input = Input::Prompt(PromptInput {
        header: InputHeader {
            id: input_id.clone(),
            timestamp: chrono::Utc::now(),
            source: InputOrigin::Operator,
            durability: InputDurability::Durable,
            visibility: InputVisibility::default(),
            idempotency_key: Some(IdempotencyKey::new(frame.id.clone())),
            supersession_key: None,
            correlation_id: None,
            authority_association: None,
            ingress_context: None,
            retained_resume: None,
        },
        content: "Review".into(),
        typed_turn_appends: vec![],
        injected_context: vec![],
        turn_metadata: Some(
            meerkat_core::lifecycle::run_primitive::RuntimeTurnMetadata {
                handling_mode: Some(HandlingMode::Queue),
                ..Default::default()
            },
        ),
    });
    machine.accept_input(&session, input).await.unwrap();
    let expected = target(&session);
    assert!(read_inputs(&machine, &expected, &[frame.clone()])
        .await
        .unwrap()
        .is_none());
    machine.retire_runtime(&session).await.unwrap();
    let completion = read_inputs(&machine, &expected, &[frame.clone()])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(completion.status, "failed");
    assert_eq!(completion.evidence["inputId"], input_id.to_string());
    assert_eq!(completion.evidence["inputFrameId"], frame.id);
    assert_eq!(
        completion.identity,
        CompletionIdentity::Console(frame.interaction_id.clone().unwrap())
    );
    let again = read_inputs(&machine, &expected, &[frame.clone()])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(again.evidence, completion.evidence);
    let mut unrelated = frame.clone();
    unrelated.id = "other-accepted-input".into();
    assert!(read_inputs(&machine, &expected, &[unrelated])
        .await
        .unwrap()
        .is_none());
    assert!(read_inputs(&machine, &target(&SessionId::new()), &[frame])
        .await
        .unwrap()
        .is_none());
    let unknown = SessionId::new();
    assert!(read_inputs(
        &machine,
        &target(&unknown),
        &[admission(&unknown, InteractionId::new())]
    )
    .await
    .is_err());
}

#[test]
fn duplicate_observation_preserves_live_completion_and_new_work_hides_old_outcome() {
    let mut completion = Completion {
        identity: CompletionIdentity::Console("exact-interaction".into()),
        status: "completed",
        timestamp_ms: 20,
        text: "Result".into(),
        is_latest_input: true,
        input_timestamp_ms: 1,
        evidence: json!({"source":"runtime_input_receipt"}),
    };
    let mut work = Map::new();
    merge(&mut work, Some(&completion), false);
    let once = work.clone();
    merge(&mut work, Some(&completion), false);
    assert_eq!(work, once);
    work.insert(
        "latestCompletion".into(),
        json!({"interactionId":"exact-interaction","status":"completed","timestampMs":19}),
    );
    merge(&mut work, Some(&completion), false);
    assert_eq!(work["latestCompletion"]["timestampMs"], 19);
    work.insert("outcome".into(), json!("Previous visible result"));
    completion.is_latest_input = false;
    merge(&mut work, Some(&completion), false);
    assert!(!work.contains_key("outcome"));
    completion.is_latest_input = true;
    merge(&mut work, Some(&completion), true);
    assert!(!work.contains_key("outcome"));
    work.insert(
        "latestCompletion".into(),
        json!({"interactionId":"newer-peer","timestampMs":30}),
    );
    merge(&mut work, Some(&completion), false);
    assert_eq!(work["latestCompletion"]["interactionId"], "newer-peer");
    assert!(!work.contains_key("outcome"));
}

#[tokio::test]
async fn bounded_admission_query_survives_long_runs_and_reports_storage_faults() {
    use meerkat_mobkit::{ConsoleLogStore, NewConsoleFrame, SqliteConsoleLogStore};
    let root = std::env::temp_dir().join(format!("native-receipt-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("console.sqlite");
    let store = SqliteConsoleLogStore::open(&path).unwrap();
    let session = SessionId::new();
    for index in 1..=124 {
        let mut frame = admission(&session, InteractionId::new());
        frame.id = format!("frame-{index}");
        frame.dedupe_key = format!("key-{index}");
        frame.timestamp_ms = index;
        if index > 20 && index <= 120 {
            frame.kind = "text_delta".into();
            frame.source.kind = ConsoleFrameSourceKind::ConsoleEvent;
        }
        if index == 19 {
            frame.kind = "run_started".into();
            frame.source.kind = ConsoleFrameSourceKind::ConsoleEvent;
            frame.source_event_id = Some("native-start".into());
            frame.run_id = Some(RunId::new().to_string());
            frame.interaction_id = None;
            frame.payload = json!({"source_event_type":"run_started"});
        }
        match index {
            121 => frame.session_id = Some(SessionId::new().to_string()),
            122 => frame.runtime_key = "other-runtime".into(),
            123 => frame.payload["handling_mode"] = json!("steer"),
            124 => frame.source.kind = ConsoleFrameSourceKind::SessionHistory,
            _ => {}
        }
        store
            .append_if_absent(NewConsoleFrame {
                id: Some(frame.id),
                dedupe_key: frame.dedupe_key,
                timestamp_ms: frame.timestamp_ms,
                runtime_key: frame.runtime_key,
                identity: frame.identity,
                conversation_id: frame.conversation_id,
                session_id: frame.session_id,
                kind: frame.kind,
                status: frame.status,
                payload: frame.payload,
                source: frame.source,
                source_event_id: frame.source_event_id,
                interaction_id: frame.interaction_id,
                turn_id: frame.turn_id,
                run_id: frame.run_id,
                parent_frame_id: frame.parent_frame_id,
                caused_by_frame_id: frame.caused_by_frame_id,
            })
            .await
            .unwrap();
    }
    let console_read = Arc::new(
        crate::mobkit_registry::storage_upgrade::read_console(&root).unwrap(),
    );
    let runs = crate::native_history::recent_work_runs(console_read.clone(), target(&session))
        .await
        .unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].id, "frame-19");
    let inputs = crate::native_history::recent_work_inputs(console_read, target(&session))
        .await
        .unwrap();
    assert_eq!(inputs.len(), 16);
    assert_eq!(inputs.first().unwrap().id, "frame-20");
    assert_eq!(inputs.last().unwrap().id, "frame-4");
    assert!(inputs
        .iter()
        .all(|frame| exact_admission(frame, &target(&session))));
    let broken_root = root.join("corrupt");
    std::fs::create_dir_all(&broken_root).unwrap();
    let broken_path = broken_root.join("console.sqlite");
    std::fs::write(&broken_path, b"not a sqlite database").unwrap();
    let broken_read = Arc::new(
        crate::mobkit_registry::storage_upgrade::read_console(&broken_root).unwrap(),
    );
    assert!(
        crate::native_history::recent_work_inputs(broken_read, target(&session))
            .await
            .is_err()
    );
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[path = "native_tests.rs"]
mod native_tests;
