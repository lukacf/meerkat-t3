#![recursion_limit = "256"]

mod auxiliary_requests;

use anyhow::Result;
use meerkat_desktop_contracts::{EventEmit, RequestContext, RpcRequest};
use meerkat_desktop_gateway::MeerkatGateway;
use serde_json::json;
use tokio::io::{self, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tracing_subscriber::EnvFilter;

const MAX_GENERAL_FRAME_BYTES: usize = 256 * 1024;
const MAX_SCREENSHOT_COMPLETION_FRAME_BYTES: usize = 6 * 1024 * 1024;
const MAX_IMAGE_UPLOAD_FRAME_BYTES: usize = 14 * 1024 * 1024;

#[derive(Debug)]
enum ShutdownTrigger {
    StdinEof,
    StdinError(std::io::Error),
    Sigint,
    #[cfg(unix)]
    Sigterm,
}

impl ShutdownTrigger {
    fn diagnostic(&self) -> serde_json::Value {
        match self {
            Self::StdinEof => json!({"kind": "stdin_eof"}),
            Self::StdinError(error) => json!({
                "kind": "stdin_error",
                // ErrorKind and the OS code describe the transport failure
                // without exposing a custom error's paths or provider data.
                "errorKind": format!("{:?}", error.kind()),
                "rawOsError": error.raw_os_error(),
            }),
            Self::Sigint => json!({"kind": "sigint"}),
            #[cfg(unix)]
            Self::Sigterm => json!({"kind": "sigterm"}),
        }
    }
}

fn main() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(16 * 1024 * 1024)
        .build()?;
    let result = runtime.block_on(async_main());
    // Successful async_main completion means native cleanup and stdout drained.
    // On failure, stdin or a request may still be blocked in synchronous I/O.
    // Do not let runtime destruction turn a bounded failure into an endless wait.
    runtime.shutdown_background();
    result
}

