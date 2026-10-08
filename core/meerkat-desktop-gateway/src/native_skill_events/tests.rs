use std::{path::PathBuf, sync::Arc};

use meerkat_core::{
    event::{EventSourceIdentity, SkillResolutionFailureReason},
    skills::SkillKey,
    SessionId,
};
use serde_json::Value;
use tokio::sync::Mutex;
use uuid::Uuid;

use super::*;
use crate::{
    process_agent_event_envelope, project_run_event, LiveEventAssembler, RunEventProjection,
    RunFailure,
};

fn fixture_root() -> PathBuf {
    std::env::temp_dir().join(format!("native-skill-receipts-{}", Uuid::new_v4()))
}

fn keys() -> Vec<SkillKey> {
    serde_json::from_value(json!([
        {"source_uuid": "3cd3a2a1-44d7-4b4d-90e2-e28322d45f01", "skill_name": "review"},
        {"source_uuid": "3cd3a2a1-44d7-4b4d-90e2-e28322d45f02", "skill_name": "review"},
    ]))
    .unwrap()
}

fn attribution(root: PathBuf, session: &SessionId) -> Attribution {
    Attribution {
        state_root: root,
        thread_id: "thread".into(),
        mob_id: "mob".into(),
        session_id: session.to_string(),
        run_id: "app-run".into(),
    }
}

fn envelope(session: &SessionId, payload: AgentEvent) -> EventEnvelope<AgentEvent> {
    let mut event = EventEnvelope::new_session(session.clone(), 17, Some("mob".into()), payload);
    event.timestamp_ms = 1_790_000_000_123;
    event
}

fn resolved(session: &SessionId) -> EventEnvelope<AgentEvent> {
    envelope(
        session,
        AgentEvent::SkillsResolved {
            skills: keys(),
            injection_bytes: 321,
        },
    )
}

fn as_json(event: &EventEmit) -> Value {
    serde_json::to_value(event).unwrap()
}

