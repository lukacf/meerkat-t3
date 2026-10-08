//! Opt-in actual SQLite/history measurement. Never runs in the normal test lane.
//! Synthetic content is committed through released native stores after real
//! fixture agents close. It is not evidence of model execution or rendered UX.
use crate::{
    host_tools::HostToolTransport,
    mobkit_registry::{CreateMobInput, ProjectMobkitRegistry},
    MeerkatGateway,
};
use meerkat_core::{lifecycle::core_executor::BoundSessionCommit, SessionId, SessionStore as _};
use meerkat_desktop_contracts::{RequestContext, RpcRequest};
use meerkat_mobkit::{
    AppendDisposition, ConsoleFrameSource, ConsoleFrameSourceKind, ConsoleFrameStatus,
    ConsoleIdentityRecord, ConsoleLogStore, NewConsoleFrame, SqliteConsoleLogStore,
};
use meerkat_runtime::{
    identifiers::LogicalRuntimeId,
    store::{PreparedRuntimeSessionCommit, RuntimeStore, SqliteRuntimeStore},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

const PAGE: usize = 100;
const DAYS: u64 = 14;
const MESSAGE_BYTES: usize = 512;
const EVENT_BYTES: usize = 320;

#[derive(Serialize, Deserialize)]
struct Target {
    mob_id: String,
    record: ConsoleIdentityRecord,
    visible_offsets: Vec<usize>,
    seeded_frames: usize,
    store_revision: String,
    body_bytes: usize,
}
#[derive(Serialize, Deserialize)]
struct Manifest {
    root: PathBuf,
    profile: String,
    targets: Vec<Target>,
    databases: BTreeMap<String, String>,
    dataset: Value,
}

struct NoProvider;
#[async_trait::async_trait]
impl meerkat::LlmClient for NoProvider {
    fn project_replay_messages(
        &self,
        messages: &[meerkat_core::Message],
    ) -> Result<Vec<meerkat_core::Message>, meerkat::LlmError> {
        Ok(messages.to_vec())
    }
    fn stream<'a>(
        &'a self,
        _: &'a meerkat::LlmRequest,
    ) -> std::pin::Pin<
        Box<
            dyn futures_util::Stream<Item = Result<meerkat::LlmEvent, meerkat::LlmError>>
                + Send
                + 'a,
        >,
    > {
        panic!("native scale fixture must not invoke any provider")
    }
    fn provider(&self) -> meerkat_core::Provider {
        meerkat_core::Provider::Other
    }
    async fn health_check(&self) -> Result<(), meerkat::LlmError> {
        Ok(())
    }
}

fn run(work: impl Future<Output = ()> + Send + 'static) {
    std::thread::Builder::new()
        .stack_size(32 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_stack_size(16 * 1024 * 1024)
                .enable_all()
                .build()
                .unwrap()
                .block_on(work);
        })
        .unwrap()
        .join()
        .unwrap();
}
fn root() -> PathBuf {
    let root =
        PathBuf::from(std::env::var_os("T3_NATIVE_SCALE_ROOT").expect("opt-in fixture root"));
    assert!(root.is_absolute());
    assert!(
        root.join("fixture-owned.txt").is_file(),
        "runner must own this private root"
    );
    root
}
fn save(path: &Path, value: &impl Serialize) {
    std::fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
fn digest(path: &Path) -> String {
    format!("{:x}", Sha256::digest(std::fs::read(path).unwrap()))
}
fn fingerprints(root: &Path) -> BTreeMap<String, String> {
    fn visit(base: &Path, directory: &Path, out: &mut BTreeMap<String, String>) {
        for entry in std::fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                visit(base, &path, out);
            } else if path
                .extension()
                .is_some_and(|extension| extension == "sqlite")
                || (path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .ends_with("-wal")
                    && entry.metadata().unwrap().len() > 0)
            {
                // Read-only SQLite opens can create empty WAL sidecars. They
                // contain no database bytes. Retain every data-bearing WAL
                // and every main database in the exact comparison.
                out.insert(
                    path.strip_prefix(base)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    digest(&path),
                );
            }
        }
    }
    let mut result = BTreeMap::new();
    visit(root, &root.join("state"), &mut result);
    result
}
fn scope(root: &Path) -> Value {
    json!({"projectPath":root.join("project"),"stateRoot":root.join("state")})
}
async fn rpc(gateway: &MeerkatGateway, method: &str, params: Value) -> Value {
    let response = tokio::time::timeout(
        Duration::from_secs(30),
        gateway.handle(
            RpcRequest {
                jsonrpc: "2.0".into(),
                id: None,
                method: method.into(),
                params: Some(params),
            },
            RequestContext::local(),
        ),
    )
    .await
    .expect("bounded native history request");
    assert!(response.error.is_none(), "{method}: {:?}", response.error);
    response.result.unwrap()
}
fn params(root: &Path, target: &Target) -> Value {
    let record = &target.record;
    let mut result = scope(root);
    result["mobId"] = json!(target.mob_id);
    result["identity"] = json!(record.identity);
    result["expected"] = json!({
        "identity":record.identity,"runtimeKey":record.runtime_key,
        "runtimeMemberId":record.runtime_member_id,"sessionId":record.session_id,
        "sourceMobId":record.labels.get("source_mob_id")
    });
    result["limit"] = json!(PAGE);
    result
}

