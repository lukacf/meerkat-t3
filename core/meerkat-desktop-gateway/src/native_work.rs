//! Compact work projection from native interaction frames and session metadata.
use crate::mobkit_registry::{ConsoleExpectedTarget, MobkitMobRuntime};
use meerkat_mobkit::ConsoleFrame;
use serde_json::{json, Map, Value};
use std::{future::Future, sync::Arc, time::Duration};
use tokio::time::Instant;

mod completion;
mod model;
pub(crate) use model::project as project_current_model;

fn short_text(value: &Value) -> Option<String> {
    let text = if let Some(text) = value.as_str() {
        text.to_string()
    } else if let Some(blocks) = value.as_array() {
        blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        return None;
    };
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then(|| text.chars().take(400).collect())
}
// `frames` has already passed the durable exact-session query. Sessionless
// frames retain their native shape and belong through an unambiguous native
// interaction anchor, which may be older than this recent page.
fn project(
    frames: &[ConsoleFrame],
    expected: &ConsoleExpectedTarget,
    busy: bool,
    active_runs: &[String],
) -> Map<String, Value> {
    let mut out = Map::new();
    let mut exact = frames
        .iter()
        .filter(|frame| {
            frame.identity == expected.identity
                && frame.runtime_key == expected.runtime_key
                && (frame.session_id == expected.session_id || frame.session_id.is_none())
        })
        .collect::<Vec<_>>();
    exact.sort_by_key(|frame| frame.timestamp_ms);
    let latest_input = exact.iter().rev().find(|frame| frame.kind == "user_input");
    let objective_input = if busy {
        exact.iter().rev().find(|frame| {
            frame.kind == "user_input"
                && frame
                    .run_id
                    .as_ref()
                    .is_some_and(|run| active_runs.contains(run))
        })
    } else {
        latest_input
    };
    if let Some(frame) = objective_input {
        if let Some(text) = frame.payload.get("content").and_then(short_text) {
            out.insert("objective".into(), json!(text));
        }
        if busy {
            if let Some(id) = &frame.interaction_id {
                out.insert("interactionId".into(), json!(id));
            }
        }
    }
    if let Some(frame) = exact.iter().rev().find(|frame| {
        matches!(
            frame.kind.as_str(),
            "interaction_complete" | "interaction_failed"
        ) && frame.interaction_id.is_some()
            && frame.payload.get("handling_mode").and_then(Value::as_str) != Some("steer")
            && frame.payload.get("reason").and_then(Value::as_str) != Some("steer_delivered")
            && frame
                .payload
                .get("source_event_type")
                .and_then(Value::as_str)
                != Some("session_history")
            && frame.payload.get("type").and_then(Value::as_str) != Some("session_history")
    }) {
        out.insert("latestCompletion".into(),json!({"interactionId":frame.interaction_id,"status":if frame.kind=="interaction_complete" {"completed"} else {"failed"},"timestampMs":frame.timestamp_ms}));
        if !busy && latest_input.is_none_or(|input| input.timestamp_ms <= frame.timestamp_ms) {
            if let Some(text) = frame
                .payload
                .get("result")
                .or_else(|| frame.payload.get("error"))
                .and_then(short_text)
            {
                out.insert("outcome".into(), json!(text));
            }
        }
    }
    out
}
async fn before_deadline<T>(deadline: Instant, read: impl Future<Output = T>) -> Option<T> {
    tokio::time::timeout_at(deadline, read).await.ok()
}