#[test]
fn resolved_receipt_preserves_exact_source_before_run_started_with_stale_assembler() {
    let root = fixture_root();
    let session = SessionId::new();
    let event = resolved(&session);
    let mut state = LiveEventAssembler {
        native_session_id: Some("previous-session".into()),
        native_segment_id: Some("previous-segment".into()),
        assistant_delta_text: "previous assistant text".into(),
        delivery_scope: Some(attribution(root.clone(), &session)),
        ..Default::default()
    };
    let (tx, mut rx) = broadcast::channel(8);
    let mut emitted = false;

    assert!(!process_agent_event_envelope(
        &event,
        "thread",
        "app-run",
        &mut state,
        &tx,
        &mut emitted
    )
    .unwrap());
    let receipt = rx.try_recv().unwrap();
    let expected_source = format!("evt-agent-{}", event.event_id);
    let expected_id = format!("meerkat-output:app-run:{session}:{expected_source}");
    assert_eq!(receipt.kind, "skills.resolved");
    assert_eq!(receipt.event_id, expected_id);
    assert_eq!(receipt.trace_id, expected_id);
    assert_eq!(receipt.thread_id.as_deref(), Some("thread"));
    assert_eq!(receipt.run_id.as_deref(), Some("app-run"));
    assert_eq!(
        receipt.timestamp.timestamp_millis(),
        event.timestamp_ms as i64
    );
    assert_eq!(
        receipt.payload["nativeEvent"],
        serde_json::to_value(&event).unwrap()
    );
    assert_eq!(receipt.payload["nativeSourceEventId"], expected_source);
    assert_eq!(receipt.payload["nativeSessionId"], session.to_string());
    assert_eq!(receipt.payload["nativeDeliveryId"], expected_id);
    assert_eq!(
        receipt.payload["nativeEvent"]["payload"]["skills"],
        json!(keys())
    );
    assert!(receipt.payload.get("nativeSegmentId").is_none());
    assert!(receipt.payload.get("text").is_none());
    assert!(receipt.payload.get("textDelta").is_none());
    assert!(emitted);
    assert!(!state.assistant_delta_emitted);
    assert!(!state.assistant_final_emitted);
    assert_eq!(state.assistant_delta_text, "previous assistant text");
    assert!(rx.try_recv().is_err());
    assert_eq!(
        as_json(&thread_deliveries::read(&root, "thread", "mob").unwrap()[0]),
        as_json(&receipt)
    );
    assert!(
        !root.join("thread-followups").exists(),
        "a resolution receipt must not record an assistant followup"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn failure_receipts_preserve_nested_reason_and_optional_key_without_ending_run() {
    let root = fixture_root();
    let session = SessionId::new();
    let key = keys()[1].clone();
    let failures = [
        AgentEvent::SkillResolutionFailed {
            skill_key: Some(key.clone()),
            reason: SkillResolutionFailureReason::NotFound { key },
        },
        AgentEvent::SkillResolutionFailed {
            skill_key: None,
            reason: SkillResolutionFailureReason::RemapWithoutLineage {
                from_source_uuid: "3cd3a2a1-44d7-4b4d-90e2-e28322d45f01".into(),
                from_skill_name: "review".into(),
                to_source_uuid: "3cd3a2a1-44d7-4b4d-90e2-e28322d45f02".into(),
                to_skill_name: "review".into(),
            },
        },
    ];
    let (tx, mut rx) = broadcast::channel(8);
    let mut state = LiveEventAssembler {
        delivery_scope: Some(attribution(root.clone(), &session)),
        ..Default::default()
    };
    for failure in failures {
        let event = envelope(&session, failure);
        let mut emitted = false;
        assert!(!process_agent_event_envelope(
            &event,
            "thread",
            "app-run",
            &mut state,
            &tx,
            &mut emitted
        )
        .unwrap());
        let receipt = rx.try_recv().unwrap();
        assert_eq!(receipt.kind, "skills.resolution-failed");
        assert_eq!(
            receipt.payload["nativeEvent"],
            serde_json::to_value(&event).unwrap()
        );
        assert!(emitted);
        assert!(!state.assistant_final_emitted);
        assert!(
            rx.try_recv().is_err(),
            "skill failure must not synthesize a terminal event"
        );
    }
    assert_eq!(
        thread_deliveries::read(&root, "thread", "mob")
            .unwrap()
            .len(),
        2
    );
    assert!(!root.join("thread-followups").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn duplicate_and_cold_projection_keep_stable_delivery_identity() {
    let root = fixture_root();
    let session = SessionId::new();
    let scope = attribution(root.clone(), &session);
    let projection = Arc::new(Mutex::new(RunEventProjection {
        delivery_scope: Some(scope.clone()),
        ..Default::default()
    }));
    let event = resolved(&session);
    let (tx, mut rx) = broadcast::channel(8);
    assert!(
        !project_run_event(&projection, &event, "thread", "app-run", &tx)
            .await
            .unwrap()
    );
    let first = rx.try_recv().unwrap();
    assert!(
        !project_run_event(&projection, &event, "thread", "app-run", &tx)
            .await
            .unwrap()
    );
    assert!(rx.try_recv().is_err());
    let cold = Arc::new(Mutex::new(RunEventProjection {
        delivery_scope: Some(scope),
        ..Default::default()
    }));
    assert!(!project_run_event(&cold, &event, "thread", "app-run", &tx)
        .await
        .unwrap());
    assert_eq!(as_json(&rx.try_recv().unwrap()), as_json(&first));
    assert_eq!(
        thread_deliveries::read(&root, "thread", "mob")
            .unwrap()
            .len(),
        1
    );
    let mut distinct = event.clone();
    distinct.event_id = Uuid::new_v4();
    distinct.seq += 1;
    assert!(
        !project_run_event(&cold, &distinct, "thread", "app-run", &tx)
            .await
            .unwrap()
    );
    assert_ne!(rx.try_recv().unwrap().event_id, first.event_id);
    assert_eq!(
        thread_deliveries::read(&root, "thread", "mob")
            .unwrap()
            .len(),
        2
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn failed_durable_write_retains_original_envelope_for_retry() {
    let root = fixture_root();
    std::fs::write(&root, b"block outbox directory creation").unwrap();
    let session = SessionId::new();
    let event = resolved(&session);
    let projection = Arc::new(Mutex::new(RunEventProjection {
        delivery_scope: Some(attribution(root.clone(), &session)),
        ..Default::default()
    }));
    let (tx, mut rx) = broadcast::channel(8);
    for _ in 0..2 {
        assert!(matches!(
            project_run_event(&projection, &event, "thread", "app-run", &tx).await,
            Err(RunFailure::Delivery(_))
        ));
        let state = projection.lock().await;
        assert!(!state.seen.contains(&event.event_id));
        assert!(!state.emitted);
        assert!(state.followup_failed);
        assert_eq!(
            serde_json::to_value(&state.pending_events).unwrap(),
            json!([event])
        );
        assert!(
            rx.try_recv().is_err(),
            "receipt must be durable before broadcast"
        );
    }
    std::fs::remove_file(&root).unwrap();
    let pending = projection.lock().await.pending_events.clone();
    for pending_event in pending {
        assert!(
            !project_run_event(&projection, &pending_event, "thread", "app-run", &tx)
                .await
                .unwrap()
        );
    }
    let receipt = rx.try_recv().unwrap();
    assert_eq!(
        receipt.event_id,
        format!(
            "meerkat-output:app-run:{session}:evt-agent-{}",
            event.event_id
        )
    );
    assert_eq!(
        receipt.payload["nativeEvent"],
        serde_json::to_value(&event).unwrap()
    );
    let state = projection.lock().await;
    assert!(state.seen.contains(&event.event_id));
    assert!(state.pending_events.is_empty());
    assert!(!state.followup_failed);
    assert!(state.emitted);
    drop(state);
    assert_eq!(
        as_json(&thread_deliveries::read(&root, "thread", "mob").unwrap()[0]),
        as_json(&receipt)
    );
    assert!(!root.join("thread-followups").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_or_conflicting_provenance_cannot_fall_back_to_assembler_identity() {
    let root = fixture_root();
    let session = SessionId::new();
    let scope = attribution(root.clone(), &session);
    let original = resolved(&session);
    let mut missing_source = original.clone();
    missing_source.source = EventSourceIdentity::Callback;
    let mut wrong_session = original.clone();
    wrong_session.source = EventSourceIdentity::session(SessionId::new());
    let mut invalid_timestamp = original.clone();
    invalid_timestamp.timestamp_ms = u64::MAX;
    let cases = [
        (missing_source, Some(scope.clone()), "thread", "app-run"),
        (wrong_session, Some(scope.clone()), "thread", "app-run"),
        (original.clone(), None, "thread", "app-run"),
        (
            original.clone(),
            Some(scope.clone()),
            "other-thread",
            "app-run",
        ),
        (original, Some(scope.clone()), "thread", "other-run"),
        (invalid_timestamp, Some(scope), "thread", "app-run"),
    ];
    let (tx, mut rx) = broadcast::channel(8);
    for (event, delivery_scope, thread, run) in cases {
        let mut state = LiveEventAssembler {
            native_session_id: Some(session.to_string()),
            native_segment_id: Some("apparently-current-segment".into()),
            delivery_scope,
            ..Default::default()
        };
        let mut emitted = false;
        assert!(matches!(
            process_agent_event_envelope(&event, thread, run, &mut state, &tx, &mut emitted),
            Err(RunFailure::Delivery(_))
        ));
        assert!(!emitted);
        assert!(rx.try_recv().is_err());
        assert!(
            !root.exists(),
            "invalid provenance must not create a durable receipt"
        );
    }
}

#[test]
fn absent_listener_keeps_native_receipt_in_existing_outbox() {
    let root = fixture_root();
    let session = SessionId::new();
    let event = resolved(&session);
    let scope = attribution(root.clone(), &session);
    let (tx, rx) = broadcast::channel(1);
    drop(rx);
    emit(&event, "thread", "app-run", Some(&scope), &tx).unwrap();
    let deliveries = thread_deliveries::read(&root, "thread", "mob").unwrap();
    assert_eq!(deliveries.len(), 1);
    assert_eq!(
        deliveries[0].payload["nativeEvent"],
        serde_json::to_value(event).unwrap()
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn custom_coordinator_and_domain_target_finalize_durably_without_peer_followup_capture() {
    for identity in ["coordinator", "reviewer"] {
        let root = fixture_root();
        let state_root = root.join("state");
        std::fs::create_dir_all(&root).unwrap();
        let session = SessionId::new();
        let gateway = crate::MeerkatGateway::new();
        let handle = gateway
            .project_runtime_handle_for_paths(
                root.to_str().unwrap(),
                root.to_str().unwrap(),
                "local".into(),
                Some(state_root.to_str().unwrap()),
            )
            .await
            .unwrap();
        let mut state = RunEventProjection::default();
        state
            .bind_input_attribution(identity, attribution(state_root.clone(), &session))
            .unwrap();
        assert_eq!(
            state.delivery_scope.as_ref().unwrap().session_id,
            session.to_string()
        );
        assert!(state.followup.is_none());
        let projection = Arc::new(Mutex::new(state));
        handle.state.lock().await.active_runs.insert(
            "thread".into(),
            crate::ActiveRun {
                run_id: "app-run".into(),
                mob_id: "mob".into(),
                agent_identity: identity.into(),
                started_at: Utc::now(),
                deliveries: crate::AppRunDeliveries::default(),
                projection: Arc::clone(&projection),
            },
        );
        let mut events = gateway.subscribe_events();
        let resolution = resolved(&session);
        assert!(!project_run_event(
            &projection,
            &resolution,
            "thread",
            "app-run",
            &gateway.inner.events_tx
        )
        .await
        .unwrap());
        assert_eq!(events.try_recv().unwrap().kind, "skills.resolved");
        let terminal = envelope(
            &session,
            AgentEvent::RunCompleted {
                identity: Default::default(),
                assistant_message_id: None,
                session_id: session.clone(),
                result: "custom target result".into(),
                structured_output: None,
                extraction_required: false,
                usage: Default::default(),
                terminal_cause_kind: None,
            },
        );
        assert!(project_run_event(
            &projection,
            &terminal,
            "thread",
            "app-run",
            &gateway.inner.events_tx
        )
        .await
        .unwrap());
        assert_eq!(events.try_recv().unwrap().kind, "run.output.complete");
        crate::finish_run(
            &gateway.inner.events_tx,
            &handle,
            "thread",
            "app-run",
            "mob",
            identity,
            root.to_str().unwrap(),
            root.to_str().unwrap(),
            "local",
            gateway.inner.host_tools.as_ref(),
            Ok(()),
        )
        .await;
        let completed = events.try_recv().unwrap();
        assert_eq!(completed.kind, "run.completed");
        assert_eq!(completed.payload["agentIdentity"], identity);
        assert!(events.try_recv().is_err());
        assert!(
            handle.state.lock().await.active_runs.is_empty(),
            "the next target turn must not remain blocked"
        );
        assert_eq!(
            crate::lookup_terminal_run(&state_root, "app-run").unwrap()["status"],
            "completed"
        );
        let projection_state = projection.lock().await;
        assert!(projection_state.pending_events.is_empty());
        assert!(!projection_state.followup_failed);
        assert!(projection_state.followup.is_none());
        assert!(projection_state.assembler.followup_scope.is_none());
        drop(projection_state);
        let saved = thread_deliveries::read(&state_root, "thread", "mob").unwrap();
        assert_eq!(saved.len(), 3);
        let receipt = saved
            .iter()
            .find(|event| event.kind == "skills.resolved")
            .unwrap();
        assert_eq!(
            receipt.payload["nativeEvent"],
            serde_json::to_value(&resolution).unwrap()
        );
        assert_eq!(receipt.payload["nativeSessionId"], session.to_string());
        assert!(saved.iter().any(|event| event.kind == "run.output.complete"
            && event.payload["text"] == "custom target result"));
        assert!(saved.iter().any(|event| event.kind == "run.completed"));
        assert!(
            !state_root.join("thread-followups").exists(),
            "durable target output must not enroll the target for peer followup capture"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn default_coordinator_keeps_existing_peer_followup_boundary() {
    let root = fixture_root();
    let session = SessionId::new();
    let mut state = RunEventProjection::default();
    state
        .bind_input_attribution("ingress", attribution(root.clone(), &session))
        .unwrap();
    assert_eq!(
        state.delivery_scope.as_ref().unwrap().session_id,
        session.to_string()
    );
    assert_eq!(
        state.followup.as_ref().unwrap().session_id,
        session.to_string()
    );
    assert!(root.join("thread-followups").exists());
    std::fs::remove_dir_all(root).unwrap();
}