#[test]
#[ignore = "Opt-in real native scale seed; run with the private scale runner"]
fn native_scale_seed() {
    run(async {
        let root = root();
        assert!(
            !root.join("manifest.json").exists(),
            "never reseed an existing fixture"
        );
        let started = Instant::now();
        let smoke = std::env::var("T3_NATIVE_SCALE_PROFILE").as_deref() == Ok("smoke");
        let (count, ordinary_messages, ordinary_events, long_messages, long_events) = if smoke {
            (2, 20, 80, 240, 320)
        } else {
            (12, 200, 1_000, 10_000, 20_000)
        };
        std::fs::create_dir_all(root.join("project")).unwrap();
        std::fs::create_dir_all(root.join("state")).unwrap();
        let registry = ProjectMobkitRegistry::new_with_test_llm(
            HostToolTransport::new(),
            Arc::new(NoProvider),
        );
        let mut targets = Vec::new();
        let mut append_duplicates = 0;
        let mut total_messages = 0;
        let mut total_events = 0;
        for index in 0..count {
            let mob_id = format!("scale-{}-{index}", uuid::Uuid::new_v4());
            let mob = registry
                .create_local(CreateMobInput {
                    mob_id: mob_id.clone(),
                    kind: "thread".into(),
                    label: "Native scale fixture".into(),
                    role: "coordinator".into(),
                    coordinator_identity: "ingress".into(),
                    model: "gpt-5.6-sol".into(), initial_llm: None,
                    instructions: "Idle synthetic history fixture. Never run inference.".into(),
                    thread_id: Some(format!("scale-thread-{index}")),
                    include_native_workers: false,
                    access_mode: None,
                    config_project_path: root.join("project"),
                    project_path: root.join("project"),
                    state_root: root.join("state"),
                    config_state_root: root.join("state"),
                })
                .await
                .unwrap();
            let record = mob
                .console
                .as_ref()
                .unwrap()
                .inspect_identity("ingress")
                .await
                .unwrap()
                .unwrap()
                .identity;
            let session_id =
                SessionId::parse(record.session_id.as_deref().expect("real native session"))
                    .unwrap();
            let mut actor = mob
                .runtime
                .as_ref()
                .unwrap()
                .mob_handle()
                .machine_state_changes();
            assert!(registry.remove(&mob_id).await.unwrap());
            while !actor.is_closed() {
                if actor.changed().await.is_err() {
                    break;
                }
            }
            drop(mob);

            // There is no live writer now. Reopen released public stores and
            // retain the exact typed native session, identity and authority.
            let directory = root
                .join("state")
                .join("mobkit")
                .join(crate::stable_slug(&mob_id));
            let runtime =
                SqliteRuntimeStore::new_whole_blob(directory.join("runtime.sqlite")).unwrap();
            let runtime_id = LogicalRuntimeId::for_session(&session_id);
            let committed = runtime
                .load_committed_whole_blob_snapshot(&runtime_id)
                .await
                .unwrap();
            let mut session = match committed {
                Some(snapshot) => snapshot.session().clone(),
                None => meerkat_store::SqliteSessionStore::open(directory.join("sessions.sqlite"))
                    .unwrap()
                    .load(&session_id)
                    .await
                    .unwrap()
                    .expect("the created native session must persist"),
            };
            assert_eq!(session.id(), &session_id);
            let (messages, events) = if index + 1 == count {
                (long_messages, long_events)
            } else {
                (ordinary_messages, ordinary_events)
            };
            for offset in 0..messages {
                let text = format!(
                    "Synthetic history day {:02} item {offset:05}: {}",
                    1 + offset * DAYS as usize / messages,
                    "m".repeat(MESSAGE_BYTES)
                );
                session.push(serde_json::from_value(if offset % 2 == 0 {
                    json!({"role":"user","content":text})
                } else {
                    json!({"role":"block_assistant","blocks":[{"block_type":"text","data":{"text":text}}]})
                }).unwrap());
            }
            let visible_offsets = session
                .messages()
                .iter()
                .enumerate()
                .filter_map(|(offset, message)| {
                    (!matches!(message, meerkat_core::Message::System(_))).then_some(offset)
                })
                .collect::<Vec<_>>();
            let commit = BoundSessionCommit::sealed(Arc::new(session)).unwrap();
            let result = runtime
                .commit_prepared_session_boundary(
                    &runtime_id,
                    PreparedRuntimeSessionCommit::snapshot_only(commit),
                )
                .await
                .unwrap();
            let revision = result
                .authority()
                .unwrap()
                .whole_blob()
                .unwrap()
                .store_revision()
                .to_string();
            let stored = runtime
                .load_committed_whole_blob_snapshot(&runtime_id)
                .await
                .unwrap()
                .unwrap();
            let body_bytes = stored.bytes().len();
            drop(stored);
            drop(runtime);
            let log = SqliteConsoleLogStore::open(directory.join("console.sqlite")).unwrap();
            for offset in 0..events {
                let frame = NewConsoleFrame {
                    id: None,
                    dedupe_key: format!("scale-fixture:{session_id}:{offset}"),
                    timestamp_ms: 1_788_220_800_000
                        + offset as u64 * (DAYS * 86_400_000) / events as u64,
                    runtime_key: record.runtime_key.clone(),
                    identity: record.identity.clone(),
                    conversation_id: None,
                    session_id: Some(session_id.to_string()),
                    kind: "system_notice".into(),
                    status: ConsoleFrameStatus::Completed,
                    payload: json!({"scale_fixture":true,"ordinal":offset,"content":"e".repeat(EVENT_BYTES)}),
                    source: ConsoleFrameSource {
                        member_provenance: None,
                        kind: ConsoleFrameSourceKind::Synthetic,
                        source_cursor: None,
                    },
                    source_event_id: None,
                    interaction_id: None,
                    turn_id: None,
                    run_id: None,
                    parent_frame_id: None,
                    caused_by_frame_id: None,
                };
                let appended = log.append_if_absent(frame.clone()).await.unwrap();
                assert_eq!(appended.disposition, AppendDisposition::Inserted);
                if offset % 100 == 0 {
                    let again = log.append_if_absent(frame).await.unwrap();
                    assert_eq!(again.disposition, AppendDisposition::Existing);
                    assert_eq!(again.frame.id, appended.frame.id);
                    append_duplicates += 1;
                }
            }
            drop(log);
            total_messages += messages;
            total_events += events;
            targets.push(Target {
                mob_id,
                record,
                visible_offsets,
                seeded_frames: events,
                store_revision: revision,
                body_bytes,
            });
        }
        assert!(registry.shutdown().await.is_empty());
        drop(registry);
        let manifest = Manifest {
            root: root.clone(),
            profile: if smoke { "smoke" } else { "default" }.into(),
            targets,
            databases: fingerprints(&root),
            dataset: json!({"realNativeAgents":count,"syntheticVisibleMessagesAdded":total_messages,
                "syntheticConsoleEventsAdded":total_events,"logicalDays":DAYS,
                "messageTextPaddingBytes":MESSAGE_BYTES,"eventTextPaddingBytes":EVENT_BYTES,
                "deduplicatedAppendAttempts":append_duplicates,"providerCalls":0,
                "creation":"Real native registry agents; released typed native session/store commits after shutdown",
                "generatedContent":"Synthetic fixture content, not executed runs or model output"}),
        };
        save(&root.join("manifest.json"), &manifest);
        save(
            &root.join("seed.json"),
            &json!({"wallMs":started.elapsed().as_secs_f64()*1000.0,"dataset":manifest.dataset}),
        );
    });
}