async fn async_main() -> Result<()> {
    // Structured logs to stderr (never interleave with JSON-RPC stdout).
    // Keep logs NO-PII: do not log prompt text, file contents, or tool outputs.
    // Control verbosity via RUST_LOG, e.g.:
    //   RUST_LOG=info,meerkat_desktop_gateway=debug
    // Defaults to `info`.
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_ansi(false)
        .with_writer(std::io::stderr)
        .try_init()
        .ok();

    let gateway = MeerkatGateway::new();
    let events_rx = gateway.subscribe_events();
    let mut host_tools_rx = gateway.subscribe_host_tool_notifications();

    // Single-writer channel for stdout so JSON-RPC responses and event notifications
    // can never interleave bytes across tasks.
    let (out_tx, out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let writer_task = tokio::spawn(write_output(io::stdout(), out_rx));
    let (drain_events, drain_requested) = oneshot::channel();
    let event_task = tokio::spawn(forward_events(events_rx, out_tx.clone(), drain_requested));

    let host_tool_tx = out_tx.clone();
    let host_tool_gateway = gateway.clone();
    let host_tool_task = tokio::spawn(async move {
        loop {
            let notification = match host_tools_rx.recv().await {
                Ok(notification) => notification,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    // Losing even one reverse call is an authority failure, not
                    // a best-effort event-stream condition. Fence every call;
                    // a later configure handshake may establish fresh state.
                    tracing::error!(
                        skipped,
                        "host-tool notification bridge lagged; fencing calls"
                    );
                    host_tool_gateway.disconnect_host_tools().await;
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            let message = notification.into_json_rpc();
            let Ok(line) = serde_json::to_vec(&message) else {
                host_tool_gateway.disconnect_host_tools().await;
                continue;
            };
            if host_tool_tx.send(line).is_err() {
                host_tool_gateway.disconnect_host_tools().await;
                break;
            }
        }
    });

    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin);
    let mut requests = tokio::task::JoinSet::new();
    let auxiliary_requests = auxiliary_requests::AuxiliaryRequests::default();
    let termination = termination_signal();
    tokio::pin!(termination);

    let shutdown_trigger = loop {
        while requests.try_join_next().is_some() {}
        let frame = tokio::select! {
            frame = read_input_frame(&mut reader) => match frame {
                Ok(frame) => frame,
                Err(trigger) => break trigger,
            },
            trigger = &mut termination => break trigger,
        };
        if frame.as_ref().is_ok_and(|line| line.trim().is_empty()) {
            continue;
        }
        let parsed = frame.and_then(|line| parse_request_line(&line));
        let cancellation = if let Ok(request) = &parsed {
            if request.method == "text.v1.cancel" {
                let response = auxiliary_requests.cancel(request);
                let _ = out_tx.send(serde_json::to_vec(&response)?);
                continue;
            }
            match auxiliary_requests.register(request) {
                Ok(cancellation) => cancellation,
                Err(response) => {
                    let _ = out_tx.send(serde_json::to_vec(&response)?);
                    continue;
                }
            }
        } else {
            None
        };
        let tx = out_tx.clone();
        let gateway = gateway.clone();

        requests.spawn(async move {
            let response = match parsed {
                Ok(request) => {
                    let id = request.id.clone();
                    let work = gateway.handle(request, RequestContext::local());
                    match cancellation {
                        Some(cancellation) => cancellation.run(id, work).await,
                        None => work.await,
                    }
                }
                Err(e) => meerkat_desktop_contracts::RpcResponse::err(
                    None,
                    -32602,
                    format!("Invalid request: {e}"),
                    "INVALID_REQUEST",
                    uuid::Uuid::new_v4().to_string(),
                    None,
                ),
            };

            if let Ok(encoded) = serde_json::to_vec(&response) {
                let _ = tx.send(encoded);
            }
        });
    };

    // Keep output forwarding alive until the runtime drains and the admitted
    // RPC tasks have settled. EOF and termination signals use the same path.
    let deadline = tokio::time::Instant::now() + MeerkatGateway::shutdown_horizon();
    let mut failures = finish_native_cleanup(
        gateway.shutdown(),
        gateway.drain_storage_observers(),
        gateway.settle_credential_mutations(deadline),
        &mut requests,
        deadline,
    ).await;
    host_tool_task.abort();
    if tokio::time::timeout_at(deadline, host_tool_task).await.is_err() {
        failures.push("Host-tool bridge exceeded the shutdown deadline".to_string());
    }
    // On success, all admitted producers have settled. After a deadline failure,
    // a blocked task may retain an output sender. Attempt the terminal-event and
    // receipt drain within the same deadline, without promising receipt delivery.
    let _ = drain_events.send(());
    if let Err(error) = finish_output_task(event_task, deadline).await {
        failures.push(format!("Event bridge could not drain: {error}"));
    }
    let _ = out_tx.send(serde_json::to_vec(&json!({
        "jsonrpc":"2.0", "method":"system.v1.shutdownComplete",
        "params":{
            "cleanupCompleted":failures.is_empty(),
            "errors":failures,
            "trigger":shutdown_trigger.diagnostic()
        }
    }))?);
    drop(out_tx);
    // A parent may retain stdout without reading it. Transport drain shares the
    // native shutdown deadline and cannot hold the process alive indefinitely.
    finish_output_task(writer_task, deadline).await?;
    if let ShutdownTrigger::StdinError(error) = shutdown_trigger {
        return Err(error.into());
    }
    anyhow::ensure!(
        failures.is_empty(),
        "Native runtime cleanup did not complete"
    );
    Ok(())
}

async fn finish_native_cleanup(
    shutdown: impl std::future::Future<Output = Vec<String>>,
    drain_observers: impl std::future::Future<Output = Vec<String>>,
    settle_credentials: impl std::future::Future<Output = Vec<String>>,
    requests: &mut tokio::task::JoinSet<()>,
    deadline: tokio::time::Instant,
) -> Vec<String> {
    match tokio::time::timeout_at(deadline, async {
        let mut failures = shutdown.await;
        while let Some(result) = requests.join_next().await {
            if let Err(error) = result {
                failures.push(format!("An admitted request failed during shutdown: {error}"));
            }
        }
        // Requests can hold the last runtime/store clones. Only observe stores
        // after they have joined, under the same process shutdown deadline.
        if failures.is_empty() {
            failures.extend(drain_observers.await);
            // Observer refusals do not reopen request admission. Credential
            // work still has to settle, and every phase shares this deadline.
            failures.extend(settle_credentials.await);
        }
        failures
    })
    .await
    {
        Ok(failures) => failures,
        Err(_) => {
            // Abort only requests cancellation. A task blocked inside its poll
            // cannot observe it yet, so joining here could exceed the deadline.
            requests.abort_all();
            vec!["Native shutdown exceeded its published horizon".to_string()]
        }
    }
}

async fn write_output<W: io::AsyncWrite + Unpin>(
    mut stdout: W,
    mut output: mpsc::UnboundedReceiver<Vec<u8>>,
) -> std::io::Result<()> {
    while let Some(line) = output.recv().await {
        stdout.write_all(&line).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;
    }
    Ok(())
}

async fn finish_output_task(
    mut task: tokio::task::JoinHandle<std::io::Result<()>>,
    deadline: tokio::time::Instant,
) -> std::io::Result<()> {
    match tokio::time::timeout_at(deadline, &mut task).await {
        Ok(result) => result.map_err(std::io::Error::other)?,
        Err(_) => {
            task.abort();
            Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "Output drain exceeded the shutdown deadline",
            ))
        }
    }
}

