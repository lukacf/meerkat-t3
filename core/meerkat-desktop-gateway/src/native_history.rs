//! Read-only access to the durable native console log for an exact session.
//! This never registers a runtime or interprets native transcript/tool semantics.
use meerkat_mobkit::ConsoleFrame;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};

use crate::mobkit_registry::{storage_upgrade::ConsoleRead, ConsoleExpectedTarget};
use crate::{
    console_expected_target, normalize_project_path, normalize_state_root_path, object_params,
    optional_string, required_mob_id, required_nonempty_string, stable_slug, GatewayError,
};

pub async fn read(params: Option<&Value>) -> Result<Value, GatewayError> {
    let params = object_params(params)?;
    let project = normalize_project_path(&required_nonempty_string(params, "projectPath")?)?;
    let state = optional_string(params, "stateRoot")
        .map(|value| normalize_state_root_path(&value))
        .transpose()?
        .unwrap_or_else(|| project.join(".rkat"));
    let mob_id = required_mob_id(params)?;
    let expected = console_expected_target(params)?;
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(100)
        .clamp(1, 100);
    let before = cursor(optional_string(params, "before"))?;
    let after = cursor(optional_string(params, "after"))?;
    let transcript_before = params
        .get("transcriptBefore")
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| {
                    GatewayError::invalid("Invalid native transcript message offset", None)
                })
        })
        .transpose()?;
    let transcript_revision = optional_string(params, "transcriptRevision");
    if transcript_before.is_some() && transcript_revision.is_none() {
        return Err(GatewayError::invalid(
            "Saved message paging requires its native revision",
            None,
        ));
    }
    let since = match optional_string(params, "mode").as_deref() {
        None | Some("recent") => false,
        Some("since") => true,
        _ => return Err(GatewayError::invalid("Unknown history window mode", None)),
    };
    let console_read = crate::mobkit_registry::storage_upgrade::read_console(
        &state.join("mobkit").join(stable_slug(&mob_id)),
    )?;
    tokio::task::spawn_blocking(move || {
        // Move the whole locator into the worker so cancellation cannot drop
        // its migration guard while this physical read is still running.
        let console_read = console_read;
        let path = &console_read.path;
        let session = expected.session_id.as_deref().ok_or_else(|| {
            GatewayError::conflict("This worker has no recorded native session", None)
        })?;
        let transcript = crate::native_transcript::read(
            &path.with_file_name("runtime.sqlite"),
            session,
            limit as usize,
            transcript_before,
            transcript_revision.as_deref(),
        )?;
        let page = if !path.is_file() && transcript.is_some() {
            json!({"frames":[],"exhausted":true})
        } else {
            read_log(path, &expected, limit as usize, before, after, since)?
        };
        let mut response =
            json!({"mobId": mob_id, "identity": expected.identity, "timeline": page});
        if let Some(transcript) = transcript {
            response["transcript"] = transcript;
        }
        if !path.is_file() || has_unattributed_frames(path, &expected)? {
            response["historyStatus"] = json!("partial");
        }
        Ok(response)
    })
    .await
    .map_err(|error| {
        GatewayError::policy(
            "Native history read failed",
            Some(json!({"error":error.to_string()})),
        )
    })?
}

/// Recent canonical frames after the durable exact-session causal join. The
/// selected page may omit older session anchors, so callers must not rejoin it
/// using only frames visible in the page. Each blocking read retains its own
/// migration guard even if the calling status future times out or is cancelled.
pub(crate) async fn recent_frames(
    console_read: Arc<ConsoleRead>,
    expected: ConsoleExpectedTarget,
) -> Result<Vec<ConsoleFrame>, GatewayError> {
    tokio::task::spawn_blocking(move || {
        let mut page = read_log(&console_read.path, &expected, 100, None, None, false)?;
        serde_json::from_value(page["frames"].take()).map_err(|error| {
            GatewayError::policy(
                "Cannot decode the durable native console history",
                Some(json!({"error":error.to_string()})),
            )
        })
    })
    .await
    .map_err(|error| {
        GatewayError::policy(
            "Native history read failed",
            Some(json!({"error":error.to_string()})),
        )
    })?
}