#[derive(Default, Serialize)]
struct Samples {
    wall_ms: Vec<f64>,
    response_bytes: u64,
    messages: usize,
    frames: usize,
}
async fn measured(gateway: &MeerkatGateway, input: Value, samples: &mut Samples) -> Value {
    let started = Instant::now();
    let result = rpc(gateway, "mobs.v1.consoleHistory", input).await;
    // JSON encoding is included because this is the transport-facing value.
    samples.response_bytes += serde_json::to_vec(&result).unwrap().len() as u64;
    samples
        .wall_ms
        .push(started.elapsed().as_secs_f64() * 1000.0);
    samples.messages += result["transcript"]["messages"].as_array().unwrap().len();
    samples.frames += result["timeline"]["frames"].as_array().unwrap().len();
    result
}
fn verify(target: &Target, page: &Value) {
    assert_eq!(page["mobId"], target.mob_id);
    assert_eq!(page["identity"], target.record.identity);
    assert_eq!(
        page["transcript"]["sessionId"],
        target.record.session_id.as_deref().unwrap()
    );
    assert_eq!(page["transcript"]["storeRevision"], target.store_revision);
    assert_eq!(
        page["transcript"]["totalMessages"],
        target.visible_offsets.len()
    );
    assert!(page["transcript"]["messages"].as_array().unwrap().len() <= PAGE);
    assert!(page["timeline"]["frames"].as_array().unwrap().len() <= PAGE);
    for frame in page["timeline"]["frames"].as_array().unwrap() {
        assert_eq!(frame["identity"], target.record.identity);
        assert_eq!(frame["runtime_key"], target.record.runtime_key);
        if let Some(session) = frame.get("session_id") {
            assert_eq!(session, target.record.session_id.as_deref().unwrap());
        }
    }
}