async fn active_inputs(
    mob: &MobkitMobRuntime,
    expected: &ConsoleExpectedTarget,
    busy: bool,
) -> (Vec<String>, Vec<(u64, String)>) {
    let mut active_runs = Vec::new();
    let mut active_objectives = Vec::new();
    if busy {
        if let (Some(runtime), Some(session)) = (&mob.session_runtime, &expected.session_id) {
            if let Ok(session_id) =
                serde_json::from_value::<meerkat_core::SessionId>(json!(session))
            {
                use meerkat_runtime::{input_state::InputLifecycleState, SessionServiceRuntimeExt};
                if let Ok(inputs) = runtime.list_active_inputs(&session_id).await {
                    for input in inputs {
                        if let Ok(Some(state)) = runtime.input_state(&session_id, &input).await {
                            if matches!(
                                state.seed.phase,
                                InputLifecycleState::Staged
                                    | InputLifecycleState::Applied
                                    | InputLifecycleState::AppliedPendingConsumption
                            ) {
                                let content = match state.state.persisted_input.as_ref() {
                                    Some(meerkat_runtime::input::Input::Prompt(input)) => {
                                        Some(&input.content)
                                    }
                                    Some(meerkat_runtime::input::Input::Peer(input)) => {
                                        Some(&input.content)
                                    }
                                    Some(meerkat_runtime::input::Input::FlowStep(input)) => {
                                        Some(&input.content)
                                    }
                                    _ => None,
                                };
                                if let Some(text) = content
                                    .and_then(|content| serde_json::to_value(content).ok())
                                    .as_ref()
                                    .and_then(short_text)
                                {
                                    active_objectives
                                        .push((state.seed.admission_sequence.unwrap_or(0), text));
                                }
                                if let Some(run) = state.seed.last_run_id {
                                    active_runs.push(run.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    (active_runs, active_objectives)
}

async fn current_model(
    mob: &MobkitMobRuntime,
    expected: &ConsoleExpectedTarget,
) -> Option<meerkat_core::SessionLlmIdentity> {
    if let (Some(runtime), Some(session)) = (&mob.runtime, &expected.session_id) {
        if let (Some(service), Ok(session_id)) = (
            runtime.mob_runtime().session_service(),
            serde_json::from_value::<meerkat_core::SessionId>(json!(session)),
        ) {
            if let Ok(Some(metadata)) = service.load_persisted_session_metadata(&session_id).await {
                if let Some(metadata) = metadata.session_metadata {
                    return Some(metadata.llm_identity());
                }
            }
        }
    }
    None
}

async fn current_run(mob: &MobkitMobRuntime, expected: &ConsoleExpectedTarget) -> Option<String> {
    let runtime = mob.session_runtime.as_ref()?;
    let session = meerkat_core::SessionId::parse(expected.session_id.as_deref()?).ok()?;
    let snapshot = runtime.meerkat_machine_archive_snapshot(&session).await?;
    (snapshot.control.phase == meerkat_runtime::RuntimeState::Running)
        .then_some(snapshot.control.current_run_id)
        .flatten()
        .map(|run| run.to_string())
}

pub(crate) async fn read(
    mob: &MobkitMobRuntime,
    expected: &ConsoleExpectedTarget,
    busy: bool,
    auth: Option<&crate::provider_auth::DesktopProviderAuth>,
) -> Result<Map<String, Value>, crate::GatewayError> {
    // Model/objective details are optional. Completion authority errors must
    // remain observable, and every read shares one bounded status deadline.
    let deadline = Instant::now() + Duration::from_secs(2);
    let console_read = Arc::new(crate::mobkit_registry::storage_upgrade::read_console(
        &mob.state_root.join("mobkit").join(crate::stable_slug(&mob.mob_id)),
    )?);
    let (active, frames, model, native_run, durable) = tokio::join!(
        before_deadline(deadline, active_inputs(mob, expected, busy)),
        before_deadline(
            deadline,
            crate::native_history::recent_frames(console_read.clone(), expected.clone())
        ),
        before_deadline(deadline, current_model(mob, expected)),
        before_deadline(deadline, current_run(mob, expected)),
        tokio::time::timeout_at(deadline, completion::read(mob, expected, console_read)),
    );
    let durable = durable.map_err(|_| {
        crate::GatewayError::conflict("Native completion evidence is not available yet", None)
    })??;
    let (active_runs, mut active_objectives) = active.unwrap_or_default();
    let mut out = frames
        .and_then(Result::ok)
        .map(|frames| project(&frames, expected, busy, &active_runs))
        .unwrap_or_default();
    completion::merge(&mut out, durable.as_ref(), busy);
    active_objectives.sort_by_key(|(sequence, _)| *sequence);
    if let Some((_, objective)) = active_objectives.last() {
        out.insert("objective".into(), json!(objective));
    }
    if let Some(identity) = model.flatten() {
        out.extend(project_current_model(&identity));
        if let Some(auth) = auth {
            // Keep model and auth provenance tied to this exact saved session
            // snapshot. Current provider defaults cannot describe pinned auth.
            let read_auth = async {
                let realm = crate::mobkit_registry::load_effective_realm_config(
                    &mob.checkpoint_project_path,
                    &mob.config_state_root,
                )
                .await
                .ok()?;
                (realm.realm_id.as_str() == mob.realm_id).then_some(())?;
                Some(auth.model_auth_status(&realm.effective, &realm.realm_id, &identity).await)
            };
            let model_auth = before_deadline(deadline, read_auth)
                .await
                .flatten()
                .unwrap_or_else(|| crate::provider_auth::DesktopProviderAuth::unknown_model_auth(&identity));
            out.insert("modelAuth".into(), model_auth);
        }
    }
    if busy {
        if let Some(run) = native_run.flatten() {
            out.insert("nativeRunId".into(), json!(run));
        }
    }
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    use meerkat_mobkit::{
        ConsoleFrameSource, ConsoleFrameSourceKind, ConsoleFrameStatus, ConsoleLogStore,
        NewConsoleFrame, SqliteConsoleLogStore,
    };

    #[tokio::test]
    async fn work_keeps_sessionless_terminal_with_an_anchor_before_the_recent_page() {
        let root = std::env::temp_dir().join(format!("native-work-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("console.sqlite");
        let store = SqliteConsoleLogStore::open(&path).unwrap();
        let target = ConsoleExpectedTarget {
            identity: "worker".into(),
            runtime_key: "runtime".into(),
            runtime_member_id: "worker".into(),
            session_id: Some("session".into()),
            source_mob_id: None,
        };
        for index in 1..=108 {
            let (session, interaction, kind) = match index {
                1 => (Some("session"), "failed", "user_input"),
                2 => (Some("session"), "ambiguous", "user_input"),
                3 => (Some("replacement"), "ambiguous", "user_input"),
                4 => (Some("replacement"), "foreign", "user_input"),
                105 => (None, "failed", "interaction_failed"),
                106 => (None, "ambiguous", "interaction_complete"),
                107 => (None, "foreign", "interaction_complete"),
                108 => (None, "unanchored", "interaction_complete"),
                _ => (Some("session"), "failed", "text_delta"),
            };
            store
                .append_if_absent(NewConsoleFrame {
                    id: Some(format!("frame-{index}")),
                    dedupe_key: format!("key-{index}"),
                    timestamp_ms: index,
                    runtime_key: "runtime".into(),
                    identity: "worker".into(),
                    conversation_id: None,
                    session_id: session.map(str::to_string),
                    kind: kind.into(),
                    status: ConsoleFrameStatus::Completed,
                    payload: json!({"error":"Native failure"}),
                    source: ConsoleFrameSource {
                        member_provenance: None,
                        kind: ConsoleFrameSourceKind::ConsoleEvent,
                        source_cursor: None,
                    },
                    source_event_id: None,
                    interaction_id: Some(interaction.to_string()),
                    turn_id: None,
                    run_id: None,
                    parent_frame_id: None,
                    caused_by_frame_id: None,
                })
                .await
                .unwrap();
        }
        let console_read = Arc::new(
            crate::mobkit_registry::storage_upgrade::read_console(&root).unwrap(),
        );
        let frames = crate::native_history::recent_frames(console_read, target.clone())
            .await
            .unwrap();
        assert_eq!(frames.len(), 100);
        assert!(!frames.iter().any(|frame| frame.id == "frame-1"));
        assert_eq!(frames.last().unwrap().session_id, None);
        let work = project(&frames, &target, false, &[]);
        assert_eq!(work["latestCompletion"]["interactionId"], "failed");
        assert_eq!(work["latestCompletion"]["status"], "failed");
        assert_eq!(work["outcome"], "Native failure");
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn stalled_optional_read_does_not_discard_other_details() {
        let deadline = Instant::now() + Duration::from_millis(10);
        let (stalled, available) = tokio::join!(
            before_deadline(deadline, std::future::pending::<()>()),
            before_deadline(deadline, std::future::ready("model")),
        );
        assert_eq!(stalled, None);
        assert_eq!(available, Some("model"));
    }

    #[test]
    fn projection_uses_exact_active_run_and_native_work_terminal() {
        let target = ConsoleExpectedTarget {
            identity: "worker".into(),
            runtime_key: "runtime".into(),
            runtime_member_id: "worker".into(),
            session_id: Some("session".into()),
            source_mob_id: None,
        };
        let frame = |kind: &str,
                     time: u64,
                     interaction: &str,
                     run: &str,
                     payload: Value|
         -> ConsoleFrame {
            serde_json::from_value(json!({"cursor":format!("console:{time}"),"id":format!("frame-{time}"),"dedupe_key":format!("key-{time}"),"timestamp_ms":time,"runtime_key":"runtime","identity":"worker","session_id":"session","kind":kind,"status":"completed","frame_version":1,"payload":payload,"source":{"kind":"console_event"},"interaction_id":interaction,"run_id":run})).unwrap()
        };
        let mut frames = vec![
            frame(
                "user_input",
                1,
                "active",
                "run-active",
                json!({"content":"Current objective"}),
            ),
            frame(
                "interaction_complete",
                2,
                "previous",
                "run-previous",
                json!({"result":"Actual result"}),
            ),
            frame(
                "user_input",
                3,
                "queued",
                "",
                json!({"content":"Next objective"}),
            ),
            frame(
                "interaction_complete",
                4,
                "steer",
                "",
                json!({"reason":"steer_delivered"}),
            ),
            frame(
                "interaction_complete",
                5,
                "step",
                "run-active",
                json!({"source_event_type":"session_history","result":"Intermediate step"}),
            ),
        ];
        let mut foreign = frame(
            "interaction_complete",
            6,
            "foreign",
            "",
            json!({"result":"Other session"}),
        );
        foreign.session_id = Some("replacement".into());
        frames.push(foreign);
        let work = project(&frames, &target, true, &["run-active".into()]);
        assert_eq!(work["objective"], "Current objective");
        assert_eq!(work["interactionId"], "active");
        assert_eq!(work["latestCompletion"]["interactionId"], "previous");
        assert!(!work.contains_key("outcome"));
        let unobserved = project(&frames, &target, true, &[]);
        assert!(!unobserved.contains_key("objective"));
        assert!(!unobserved.contains_key("interactionId"));
    }
    #[test]
    fn previews_keep_text_and_ignore_binary_data() {
        assert_eq!(
            short_text(
                &json!([{"type":"text","text":"Find\n issue"},{"type":"image","data":"secret"}])
            ),
            Some("Find issue".into())
        );
        assert_eq!(short_text(&json!({"data":"secret"})), None);
        assert_eq!(short_text(&json!("x".repeat(800))).unwrap().len(), 400);
    }
}
