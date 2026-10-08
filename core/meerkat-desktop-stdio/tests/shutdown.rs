use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

struct Gateway(Child);
impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn shutdown_proof(signal: bool) {
    let mut gateway = Gateway(
        Command::new(env!("CARGO_BIN_EXE_meerkat-desktop-stdio"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("start isolated stdio gateway"),
    );
    let mut stdin = gateway.0.stdin.take().unwrap();
    let stdout = gateway.0.stdout.take().unwrap();
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if send.send(line).is_err() {
                break;
            }
        }
    });
    writeln!(
        stdin,
        "{{\"jsonrpc\":\"2.0\",\"id\":\"ready\",\"method\":\"system.v1.health\",\"params\":{{}}}}"
    )
    .unwrap();
    let ready: serde_json::Value = serde_json::from_str(
        &receive
            .recv_timeout(Duration::from_secs(10))
            .expect("gateway ready"),
    )
    .unwrap();
    assert_eq!(ready["id"], "ready");
    if signal {
        // Only this test's captured child PID is signalled. Keep stdin open to
        // reproduce the runtime's uncancellable blocking read after SIGTERM.
        assert!(
            Command::new("kill")
                .args(["-TERM", &gateway.0.id().to_string()])
                .status()
                .unwrap()
                .success()
        );
    } else {
        drop(stdin);
    }
    let receipt: serde_json::Value = serde_json::from_str(
        &receive
            .recv_timeout(Duration::from_secs(10))
            .expect("shutdown receipt"),
    )
    .unwrap();
    assert_eq!(receipt["method"], "system.v1.shutdownComplete");
    assert_eq!(receipt["params"]["cleanupCompleted"], true);
    assert_eq!(receipt["params"]["errors"], serde_json::json!([]));
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = gateway.0.try_wait().unwrap() {
            assert!(status.success(), "gateway exit: {status}");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "gateway stayed alive after cleanup receipt"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn eof_emits_cleanup_receipt_and_exits() {
    shutdown_proof(false);
}

#[cfg(unix)]
#[test]
fn sigterm_exits_while_parent_keeps_stdin_open() {
    shutdown_proof(true);
}
