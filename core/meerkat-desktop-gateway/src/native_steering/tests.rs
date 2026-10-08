use super::*;

fn target(session: &SessionId) -> ConsoleExpectedTarget {
    ConsoleExpectedTarget {
        identity: "worker".into(),
        runtime_key: "default".into(),
        runtime_member_id: "worker".into(),
        session_id: Some(session.to_string()),
        source_mob_id: Some("child".into()),
    }
}

#[test]
fn receipt_and_replay_key_preserve_exact_member_session_and_child() {
    let session = SessionId::new();
    let expected = target(&session);
    let key = native_key("mob", &expected, "request").unwrap();
    assert!(key.starts_with(KEY_PREFIX));
    for changed in [
        ConsoleExpectedTarget {
            identity: "other".into(),
            ..expected.clone()
        },
        ConsoleExpectedTarget {
            runtime_key: "other".into(),
            ..expected.clone()
        },
        ConsoleExpectedTarget {
            runtime_member_id: "other".into(),
            ..expected.clone()
        },
        ConsoleExpectedTarget {
            session_id: Some(SessionId::new().to_string()),
            ..expected.clone()
        },
        ConsoleExpectedTarget {
            source_mob_id: Some("other".into()),
            ..expected.clone()
        },
    ] {
        assert_ne!(native_key("mob", &changed, "request").unwrap(), key);
    }
    assert_ne!(native_key("other", &expected, "request").unwrap(), key);
    assert_ne!(native_key("mob", &expected, "other").unwrap(), key);
    let receipt = accepted(&expected, &session, &InputId::new(), "request", &key);
    assert_eq!(receipt["sessionId"], session.to_string());
    assert_eq!(receipt["kind"], "runtime_input");
    assert!(receipt.get("interaction_id").is_none());
    assert!(receipt.get("input_frame_id").is_none());
}

#[test]
fn completion_is_not_success_for_another_session_or_unresolved_callback() {
    use meerkat_runtime::completion::CompletionOutcome;
    let session = SessionId::new();
    let mut result: meerkat_core::RunResult = serde_json::from_value(json!({
        "session_id":SessionId::new(), "text":"Done", "usage":meerkat_core::Usage::default(),
        "turns":1, "tool_calls":0,
    }))
    .unwrap();
    assert!(matches!(
        completion_result(
            &session,
            Ok(CompletionOutcome::Completed(Box::new(result.clone())))
        ),
        Err(crate::RunFailure::Failed(_))
    ));
    result.session_id = session.clone();
    assert!(
        completion_result(&session, Ok(CompletionOutcome::Completed(Box::new(result)))).is_ok()
    );
    assert!(completion_result(&session, Ok(CompletionOutcome::CompletedWithoutResult)).is_ok());
    assert!(matches!(
        completion_result(&session, Ok(CompletionOutcome::Cancelled)),
        Err(crate::RunFailure::Cancelled)
    ));
    assert!(matches!(
        completion_result(
            &session,
            Ok(CompletionOutcome::CallbackBatchPending {
                pending_tool_calls: vec![]
            })
        ),
        Err(crate::RunFailure::Failed(_))
    ));
}

#[tokio::test]
async fn cold_receipt_is_read_only_and_binds_the_native_input() {
    use meerkat_runtime::SessionServiceRuntimeExt;
    let root = std::env::temp_dir().join(format!("typed-steer-receipt-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let session = SessionId::new();
    let expected = target(&session);
    let params = json!({"projectPath":root,"stateRoot":root,"mobId":"root-mob","idempotencyKey":"request",
        "expected":{"identity":expected.identity,"runtimeKey":expected.runtime_key,"runtimeMemberId":expected.runtime_member_id,
            "sessionId":expected.session_id,"sourceMobId":expected.source_mob_id}});
    assert_eq!(read_receipt(Some(&params)).await.unwrap()["found"], false);
    let state = root.join("mobkit/root-mob");
    assert!(!state.exists(), "cold miss cannot create native stores");
    std::fs::create_dir_all(&state).unwrap();
    let store = std::sync::Arc::new(
        meerkat_runtime::store::SqliteRuntimeStore::new(state.join("runtime.sqlite")).unwrap(),
    );
    let machine = meerkat_runtime::MeerkatMachine::persistent_without_blobs(store);
    machine.register_session(session.clone()).await.unwrap();
    let key = native_key("root-mob", &expected, "request").unwrap();
    let prompt = input("Current-run correction".into(), key.clone());
    let input_id = prompt.id().clone();
    machine.accept_input(&session, prompt).await.unwrap();
    drop(machine);
    assert_eq!(
        read_receipt(Some(&params)).await.unwrap()["receipt"],
        accepted(&expected, &session, &input_id, "request", &key)
    );
    let mut replacement = params.clone();
    replacement["expected"]["sourceMobId"] = json!("other-child");
    assert_eq!(
        read_receipt(Some(&replacement)).await.unwrap()["found"],
        false
    );
    std::fs::remove_dir_all(root).unwrap();
}