async fn forward_events(
    mut events: tokio::sync::broadcast::Receiver<EventEmit>,
    output: mpsc::UnboundedSender<Vec<u8>>,
    mut drain: oneshot::Receiver<()>,
) -> std::io::Result<()> {
    loop {
        let event = tokio::select! {
            biased;
            _ = &mut drain => break,
            event = recv_event_after_lag(&mut events) => event,
        };
        let Some(event) = event else { return Ok(()) };
        forward_event(event, &output)?;
    }
    let mut lagged = false;
    loop {
        match events.try_recv() {
            Ok(event) => forward_event(event, &output)?,
            Err(
                tokio::sync::broadcast::error::TryRecvError::Empty
                | tokio::sync::broadcast::error::TryRecvError::Closed,
            ) => {
                return if lagged {
                    Err(std::io::Error::other(
                        "Terminal event bridge lagged while draining",
                    ))
                } else {
                    Ok(())
                };
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {
                // Lag advances to the oldest retained event. Deliver everything
                // still available, then report the gap instead of claiming a full drain.
                lagged = true;
            }
        }
    }
}

fn forward_event(event: EventEmit, output: &mpsc::UnboundedSender<Vec<u8>>) -> std::io::Result<()> {
    let message = json!({"jsonrpc":"2.0","method":"events.v1.emit","params":event});
    output.send(serde_json::to_vec(&message)?).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::BrokenPipe, "Event output writer closed")
    })
}

#[cfg(unix)]
async fn termination_signal() -> ShutdownTrigger {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("register SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => ShutdownTrigger::Sigint,
        _ = terminate.recv() => ShutdownTrigger::Sigterm,
    }
}

#[cfg(not(unix))]
async fn termination_signal() -> ShutdownTrigger {
    let _ = tokio::signal::ctrl_c().await;
    ShutdownTrigger::Sigint
}

async fn read_input_frame<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> std::result::Result<Result<String, String>, ShutdownTrigger> {
    match read_frame(reader).await {
        Ok(Some(frame)) => Ok(frame),
        Ok(None) => Err(ShutdownTrigger::StdinEof),
        Err(error) => Err(ShutdownTrigger::StdinError(error)),
    }
}

async fn read_frame<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> std::io::Result<Option<Result<String, String>>> {
    let mut bytes = Vec::new();
    let mut oversized = false;
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            if bytes.is_empty() && !oversized {
                return Ok(None);
            }
            break;
        }
        let newline = chunk.iter().position(|byte| *byte == b'\n');
        let end = newline.unwrap_or(chunk.len());
        if bytes.len() + end > MAX_IMAGE_UPLOAD_FRAME_BYTES {
            oversized = true;
        }
        if !oversized {
            bytes.extend_from_slice(&chunk[..end]);
        }
        let consumed = end + usize::from(newline.is_some());
        reader.consume(consumed);
        if newline.is_some() {
            break;
        }
    }
    Ok(Some(if oversized {
        Err("request exceeds maximum protocol frame limit".into())
    } else {
        String::from_utf8(bytes).map_err(|_| "request is not valid UTF-8".into())
    }))
}