/// Bounded console admissions for work reconciliation. Read these separately
/// from the activity page so a verbose tool run cannot evict its input anchor.
pub(crate) async fn recent_work_inputs(
    console_read: Arc<ConsoleRead>,
    expected: ConsoleExpectedTarget,
) -> Result<Vec<ConsoleFrame>, GatewayError> {
    tokio::task::spawn_blocking(move || {
        let path = &console_read.path;
        let session = expected.session_id.as_deref().ok_or_else(|| {
            GatewayError::conflict("Native work needs its exact session", None)
        })?;
        if !path.is_file() {
            return Ok(Vec::new());
        }
        let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(history_error)?;
        conn.busy_timeout(std::time::Duration::from_secs(2))
            .map_err(history_error)?;
        let mut statement = conn.prepare(
            "SELECT cursor_seq,id,dedupe_key,timestamp_ms,runtime_key,identity,conversation_id,session_id,kind,status,frame_version,updated_at_ms,payload_json,source_kind,source_cursor,source_event_id,interaction_id,parent_frame_id,caused_by_frame_id,turn_id,run_id FROM console_frames WHERE identity=?1 AND runtime_key=?2 AND session_id=?3 AND kind='user_input' AND source_kind='send' AND interaction_id IS NOT NULL AND COALESCE(json_extract(payload_json,'$.handling_mode'),'queue')!='steer' ORDER BY cursor_seq DESC LIMIT 16"
        ).map_err(history_error)?;
        let rows = statement.query_map(
            rusqlite::params![expected.identity, expected.runtime_key, session],
            decode_frame,
        ).map_err(history_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(history_error)
    }).await.map_err(|error| GatewayError::policy(
        "Native work admission read failed", Some(json!({"error":error.to_string()})),
    ))?
}

/// Native run-start anchors are discovery only. Exact runtime receipts decide
/// whether their contributing input produced completed work. The separate
/// identity-indexed query keeps a long tool stream from evicting this anchor.
pub(crate) async fn recent_work_runs(
    console_read: Arc<ConsoleRead>,
    expected: ConsoleExpectedTarget,
) -> Result<Vec<ConsoleFrame>, GatewayError> {
    tokio::task::spawn_blocking(move || {
        let path = &console_read.path;
        let session = expected.session_id.as_deref().ok_or_else(|| {
            GatewayError::conflict("Native work needs its exact session", None)
        })?;
        if !path.is_file() {
            return Ok(Vec::new());
        }
        let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(history_error)?;
        conn.busy_timeout(std::time::Duration::from_secs(2))
            .map_err(history_error)?;
        let mut statement = conn.prepare(
            "SELECT cursor_seq,id,dedupe_key,timestamp_ms,runtime_key,identity,conversation_id,session_id,kind,status,frame_version,updated_at_ms,payload_json,source_kind,source_cursor,source_event_id,interaction_id,parent_frame_id,caused_by_frame_id,turn_id,run_id FROM console_frames WHERE identity=?1 AND runtime_key=?2 AND session_id=?3 AND kind='run_started' AND source_kind='console_event' AND run_id IS NOT NULL AND source_event_id IS NOT NULL AND COALESCE(json_extract(payload_json,'$.source_event_type'),json_extract(payload_json,'$.type'))='run_started' ORDER BY cursor_seq DESC LIMIT 16"
        ).map_err(history_error)?;
        let rows = statement.query_map(
            rusqlite::params![expected.identity, expected.runtime_key, session],
            decode_frame,
        ).map_err(history_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(history_error)
    }).await.map_err(|error| GatewayError::policy(
        "Native work run discovery failed", Some(json!({"error":error.to_string()})),
    ))?
}

fn cursor(value: Option<String>) -> Result<Option<i64>, GatewayError> {
    value
        .map(|value| {
            value
                .strip_prefix("console:")
                .and_then(|seq| seq.parse::<i64>().ok())
                .filter(|seq| *seq >= 0)
                .ok_or_else(|| GatewayError::invalid("Invalid native history cursor", None))
        })
        .transpose()
}

pub(crate) fn read_log(
    path: &Path,
    expected: &ConsoleExpectedTarget,
    limit: usize,
    before: Option<i64>,
    after: Option<i64>,
    since: bool,
) -> Result<Value, GatewayError> {
    let session = expected.session_id.as_deref().ok_or_else(|| {
        GatewayError::conflict("This worker has no recorded native session", None)
    })?;
    if !path.is_file() {
        return Err(GatewayError::conflict(
            "Native history has not been persisted for this runtime. Reconnect its owning conversation once to load existing session history.",
            None,
        ));
    }
    // OPEN_READ_ONLY prevents schema migration, log creation, and runtime admission.
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(history_error)?;
    conn.busy_timeout(std::time::Duration::from_secs(2))
        .map_err(history_error)?;
    let latest: Option<i64> = conn.query_row("SELECT MAX(cursor_seq) FROM console_frames WHERE identity=?1 AND runtime_key=?2 AND (session_id=?3 OR (session_id IS NULL AND interaction_id IS NOT NULL AND EXISTS (SELECT 1 FROM console_frames AS anchor WHERE anchor.identity=console_frames.identity AND anchor.runtime_key=console_frames.runtime_key AND anchor.session_id=?3 AND anchor.interaction_id=console_frames.interaction_id) AND NOT EXISTS (SELECT 1 FROM console_frames AS foreign_anchor WHERE foreign_anchor.identity=console_frames.identity AND foreign_anchor.runtime_key=console_frames.runtime_key AND foreign_anchor.session_id IS NOT NULL AND foreign_anchor.session_id != ?3 AND foreign_anchor.interaction_id=console_frames.interaction_id)))", (&expected.identity, &expected.runtime_key, session), |row| row.get(0)).optional().map_err(history_error)?.flatten();
    let direction = if since { "ASC" } else { "DESC" };
    let query = format!(
        "SELECT cursor_seq,id,dedupe_key,timestamp_ms,runtime_key,identity,conversation_id,session_id,kind,status,frame_version,updated_at_ms,payload_json,source_kind,source_cursor,source_event_id,interaction_id,parent_frame_id,caused_by_frame_id,turn_id,run_id FROM console_frames WHERE identity=?1 AND runtime_key=?2 AND (session_id=?3 OR (session_id IS NULL AND interaction_id IS NOT NULL AND EXISTS (SELECT 1 FROM console_frames AS anchor WHERE anchor.identity=console_frames.identity AND anchor.runtime_key=console_frames.runtime_key AND anchor.session_id=?3 AND anchor.interaction_id=console_frames.interaction_id) AND NOT EXISTS (SELECT 1 FROM console_frames AS foreign_anchor WHERE foreign_anchor.identity=console_frames.identity AND foreign_anchor.runtime_key=console_frames.runtime_key AND foreign_anchor.session_id IS NOT NULL AND foreign_anchor.session_id != ?3 AND foreign_anchor.interaction_id=console_frames.interaction_id))) AND (?4 IS NULL OR cursor_seq < ?4) AND (?5 IS NULL OR cursor_seq > ?5) ORDER BY cursor_seq {direction} LIMIT ?6"
    );
    let mut stmt = conn.prepare(&query).map_err(history_error)?;
    let rows = stmt
        .query_map(
            rusqlite::params![
                expected.identity,
                expected.runtime_key,
                session,
                before,
                after,
                limit + 1
            ],
            decode_frame,
        )
        .map_err(history_error)?;
    let mut frames = rows.collect::<Result<Vec<_>, _>>().map_err(history_error)?;
    let exhausted = frames.len() <= limit;
    frames.truncate(limit);
    if !since {
        frames.reverse();
    }
    let next = if since { frames.last() } else { frames.first() }.map(|frame| frame.cursor.clone());
    let mut page = json!({"frames":frames,"exhausted":exhausted});
    if let Some(next) = next {
        page["next_cursor"] = json!(next);
    }
    if let Some(seq) = latest {
        page["latest_cursor"] = json!(format!("console:{seq}"));
    }
    Ok(page)
}

pub(crate) fn decode_frame(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConsoleFrame> {
    let payload: String = row.get(12)?;
    let payload: Value = serde_json::from_str(&payload).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(12, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let mut value = json!({"cursor":format!("console:{}", row.get::<_,i64>(0)?),"id":row.get::<_,String>(1)?,"dedupe_key":row.get::<_,String>(2)?,"timestamp_ms":row.get::<_,i64>(3)?,"runtime_key":row.get::<_,String>(4)?,"identity":row.get::<_,String>(5)?,"kind":row.get::<_,String>(8)?,"status":row.get::<_,String>(9)?,"frame_version":row.get::<_,i64>(10)?,"payload":payload,"source":{"kind":row.get::<_,String>(13)?}});
    for (key, index) in [
        ("conversation_id", 6),
        ("session_id", 7),
        ("source_event_id", 15),
        ("interaction_id", 16),
        ("parent_frame_id", 17),
        ("caused_by_frame_id", 18),
        ("turn_id", 19),
        ("run_id", 20),
    ] {
        if let Some(text) = row.get::<_, Option<String>>(index)? {
            value[key] = json!(text);
        }
    }
    if let Some(stamp) = row.get::<_, Option<i64>>(11)? {
        value["updated_at_ms"] = json!(stamp);
    }
    if let Some(source) = row.get::<_, Option<String>>(14)? {
        value["source"]["source_cursor"] = json!(source);
    }
    serde_json::from_value(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

fn history_error(error: rusqlite::Error) -> GatewayError {
    GatewayError::policy(
        "Cannot read the durable native console history",
        Some(json!({"error":error.to_string()})),
    )
}

fn has_unattributed_frames(
    path: &Path,
    expected: &ConsoleExpectedTarget,
) -> Result<bool, GatewayError> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(history_error)?;
    conn.busy_timeout(std::time::Duration::from_secs(2))
        .map_err(history_error)?;
    // This is a coverage warning, not a claim that an unanchored event belongs
    // to the requested session. An exact foreign-session anchor is not partial.
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM console_frames f WHERE f.identity=?1 AND f.runtime_key=?2 AND f.session_id IS NULL AND (f.interaction_id IS NULL OR (SELECT COUNT(DISTINCT anchor.session_id) FROM console_frames anchor WHERE anchor.identity=f.identity AND anchor.runtime_key=f.runtime_key AND anchor.interaction_id=f.interaction_id AND anchor.session_id IS NOT NULL) != 1))",
        (&expected.identity, &expected.runtime_key), |row| row.get(0),
    ).map_err(history_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use meerkat_mobkit::{
        ConsoleFrameSource, ConsoleFrameSourceKind, ConsoleFrameStatus, ConsoleLogStore,
        NewConsoleFrame, SqliteConsoleLogStore,
    };
    #[tokio::test]
    async fn exact_session_history_is_read_only_and_keeps_native_paging() {
        let root = std::env::temp_dir().join(format!("native-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("console.sqlite");
        let store = SqliteConsoleLogStore::open(&path).unwrap();
        for (index, session, interaction) in [
            (1, Some("old"), "old-interaction"),
            (2, Some("replacement"), "replacement-interaction"),
            (3, None, "old-interaction"),
            (4, None, "replacement-interaction"),
            (5, None, "unanchored-interaction"),
        ] {
            store
                .append_if_absent(NewConsoleFrame {
                    id: Some(format!("frame-{index}")),
                    dedupe_key: format!("native-{index}"),
                    timestamp_ms: index,
                    runtime_key: "default".into(),
                    identity: "worker".into(),
                    conversation_id: None,
                    session_id: session.map(str::to_string),
                    kind: "tool_call_completed".into(),
                    status: ConsoleFrameStatus::Completed,
                    payload: json!({"native":index}),
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
        let expected = ConsoleExpectedTarget {
            identity: "worker".into(),
            runtime_key: "default".into(),
            runtime_member_id: "member".into(),
            session_id: Some("old".into()),
            source_mob_id: None,
        };
        assert!(has_unattributed_frames(&path, &expected).unwrap());
        let first = read_log(&path, &expected, 1, None, None, false).unwrap();
        assert_eq!(first["frames"][0]["id"], "frame-3");
        assert_eq!(first["frames"][0]["payload"], json!({"native":3}));
        assert!(
            first["frames"][0].get("session_id").is_none(),
            "causal join must preserve native frame fields"
        );
        assert_eq!(first["exhausted"], false);
        let second = read_log(&path, &expected, 1, Some(3), None, false).unwrap();
        assert_eq!(second["frames"][0]["id"], "frame-1");
        assert_eq!(second["exhausted"], true);
        let missing = root.join("absent.sqlite");
        assert!(read_log(&missing, &expected, 1, None, None, false).is_err());
        assert!(!missing.exists());
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn crew_stop_report_accepts_held_starts_without_requiring_run_cancellation() {
        use meerkat_mob::{MemberRunStarts, MemberStopOutcome, MemberStopRun, MobStopReport};

        let report = MobStopReport {
            members: [
                (
                    "idle".into(),
                    MemberStopOutcome {
                        run: MemberStopRun::NoRun,
                        starts: MemberRunStarts::Held,
                    },
                ),
                (
                    "turn-driven".into(),
                    MemberStopOutcome {
                        run: MemberStopRun::LeftRunning {
                            run_id: meerkat_core::lifecycle::RunId::new(),
                        },
                        starts: MemberRunStarts::Held,
                    },
                ),
                (
                    "dormant".into(),
                    MemberStopOutcome {
                        run: MemberStopRun::NoRun,
                        starts: MemberRunStarts::NotBound,
                    },
                ),
            ]
            .into(),
        };
        validate_crew_stop_report(&report).unwrap();
    }

    #[test]
    fn crew_stop_report_refuses_unheld_starts_and_preserves_native_outcomes() {
        use meerkat_mob::{
            MemberRunStarts, MemberStopOutcome, MemberStopRun, MobStopReport, NotHoldableReason,
        };

        for reason in [
            NotHoldableReason::PeerLacksCapability,
            NotHoldableReason::ProvisionerLacksCapability,
        ] {
            let report = MobStopReport {
                members: [
                    (
                        "held".into(),
                        MemberStopOutcome {
                            run: MemberStopRun::NoRun,
                            starts: MemberRunStarts::Held,
                        },
                    ),
                    (
                        "unheld".into(),
                        MemberStopOutcome {
                            run: MemberStopRun::Interrupted,
                            starts: MemberRunStarts::NotHoldable { reason },
                        },
                    ),
                ]
                .into(),
            };
            let GatewayError::Api {
                typed_code,
                message,
                details,
                ..
            } = validate_crew_stop_report(&report).unwrap_err();
            assert_eq!(typed_code, "CONFLICT");
            assert_eq!(
                message,
                "Native crew is stopped, but some members can still start runs"
            );
            assert_eq!(details, Some(json!({"stopReport": report})));
        }
    }
}

/// Explicit native crew lifecycle recovery. It never reconstructs a spawn or input.
pub async fn resume(
    mob: &crate::mobkit_registry::MobkitMobRuntime,
    expected: &ConsoleExpectedTarget,
) -> Result<Value, GatewayError> {
    set_crew_running(mob, expected, true).await
}

/// Stop the whole native crew. This is distinct from cancelling one member turn.
pub async fn stop_crew(
    mob: &crate::mobkit_registry::MobkitMobRuntime,
    expected: &ConsoleExpectedTarget,
) -> Result<Value, GatewayError> {
    set_crew_running(mob, expected, false).await
}

async fn set_crew_running(
    mob: &crate::mobkit_registry::MobkitMobRuntime,
    expected: &ConsoleExpectedTarget,
    running: bool,
) -> Result<Value, GatewayError> {
    let source = expected.source_mob_id.as_ref().ok_or_else(|| {
        GatewayError::invalid(
            "Only native worker crews can be stopped or resumed here",
            None,
        )
    })?;
    if expected.session_id.is_none() {
        return Err(GatewayError::conflict(
            "The native worker has no current session",
            None,
        ));
    }
    let console = mob.console.as_ref().ok_or_else(|| {
        GatewayError::policy("Native crew identity observation is unavailable", None)
    })?;
    let identities = console.list_identities().await.map_err(|error| {
        GatewayError::conflict(
            "Cannot observe the native crew",
            Some(json!({"error":error.to_string()})),
        )
    })?;
    if !identities.iter().any(|record| {
        record.identity == expected.identity
            && record.runtime_key == expected.runtime_key
            && record.runtime_member_id == expected.runtime_member_id
            && record.session_id == expected.session_id
            && record.labels.get("source_mob_id") == expected.source_mob_id.as_ref()
    }) {
        return Err(GatewayError::conflict(
            "The native worker incarnation changed. Refresh before changing its crew",
            None,
        ));
    }
    let runtime = mob.runtime.as_ref().ok_or_else(|| {
        GatewayError::policy(
            "Reconnect the owning conversation before changing its crew",
            None,
        )
    })?;
    let state = runtime
        .mob_runtime()
        .agent_mob_mcp_state()
        .ok_or_else(|| GatewayError::policy("Native worker recovery is unavailable", None))?;
    let handles = state
        .mob_handles_snapshot()
        .await
        .map_err(|error| GatewayError::conflict(error.to_string(), None))?;
    let (mob_id, handle) = handles
        .into_iter()
        .find(|(id, _)| id.as_str() == source)
        .ok_or_else(|| GatewayError::conflict("The native crew no longer exists", None))?;
    let member = handle
        .list_members_observation_snapshot()
        .await
        .into_iter()
        .find(|member| {
            meerkat_mobkit::member_comms_id::runtime_alias_str(member.agent_identity.as_str())
                == expected.runtime_member_id
        })
        .ok_or_else(|| GatewayError::conflict("The native worker no longer exists", None))?;
    let session = handle
        .resolve_bridge_session_id_observation(&member.agent_identity)
        .await
        .map(|id| id.to_string());
    if session != expected.session_id {
        return Err(GatewayError::conflict(
            "The native worker session changed. Open its current conversation before changing its crew",
            None,
        ));
    }
    let required_state = if running {
        meerkat_mob::MobState::Stopped
    } else {
        meerkat_mob::MobState::Running
    };
    if handle.status_observation_snapshot() != required_state {
        return Err(GatewayError::conflict(
            if running {
                "Only a stopped native crew can be resumed"
            } else {
                "Only a running native crew can be stopped"
            },
            None,
        ));
    }
    let result = if running {
        state.mob_resume(&mob_id).await.map(|()| None)
    } else {
        state.mob_stop(&mob_id).await.map(Some)
    };
    let stop_report = result.map_err(|error| {
        GatewayError::conflict(
            format!(
                "Native crew {} failed: {error}",
                if running { "resume" } else { "stop" }
            ),
            Some(json!({"error":error.to_string()})),
        )
    })?;
    if let Some(report) = stop_report {
        validate_crew_stop_report(&report)?;
    }
    Ok(if running {
        json!({"mobId":mob.mob_id,"sourceMobId":source,"resumed":true})
    } else {
        json!({"mobId":mob.mob_id,"sourceMobId":source,"stopped":true})
    })
}

fn validate_crew_stop_report(report: &meerkat_mob::MobStopReport) -> Result<(), GatewayError> {
    // Stop pauses new starts; a turn-driven member may finish its current run.
    if report.not_holdable().next().is_some() {
        return Err(GatewayError::conflict(
            "Native crew is stopped, but some members can still start runs",
            Some(json!({"stopReport": report})),
        ));
    }
    Ok(())
}