#[test]
#[ignore = "Opt-in actual native cold/warm reads; runner starts a fresh process"]
fn native_scale_read() {
    run(async {
        let root = root();
        let manifest: Manifest =
            serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest.root, root);
        let pass = std::env::var("T3_NATIVE_SCALE_PASS").unwrap_or_else(|_| "first".into());
        assert!(matches!(pass.as_str(), "first" | "repeat"));
        let gateway = MeerkatGateway::new();
        let first_process_read = Instant::now();
        let mut samples = BTreeMap::<String, Samples>::new();
        let mut counts = Vec::new();
        for target in &manifest.targets {
            let kind = if target.visible_offsets.len() > 1_000 {
                "long"
            } else {
                "ordinary"
            };
            let page = measured(
                &gateway,
                params(&root, target),
                samples.entry(format!("first_touch_{kind}")).or_default(),
            )
            .await;
            verify(target, &page);
            let warm_repeats = if manifest.profile == "smoke" { 3 } else { 10 };
            for _ in 0..warm_repeats {
                let page = measured(
                    &gateway,
                    params(&root, target),
                    samples.entry(format!("warm_tail_{kind}")).or_default(),
                )
                .await;
                verify(target, &page);
            }
            let mut offsets = BTreeSet::new();
            let mut before = None;
            loop {
                let mut input = params(&root, target);
                if let Some(before) = before {
                    input["transcriptBefore"] = json!(before);
                    input["transcriptRevision"] = json!(target.store_revision);
                }
                let page = measured(
                    &gateway,
                    input,
                    samples.entry(format!("message_paging_{kind}")).or_default(),
                )
                .await;
                verify(target, &page);
                for message in page["transcript"]["messages"].as_array().unwrap() {
                    assert!(
                        offsets.insert(message["offset"].as_u64().unwrap() as usize),
                        "duplicate saved message"
                    );
                }
                if page["transcript"]["exhausted"] == true {
                    break;
                }
                let next = page["transcript"]["nextBefore"].as_u64().unwrap();
                assert!(
                    before.is_none_or(|previous| next < previous),
                    "message paging must advance"
                );
                before = Some(next);
                assert!(offsets.len() <= target.visible_offsets.len());
            }
            assert_eq!(
                offsets.into_iter().collect::<Vec<_>>(),
                target.visible_offsets
            );
            let mut backwards = BTreeSet::new();
            let mut fixture_count = 0;
            let mut before: Option<String> = None;
            loop {
                let mut input = params(&root, target);
                if let Some(ref before) = before {
                    input["before"] = json!(before);
                }
                let page = measured(
                    &gateway,
                    input,
                    samples.entry(format!("event_paging_{kind}")).or_default(),
                )
                .await;
                verify(target, &page);
                for frame in page["timeline"]["frames"].as_array().unwrap() {
                    assert!(
                        backwards.insert(frame["id"].as_str().unwrap().to_owned()),
                        "duplicate activity frame"
                    );
                    if frame["payload"]["scale_fixture"] == true {
                        fixture_count += 1;
                    }
                }
                if page["timeline"]["exhausted"] == true {
                    break;
                }
                let next = page["timeline"]["next_cursor"].as_str().unwrap().to_owned();
                assert!(before
                    .as_ref()
                    .is_none_or(|previous| cursor(&next) < cursor(previous)));
                before = Some(next);
                assert!(
                    backwards.len() <= target.seeded_frames + 1_000,
                    "unexpected activity growth"
                );
            }
            assert_eq!(fixture_count, target.seeded_frames);
            let mut forwards = BTreeSet::new();
            let mut after: Option<String> = None;
            loop {
                let mut input = params(&root, target);
                input["mode"] = json!("since");
                if let Some(ref after) = after {
                    input["after"] = json!(after);
                }
                let page = measured(
                    &gateway,
                    input,
                    samples.entry(format!("event_catchup_{kind}")).or_default(),
                )
                .await;
                verify(target, &page);
                for frame in page["timeline"]["frames"].as_array().unwrap() {
                    assert!(
                        forwards.insert(frame["id"].as_str().unwrap().to_owned()),
                        "duplicate catch-up frame"
                    );
                }
                if page["timeline"]["exhausted"] == true {
                    break;
                }
                let next = page["timeline"]["next_cursor"].as_str().unwrap().to_owned();
                assert!(after
                    .as_ref()
                    .is_none_or(|previous| cursor(&next) > cursor(previous)));
                after = Some(next);
                assert!(forwards.len() <= backwards.len());
            }
            assert_eq!(
                backwards, forwards,
                "backwards and catch-up must cover the same exact frames"
            );
            counts.push(
                json!({"bodyBytes":target.body_bytes,"visibleMessages":target.visible_offsets.len(),
                "eventFrames":backwards.len(),"messageDuplicates":0,"frameDuplicates":0}),
            );
        }
        let wall_ms = first_process_read.elapsed().as_secs_f64() * 1000.0;
        let snapshot = rpc(&gateway, "mobs.v1.teamSnapshot", scope(&root)).await;
        assert_eq!(
            snapshot["loaded"], false,
            "history reads must not register a runtime"
        );
        assert_eq!(
            fingerprints(&root),
            manifest.databases,
            "reads must not mutate database or nonempty WAL bytes"
        );
        assert!(gateway.shutdown().await.is_empty());
        save(
            &root.join(format!("read-{pass}.json")),
            &json!({
                "measurement":"Actual native SQLite plus gateway history handler and response serialization",
                "coldDefinition":"Fresh process, first target touch; OS page cache is not flushed",
                "notMeasured":["Rendered UX","WebSocket transport","live inference","Rust heap allocation"],
                "wallMs":wall_ms,"samples":samples,"targets":counts,"nativeRuntimeAdmissions":0,
                "databaseBytesUnchanged":true,"fingerprintScope":"Main databases and all nonempty WALs; empty WAL sidecars and transient SHM files excluded",
                "pageLimit":PAGE,"dataset":manifest.dataset
            }),
        );
    });
}
fn cursor(value: &str) -> u64 {
    value.strip_prefix("console:").unwrap().parse().unwrap()
}