fn parse_request_line(line: &str) -> Result<RpcRequest, String> {
    if line.len() > MAX_IMAGE_UPLOAD_FRAME_BYTES {
        return Err("request exceeds maximum protocol frame limit".to_string());
    }
    let request: RpcRequest = serde_json::from_str(line).map_err(|error| error.to_string())?;
    let limit = match request.method.as_str() {
        "mobs.v1.imageUpload" => MAX_IMAGE_UPLOAD_FRAME_BYTES,
        "desktop.hostTools.complete.v1" => MAX_SCREENSHOT_COMPLETION_FRAME_BYTES,
        _ => MAX_GENERAL_FRAME_BYTES,
    };
    if line.len() > limit {
        return Err("request exceeds method protocol frame limit".to_string());
    }
    Ok(request)
}

async fn recv_event_after_lag(
    events_rx: &mut tokio::sync::broadcast::Receiver<EventEmit>,
) -> Option<EventEmit> {
    loop {
        match events_rx.recv().await {
            Ok(event) => return Some(event),
            Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                // A slow stdout consumer may lose intermediate deltas, but it
                // must remain subscribed so the authoritative final and run
                // terminal can still repair the renderer state.
                tracing::warn!(skipped, "desktop event bridge lagged; continuing");
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{MAX_GENERAL_FRAME_BYTES, parse_request_line, recv_event_after_lag};
    use meerkat_desktop_contracts::EventEmit;
    use serde_json::json;

    struct FailingReader(Option<std::io::Error>);

    impl tokio::io::AsyncRead for FailingReader {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            _buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Err(self.0.take().expect("one failed read")))
        }
    }

    #[tokio::test]
    async fn stdin_failure_after_a_frame_retains_cause_without_leaking_error_text() {
        use tokio::io::AsyncReadExt;

        let private_detail = "/private/customer/project: provider response text";
        let input = b"{}\n"
            .as_slice()
            .chain(FailingReader(Some(std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                private_detail,
            ))));
        let mut reader = tokio::io::BufReader::new(input);
        assert_eq!(
            super::read_input_frame(&mut reader).await.unwrap().unwrap(),
            "{}"
        );
        let trigger = super::read_input_frame(&mut reader).await.unwrap_err();
        let diagnostic = trigger.diagnostic();
        assert_eq!(
            diagnostic,
            json!({
                "kind": "stdin_error", "errorKind": "WouldBlock", "rawOsError": null
            })
        );
        assert!(!diagnostic.to_string().contains(private_detail));
        let super::ShutdownTrigger::StdinError(error) = trigger else {
            panic!("a read failure must not be classified as EOF");
        };
        // The original error still reaches main's existing nonzero exit path.
        assert_eq!(error.to_string(), private_detail);
    }

    #[tokio::test]
    async fn stdin_os_failure_retains_numeric_code() {
        let mut reader = tokio::io::BufReader::new(FailingReader(Some(
            std::io::Error::from_raw_os_error(9),
        )));
        let trigger = super::read_input_frame(&mut reader).await.unwrap_err();
        assert_eq!(trigger.diagnostic()["kind"], "stdin_error");
        assert_eq!(trigger.diagnostic()["rawOsError"], 9);
        let super::ShutdownTrigger::StdinError(error) = trigger else {
            panic!("an OS read failure must not be classified as EOF");
        };
        assert_eq!(error.raw_os_error(), Some(9));
    }

    #[tokio::test]
    async fn stdin_eof_follows_the_final_unterminated_frame() {
        let mut reader = tokio::io::BufReader::new(b"{}".as_slice());
        assert_eq!(
            super::read_input_frame(&mut reader).await.unwrap().unwrap(),
            "{}"
        );
        let trigger = super::read_input_frame(&mut reader).await.unwrap_err();
        assert!(matches!(trigger, super::ShutdownTrigger::StdinEof));
        assert_eq!(trigger.diagnostic(), json!({"kind": "stdin_eof"}));
    }

    fn event(kind: &str) -> EventEmit {
        EventEmit {
            event_id: kind.to_string(),
            kind: kind.to_string(),
            timestamp: serde_json::from_str("\"2026-07-13T14:00:00Z\"").expect("valid timestamp"),
            thread_id: Some("thread-stream".to_string()),
            run_id: Some("run-stream".to_string()),
            payload: json!({}),
            trace_id: "trace-stream".to_string(),
        }
    }

    #[tokio::test]
    async fn lagged_event_receiver_stays_alive_for_authoritative_terminal() {
        let (tx, mut rx) = tokio::sync::broadcast::channel(1);
        tx.send(event("run.output.delta")).expect("send delta");
        tx.send(event("run.output.complete")).expect("send final");

        let received = recv_event_after_lag(&mut rx)
            .await
            .expect("receiver should continue after lag");
        assert_eq!(received.kind, "run.output.complete");
    }

    #[tokio::test]
    async fn terminal_events_are_forwarded_before_shutdown_receipt() {
        let (events, receiver) = tokio::sync::broadcast::channel(16);
        let (output, mut lines) = tokio::sync::mpsc::unbounded_channel();
        let (drain, requested) = tokio::sync::oneshot::channel();
        events.send(event("run.output.complete")).unwrap();
        events.send(event("run.completed")).unwrap();
        drain.send(()).unwrap();
        // Queue the drain before the forwarder runs to exercise the case that
        // previously aborted the task with terminal notifications still pending.
        let task = tokio::spawn(super::forward_events(receiver, output.clone(), requested));
        super::finish_output_task(
            task,
            tokio::time::Instant::now() + std::time::Duration::from_secs(1),
        )
        .await
        .unwrap();
        output
            .send(serde_json::to_vec(&json!({"method":"system.v1.shutdownComplete"})).unwrap())
            .unwrap();
        drop(output);
        let mut messages = Vec::new();
        while let Some(line) = lines.recv().await {
            messages.push(serde_json::from_slice::<serde_json::Value>(&line).unwrap());
        }
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["params"]["kind"], "run.output.complete");
        assert_eq!(messages[1]["params"]["kind"], "run.completed");
        assert_eq!(messages[2]["method"], "system.v1.shutdownComplete");
    }

    #[tokio::test]
    async fn retained_unread_output_cannot_exceed_shutdown_deadline() {
        let (pipe, _unread_parent) = tokio::io::duplex(16);
        let (output, receiver) = tokio::sync::mpsc::unbounded_channel();
        output.send(vec![b'x'; 4096]).unwrap();
        drop(output);
        let task = tokio::spawn(super::write_output(pipe, receiver));
        let error = super::finish_output_task(
            task,
            tokio::time::Instant::now() + std::time::Duration::from_millis(20),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    }

    #[tokio::test]
    async fn native_cleanup_drains_admitted_requests_before_success() {
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
        struct RequestGuard(Arc<AtomicBool>);
        impl Drop for RequestGuard {
            fn drop(&mut self) { self.0.store(true, Ordering::SeqCst); }
        }
        let dropped = Arc::new(AtomicBool::new(false));
        let guard = RequestGuard(Arc::clone(&dropped));
        let mut requests = tokio::task::JoinSet::new();
        let (release, released) = tokio::sync::oneshot::channel();
        let (settled, settlement) = tokio::sync::oneshot::channel();
        requests.spawn(async move {
            released.await.unwrap();
            settled.send(()).unwrap();
            drop(guard);
        });
        let failures = super::finish_native_cleanup(
            async move {
                release.send(()).unwrap();
                Vec::new()
            },
            async move {
                assert!(dropped.load(Ordering::SeqCst), "observer phase ran before request-owned handles dropped");
                settlement.await.unwrap();
                Vec::new()
            },
            async { Vec::new() },
            &mut requests,
            tokio::time::Instant::now() + std::time::Duration::from_secs(1),
        )
        .await;
        assert!(failures.is_empty());
        assert!(requests.is_empty());
    }

    #[tokio::test]
    async fn native_cleanup_preserves_reported_failures() {
        let mut requests = tokio::task::JoinSet::new();
        let failures = super::finish_native_cleanup(
            async { vec!["fixture cleanup failure".to_string()] },
            async { panic!("Observer drain must not follow failed native shutdown") },
            async { Vec::new() },
            &mut requests,
            tokio::time::Instant::now() + std::time::Duration::from_secs(1),
        )
        .await;
        assert_eq!(failures, ["fixture cleanup failure"]);
    }

    #[tokio::test]
    async fn native_cleanup_preserves_observer_failures() {
        let mut requests = tokio::task::JoinSet::new();
        let failures = super::finish_native_cleanup(
            async { Vec::new() },
            async { vec!["mob observer still held".into()] },
            async { Vec::new() },
            &mut requests,
            tokio::time::Instant::now() + std::time::Duration::from_secs(1),
        ).await;
        assert_eq!(failures, ["mob observer still held"]);
    }

    #[tokio::test]
    async fn native_cleanup_settles_credentials_after_observers_and_preserves_pending() {
        use std::sync::{Arc, Mutex};
        let phases = Arc::new(Mutex::new(Vec::new()));
        let native_phases = Arc::clone(&phases);
        let observer_phases = Arc::clone(&phases);
        let credential_phases = Arc::clone(&phases);
        let mut requests = tokio::task::JoinSet::new();
        let failures = super::finish_native_cleanup(
            async move {
                native_phases.lock().unwrap().push("native");
                Vec::new()
            },
            async move {
                observer_phases.lock().unwrap().push("observers");
                vec!["observer refusal".into()]
            },
            async move {
                credential_phases.lock().unwrap().push("credentials");
                vec!["credential work remains pending".into()]
            },
            &mut requests,
            tokio::time::Instant::now() + std::time::Duration::from_secs(1),
        ).await;
        assert_eq!(*phases.lock().unwrap(), ["native", "observers", "credentials"]);
        assert_eq!(failures, ["observer refusal", "credential work remains pending"]);
    }

    #[tokio::test]
    async fn native_cleanup_bounds_pending_credential_work_with_the_original_deadline() {
        let mut requests = tokio::task::JoinSet::new();
        let failures = super::finish_native_cleanup(
            async { Vec::new() },
            async { Vec::new() },
            std::future::pending(),
            &mut requests,
            tokio::time::Instant::now(),
        ).await;
        assert_eq!(failures, ["Native shutdown exceeded its published horizon"]);
    }

    #[tokio::test]
    async fn native_cleanup_does_not_drain_after_request_panic() {
        let mut requests = tokio::task::JoinSet::new();
        requests.spawn(async { panic!("fixture admitted request panic") });
        let failures = super::finish_native_cleanup(
            async { Vec::new() },
            async { panic!("Observer drain must not follow a failed request") },
            async { Vec::new() },
            &mut requests,
            tokio::time::Instant::now() + std::time::Duration::from_secs(1),
        ).await;
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("An admitted request failed during shutdown"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocked_request_poll_cannot_extend_cleanup_or_output_deadline() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Condvar, Mutex};
        use std::time::Duration;

        let blocked = Arc::new((Mutex::new(false), Condvar::new()));
        let request_blocked = blocked.clone();
        let (entered, entry) = tokio::sync::oneshot::channel();
        let (output, receiver) = tokio::sync::mpsc::unbounded_channel();
        let writer = tokio::spawn(super::write_output(tokio::io::sink(), receiver));
        let mut requests = tokio::task::JoinSet::new();
        requests.spawn(async move {
            let (released, wake) = &*request_blocked;
            let mut released = released.lock().unwrap();
            entered.send(()).unwrap();
            // Deliberately block inside poll, as a synchronous OS call does.
            // pending().await would yield and therefore miss this regression.
            while !*released {
                released = wake.wait(released).unwrap();
            }
            drop(released);
            drop(output);
        });

        let watchdog_fired = Arc::new(AtomicBool::new(false));
        let watchdog_flag = watchdog_fired.clone();
        let watchdog_blocked = blocked.clone();
        let watchdog = std::thread::spawn(move || {
            let (released, wake) = &*watchdog_blocked;
            let (mut released, _) = wake
                .wait_timeout_while(released.lock().unwrap(), Duration::from_secs(3), |done| !*done)
                .unwrap();
            if !*released {
                // A broken implementation must fail the assertion, not hang
                // the whole test runtime waiting for this worker to finish.
                watchdog_flag.store(true, Ordering::SeqCst);
                *released = true;
                wake.notify_all();
            }
        });
        tokio::time::timeout(Duration::from_secs(1), entry)
            .await
            .expect("request entered its blocking poll")
            .unwrap();

        let started = std::time::Instant::now();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(40);
        let failures = super::finish_native_cleanup(
            async { Vec::new() },
            async { panic!("Observer drain must not follow an unjoined request") },
            async { Vec::new() },
            &mut requests,
            deadline,
        )
            .await;
        let returned_while_blocked = !*blocked.0.lock().unwrap();
        // The still-blocked request owns the sender. An expired deadline must
        // bound output closure too; a shutdown receipt is not guaranteed here.
        let output_result = super::finish_output_task(writer, deadline).await;
        let elapsed = started.elapsed();

        // Release and join before assertions, including on a regression that
        // needed the watchdog. Abort cannot clean up a synchronous poll alone.
        {
            let (released, wake) = &*blocked;
            *released.lock().unwrap() = true;
            wake.notify_all();
        }
        watchdog.join().unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while requests.join_next().await.is_some() {}
        })
        .await
        .expect("released request task joins");

        assert!(returned_while_blocked, "cleanup waited for the blocked poll");
        assert!(!watchdog_fired.load(Ordering::SeqCst));
        assert!(elapsed < Duration::from_secs(1), "elapsed: {elapsed:?}");
        assert_eq!(failures, ["Native shutdown exceeded its published horizon"]);
        assert_eq!(output_result.unwrap_err().kind(), std::io::ErrorKind::TimedOut);
        assert!(requests.is_empty());
    }

    #[tokio::test]
    async fn lagged_final_drain_retains_terminal_and_reports_gap() {
        let (events, receiver) = tokio::sync::broadcast::channel(1);
        let (output, mut lines) = tokio::sync::mpsc::unbounded_channel();
        let (drain, requested) = tokio::sync::oneshot::channel();
        events.send(event("run.output.delta")).unwrap();
        events.send(event("run.completed")).unwrap();
        drain.send(()).unwrap();
        let error = super::forward_events(receiver, output, requested)
            .await
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::Other);
        let terminal: serde_json::Value =
            serde_json::from_slice(&lines.recv().await.unwrap()).unwrap();
        assert_eq!(terminal["params"]["kind"], "run.completed");
        assert!(lines.recv().await.is_none());
    }

    #[tokio::test]
    async fn closed_output_is_reported_as_a_drain_failure() {
        let (pipe, parent) = tokio::io::duplex(16);
        drop(parent);
        let (output, receiver) = tokio::sync::mpsc::unbounded_channel();
        output.send(b"terminal".to_vec()).unwrap();
        drop(output);
        let task = tokio::spawn(super::write_output(pipe, receiver));
        let error = super::finish_output_task(
            task,
            tokio::time::Instant::now() + std::time::Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
    }

    #[tokio::test]
    async fn frame_reader_drains_oversized_line_and_preserves_next_request() {
        let mut input = vec![b'x'; super::MAX_IMAGE_UPLOAD_FRAME_BYTES + 1];
        input.extend_from_slice(b"\n{}\n");
        let mut reader = tokio::io::BufReader::new(input.as_slice());
        assert!(
            super::read_frame(&mut reader)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert_eq!(
            super::read_frame(&mut reader)
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
            "{}"
        );
        assert!(super::read_frame(&mut reader).await.unwrap().is_none());
    }

    #[test]
    fn oversized_frames_are_limited_by_method() {
        let padding = "a".repeat(MAX_GENERAL_FRAME_BYTES);
        let ordinary = serde_json::json!({
            "jsonrpc": "2.0",
            "id": "ordinary",
            "method": "configs.v1.get",
            "params": {"padding": padding}
        })
        .to_string();
        assert!(parse_request_line(&ordinary).is_err());

        let upload = json!({"jsonrpc":"2.0","id":"upload","method":"mobs.v1.imageUpload","params":{"dataBase64":"a".repeat(MAX_GENERAL_FRAME_BYTES)}}).to_string();
        assert_eq!(
            parse_request_line(&upload).unwrap().method,
            "mobs.v1.imageUpload"
        );
        let over_limit = json!({"jsonrpc":"2.0","id":"upload","method":"mobs.v1.imageUpload","params":{"dataBase64":"a".repeat(super::MAX_IMAGE_UPLOAD_FRAME_BYTES)}}).to_string();
        assert!(parse_request_line(&over_limit).is_err());

        let completion = serde_json::json!({
            "jsonrpc": "2.0",
            "id": "image",
            "method": "desktop.hostTools.complete.v1",
            "params": {
                "callId": "call-image",
                "outcome": {
                    "kind": "result",
                    "value": {},
                    "imageContent": {
                        "mediaType": "image/png",
                        "dataBase64": "a".repeat(MAX_GENERAL_FRAME_BYTES),
                        "encodedBytes": 1,
                        "sha256": "0".repeat(64)
                    }
                }
            }
        })
        .to_string();
        assert_eq!(
            parse_request_line(&completion)
                .expect("large completion reaches semantic validator")
                .method,
            "desktop.hostTools.complete.v1"
        );
    }
}
