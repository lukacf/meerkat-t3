//! Desktop access choices lower to the native, persisted tool execution policy.
//! A saved conversation's policy is never replaced by a reconnect preference.
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};

use meerkat_core::{
    ops::ToolAccessPolicy,
    types::{ToolCallView, ToolDef, ToolResult},
    AgentToolDispatcher, ToolDispatchOutcome, ToolError, ToolMutationClass,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ExecutionMode {
    ReadOnly,
    #[serde(rename = "approval-required")]
    Approvals,
    #[default]
    FullAccess,
}

impl ExecutionMode {
    pub(crate) fn tool_policy(self) -> Option<ToolAccessPolicy> {
        match self {
            Self::ReadOnly => Some(ToolAccessPolicy::ReadOnly),
            Self::FullAccess | Self::Approvals => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::Approvals => "approval-required",
            Self::FullAccess => "full-access",
        }
    }
}

pub(crate) fn requested_mode(
    params: &Map<String, Value>,
) -> Result<Option<ExecutionMode>, crate::GatewayError> {
    params.get("accessMode").map(|value| {
        serde_json::from_value(value.clone()).map_err(|_| crate::GatewayError::invalid(
            "Meerkat supports read-only, approvals, and full-access execution.", None,
        ))
    }).transpose()
}

pub(crate) fn persisted_mode(policy: Option<&ToolAccessPolicy>) -> Result<ExecutionMode, String> {
    match policy {
        None => Ok(ExecutionMode::FullAccess),
        Some(policy) => {
            let resolved = meerkat_core::ToolExecutionPolicy::resolve(policy.clone())
                .map_err(|error| error.to_string())?;
            if resolved.is_unrestricted() {
                Ok(ExecutionMode::FullAccess)
            } else if resolved.is_read_only_intent() {
                Ok(ExecutionMode::ReadOnly)
            } else {
                Err("This native conversation has a custom tool policy. Its access mode cannot be replaced by the desktop picker.".into())
            }
        }
    }
}

pub(crate) fn validate_requested_mode(
    requested: Option<ExecutionMode>,
    persisted: ExecutionMode,
) -> Result<ExecutionMode, String> {
    if requested.is_some_and(|mode| mode != persisted) {
        return Err(format!(
            "This conversation uses {} access. Start a new conversation to choose a different access mode; reconnecting preserves the native policy.",
            persisted.as_str(),
        ));
    }
    Ok(persisted)
}

/// Read-only agents cannot invoke shell, even for `cat` or `rg`. These small
/// host-owned tools provide repository context without executing a command.
pub(crate) fn workspace_reader(root: PathBuf) -> Arc<dyn AgentToolDispatcher> {
    Arc::new(WorkspaceReader { root })
}

struct WorkspaceReader {
    root: PathBuf,
}

const MAX_READ_BYTES: usize = 128 * 1024;
const MAX_SCAN_ENTRIES: usize = 5_000;
const MAX_MATCHES: usize = 100;

fn definitions() -> Arc<[Arc<ToolDef>]> {
    [
        ToolDef::new("workspace_read_file", "Read a UTF-8 file in the workspace without running commands. Results include line numbers and are bounded to 128 KiB.", json!({
            "type":"object", "additionalProperties":false, "required":["path"],
            "properties":{"path":{"type":"string"},"startLine":{"type":"integer","minimum":1},"limit":{"type":"integer","minimum":1,"maximum":500}}
        })),
        ToolDef::new("workspace_list_files", "List files or directories in a workspace directory without running commands. Skips generated and dependency directories.", json!({
            "type":"object", "additionalProperties":false,
            "properties":{"path":{"type":"string"},"recursive":{"type":"boolean"}}
        })),
        ToolDef::new("workspace_search", "Find literal text in workspace UTF-8 files without running commands. Returns file names, line numbers and bounded matching lines. Skips generated and dependency directories.", json!({
            "type":"object", "additionalProperties":false, "required":["query"],
            "properties":{"path":{"type":"string"},"query":{"type":"string","minLength":1},"caseSensitive":{"type":"boolean"}}
        })),
    ].into_iter().map(Arc::new).collect::<Vec<_>>().into()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadArgs {
    path: String,
    start_line: Option<usize>,
    limit: Option<usize>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    path: Option<String>,
    recursive: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchArgs {
    path: Option<String>,
    query: String,
    case_sensitive: Option<bool>,
}

fn owned_path(root: &Path, supplied: &str) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let path = root
        .join(supplied)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !path.starts_with(&root) {
        return Err("Choose a path inside this workspace.".into());
    }
    Ok(path)
}

fn read_bounded(path: &Path) -> Result<(String, bool), String> {
    // Reject stable special files before opening them. In particular, opening
    // a FIFO for reading can wait forever for a writer.
    if !std::fs::symlink_metadata(path)
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Choose a regular file.".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A replacement FIFO must not block open, and a replacement final
        // symlink must not be followed. Check the opened descriptor below too.
        // This is not descriptor-relative workspace confinement: ancestor
        // replacement races and blocking regular-file I/O remain possible.
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|error| error.to_string())?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Choose a regular file.".into());
    }
    let mut bytes = Vec::new();
    file.take((MAX_READ_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let truncated = bytes.len() > MAX_READ_BYTES;
    if bytes.contains(&0) {
        return Err("This file is binary.".into());
    }
    let text = if truncated {
        bytes.truncate(MAX_READ_BYTES);
        // A byte cap can bisect the final UTF-8 codepoint. Do not reject an
        // otherwise valid text file solely because its last character was cut.
        match std::str::from_utf8(&bytes) {
            Ok(text) => text.to_owned(),
            Err(error) if error.error_len().is_none() => {
                String::from_utf8(bytes[..error.valid_up_to()].to_vec())
                    .map_err(|error| error.to_string())?
            }
            Err(error) => return Err(error.to_string()),
        }
    } else {
        String::from_utf8(bytes).map_err(|error| error.to_string())?
    };
    Ok((text, truncated))
}

fn collect_bounded_entries<T, E>(
    entries: impl Iterator<Item = Result<T, E>>,
    remaining: &mut usize,
) -> Result<(Vec<T>, bool), E> {
    let mut children = Vec::new();
    for entry in entries {
        // One lookahead distinguishes an exhausted iterator from truncation.
        // Count every entry, even if traversal will later skip its name/type.
        if *remaining == 0 {
            return Ok((children, true));
        }
        *remaining -= 1;
        children.push(entry?);
    }
    Ok((children, false))
}

fn entries(
    root: &Path,
    directory: &Path,
    recursive: bool,
    mut remaining: usize,
) -> Result<(Vec<(PathBuf, bool)>, bool), String> {
    let mut pending = vec![directory.to_owned()];
    let mut found = Vec::new();
    while let Some(path) = pending.pop() {
        let (mut children, truncated) = collect_bounded_entries(
            std::fs::read_dir(path).map_err(|error| error.to_string())?,
            &mut remaining,
        )
        .map_err(|error| error.to_string())?;
        // Sort only the bounded batch. A truncated batch is not promised to
        // contain the alphabetically first entries of the complete directory.
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            if matches!(
                child.file_name().to_str(),
                Some(".git" | "node_modules" | "target" | ".next" | "dist" | ".venv")
            ) {
                continue;
            }
            let kind = child.file_type().map_err(|error| error.to_string())?;
            // Never follow directory symlinks during traversal.
            if kind.is_symlink() {
                continue;
            }
            if !kind.is_file() && !kind.is_dir() {
                continue;
            }
            let path = child.path();
            if !path.starts_with(root) {
                continue;
            }
            found.push((path.clone(), kind.is_dir()));
            if recursive && kind.is_dir() {
                pending.push(path);
            }
        }
        if truncated {
            return Ok((found, true));
        }
    }
    Ok((found, false))
}

impl WorkspaceReader {
    fn execute(&self, name: &str, args: &str) -> Result<Value, String> {
        let root = self
            .root
            .canonicalize()
            .map_err(|error| error.to_string())?;
        match name {
            "workspace_read_file" => {
                let input: ReadArgs =
                    serde_json::from_str(args).map_err(|error| error.to_string())?;
                let start = input.start_line.unwrap_or(1);
                let limit = input.limit.unwrap_or(300);
                if start == 0 || limit == 0 || limit > 500 {
                    return Err("Use startLine >= 1 and limit between 1 and 500.".into());
                }
                let path = owned_path(&root, &input.path)?;
                let (text, byte_truncated) = read_bounded(&path)?;
                let total = text.lines().count();
                let lines = text
                    .lines()
                    .enumerate()
                    .skip(start - 1)
                    .take(limit)
                    .map(|(index, line)| json!({"line":index+1,"text":line}))
                    .collect::<Vec<_>>();
                Ok(
                    json!({"path":path.strip_prefix(&root).map_err(|error|error.to_string())?,"lines":lines,"truncated":byte_truncated || total > start.saturating_sub(1).saturating_add(limit)}),
                )
            }
            "workspace_list_files" => {
                let input: ListArgs =
                    serde_json::from_str(args).map_err(|error| error.to_string())?;
                let path = owned_path(&root, input.path.as_deref().unwrap_or("."))?;
                let (found, truncated) = entries(
                    &root,
                    &path,
                    input.recursive.unwrap_or(false),
                    MAX_SCAN_ENTRIES,
                )?;
                let files = found.iter().map(|(path, directory)| json!({"path":path.strip_prefix(&root).unwrap_or(path),"directory":directory})).collect::<Vec<_>>();
                Ok(json!({"files":files,"truncated":truncated}))
            }
            "workspace_search" => {
                let input: SearchArgs =
                    serde_json::from_str(args).map_err(|error| error.to_string())?;
                if input.query.is_empty() || input.query.len() > 1024 {
                    return Err("Use a search query between 1 and 1024 bytes.".into());
                }
                let path = owned_path(&root, input.path.as_deref().unwrap_or("."))?;
                let (found, mut truncated) = if path.is_file() {
                    (vec![(path, false)], false)
                } else {
                    entries(&root, &path, true, MAX_SCAN_ENTRIES)?
                };
                let case_sensitive = input.case_sensitive.unwrap_or(false);
                let needle = if case_sensitive {
                    input.query
                } else {
                    input.query.to_lowercase()
                };
                let mut matches = Vec::new();
                let mut skipped = 0;
                for (path, directory) in found {
                    if directory {
                        continue;
                    }
                    let Ok((text, bounded)) = read_bounded(&path) else {
                        skipped += 1;
                        continue;
                    };
                    truncated |= bounded;
                    for (line, text) in text.lines().enumerate() {
                        let contains = if case_sensitive {
                            text.contains(&needle)
                        } else {
                            text.to_lowercase().contains(&needle)
                        };
                        if !contains {
                            continue;
                        }
                        if matches.len() == MAX_MATCHES {
                            return Ok(
                                json!({"matches":matches,"truncated":true,"skippedFiles":skipped}),
                            );
                        }
                        matches.push(json!({"path":path.strip_prefix(&root).map_err(|error|error.to_string())?,"line":line+1,"text":text.chars().take(1000).collect::<String>()}));
                    }
                }
                Ok(json!({"matches":matches,"truncated":truncated,"skippedFiles":skipped}))
            }
            _ => Err("Unknown workspace read tool".into()),
        }
    }
}

#[async_trait::async_trait]
impl AgentToolDispatcher for WorkspaceReader {
    fn tools(&self) -> Arc<[Arc<ToolDef>]> {
        definitions()
    }
    fn tool_mutation_class(&self, name: &str) -> ToolMutationClass {
        match name {
            "workspace_read_file" | "workspace_list_files" | "workspace_search" => {
                ToolMutationClass::ReadOnly
            }
            _ => ToolMutationClass::Unknown,
        }
    }
    async fn dispatch(&self, call: ToolCallView<'_>) -> Result<ToolDispatchOutcome, ToolError> {
        let root = self.root.clone();
        let name = call.name.to_owned();
        let args = call.args.get().to_owned();
        let outcome = tokio::task::spawn_blocking(move || Self { root }.execute(&name, &args))
            .await
            .map_err(|error| ToolError::Other(error.to_string()))?;
        let (content, failed) = match outcome {
            Ok(value) => (value.to_string(), false),
            Err(error) => (error, true),
        };
        Ok(ToolResult::new(call.id.to_string(), content, failed).into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use meerkat_core::ExecutionPolicyGatedDispatcher;

    struct ReaderTestWorkspace(PathBuf);

    impl ReaderTestWorkspace {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("meerkat-workspace-reader-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self(root.canonicalize().unwrap())
        }
    }

    impl Drop for ReaderTestWorkspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn workspace_reader_stops_before_exhausting_a_large_directory_iterator() {
        let mut examined = 0;
        let children = std::iter::from_fn(|| {
            examined += 1;
            assert!(examined <= 4, "scanned beyond the budget and one lookahead");
            Some(Ok::<_, std::convert::Infallible>(examined))
        });
        let mut remaining = 3;
        let (found, truncated) = collect_bounded_entries(children, &mut remaining).unwrap();
        assert_eq!(found, vec![1, 2, 3]);
        assert!(truncated);
        assert_eq!(remaining, 0);
        assert_eq!(examined, 4);
    }

    #[test]
    fn workspace_reader_directory_budget_is_global_and_counts_skipped_entries() {
        let workspace = ReaderTestWorkspace::new();
        let root = &workspace.0;
        std::fs::create_dir(root.join("nested")).unwrap();
        for name in [".git", "node_modules", "target", ".venv"] {
            std::fs::create_dir(root.join("nested").join(name)).unwrap();
        }
        // The first entry spends one unit before traversal reaches a directory
        // containing only ignored entries. Ignoring them must not bypass the cap.
        let (found, truncated) = entries(root, root, true, 3).unwrap();
        assert_eq!(found, vec![(root.join("nested"), true)]);
        assert!(truncated);

        // Exactly exhausting the tree is not truncation, even at the limit.
        let (found, truncated) = entries(root, root, true, 5).unwrap();
        assert_eq!(found, vec![(root.join("nested"), true)]);
        assert!(!truncated);
    }

    #[test]
    fn workspace_reader_preserves_regular_reads_and_rejects_directories() {
        let workspace = ReaderTestWorkspace::new();
        let reader = WorkspaceReader {
            root: workspace.0.clone(),
        };
        let source = workspace.0.join("source.txt");
        let contents = format!("{}\u{00e9}", "a".repeat(MAX_READ_BYTES - 1));
        std::fs::write(&source, &contents).unwrap();
        let (text, truncated) = read_bounded(&source).unwrap();
        assert_eq!(text, "a".repeat(MAX_READ_BYTES - 1));
        assert!(truncated);
        assert_eq!(std::fs::read_to_string(source).unwrap(), contents);
        assert_eq!(
            reader
                .execute("workspace_read_file", r#"{"path":"."}"#)
                .unwrap_err(),
            "Choose a regular file."
        );
    }

    #[cfg(unix)]
    #[test]
    fn workspace_reader_rejects_devices_and_preserves_resolved_internal_symlinks() {
        let workspace = ReaderTestWorkspace::new();
        let reader = WorkspaceReader {
            root: workspace.0.clone(),
        };
        assert_eq!(
            read_bounded(Path::new("/dev/null")).unwrap_err(),
            "Choose a regular file."
        );
        std::fs::write(
            workspace.0.join("source.txt"),
            "read through an internal link",
        )
        .unwrap();
        std::os::unix::fs::symlink("source.txt", workspace.0.join("link.txt")).unwrap();
        let result = reader
            .execute("workspace_read_file", r#"{"path":"link.txt"}"#)
            .unwrap();
        assert_eq!(result["path"], "source.txt");
        assert_eq!(result["lines"][0]["text"], "read through an internal link");
    }

    #[cfg(unix)]
    #[test]
    fn workspace_reader_rejects_fifo_without_waiting_for_a_writer() {
        use std::{
            os::unix::ffi::OsStrExt,
            process::{Command, Stdio},
            time::{Duration, Instant},
        };
        const CHILD_ROOT: &str = "MEERKAT_WORKSPACE_FIFO_TEST_ROOT";
        if let Some(root) = std::env::var_os(CHILD_ROOT) {
            let root = PathBuf::from(root);
            assert_eq!(
                (WorkspaceReader { root: root.clone() })
                    .execute("workspace_read_file", r#"{"path":"fifo"}"#)
                    .unwrap_err(),
                "Choose a regular file."
            );
            std::fs::write(root.join("child-completed"), "rejected").unwrap();
            return;
        }

        let workspace = ReaderTestWorkspace::new();
        let fifo = std::ffi::CString::new(workspace.0.join("fifo").as_os_str().as_bytes()).unwrap();
        // SAFETY: fifo is a live NUL-terminated path; mkfifo retains no pointer.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);

        // A separate test process makes the regression safe against the old
        // blocking open: timeout kills and reaps only this captured child PID.
        struct ChildGuard(std::process::Child);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                if matches!(self.0.try_wait(), Ok(None)) {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                }
            }
        }
        let log_path = workspace.0.join("fifo-child.log");
        let log = std::fs::File::create(&log_path).unwrap();
        let diagnostics = || {
            let mut bytes = Vec::new();
            if let Ok(file) = std::fs::File::open(&log_path) {
                let _ = file.take(16 * 1024).read_to_end(&mut bytes);
            }
            String::from_utf8_lossy(&bytes).into_owned()
        };
        let mut child = ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .arg("native_execution_modes::tests::workspace_reader_rejects_fifo_without_waiting_for_a_writer")
                .arg("--exact")
                .env(CHILD_ROOT, &workspace.0)
                .stdin(Stdio::null())
                .stdout(Stdio::from(log.try_clone().unwrap()))
                .stderr(Stdio::from(log))
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                assert!(
                    status.success(),
                    "FIFO rejection child failed: {status}\n{}",
                    diagnostics()
                );
                assert!(workspace.0.join("child-completed").is_file());
                break;
            }
            assert!(
                Instant::now() < deadline,
                "FIFO reader waited for a writer; terminating child {}\n{}",
                child.0.id(),
                diagnostics()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    struct NeverCalledClient;
    #[async_trait::async_trait]
    impl meerkat::LlmClient for NeverCalledClient {
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
            panic!("No model calls in execution-policy proof")
        }
        fn provider(&self) -> meerkat_core::Provider {
            meerkat_core::Provider::Other
        }
        async fn health_check(&self) -> Result<(), meerkat::LlmError> {
            Ok(())
        }
    }

    struct MutationProbe {
        marker: PathBuf,
    }
    #[async_trait::async_trait]
    impl AgentToolDispatcher for MutationProbe {
        fn tools(&self) -> Arc<[Arc<ToolDef>]> {
            ["shell", "write_file"]
                .into_iter()
                .map(|name| {
                    Arc::new(ToolDef::new(
                        name,
                        "Mutation test",
                        json!({"type":"object"}),
                    ))
                })
                .collect::<Vec<_>>()
                .into()
        }
        fn tool_mutation_class(&self, _: &str) -> ToolMutationClass {
            ToolMutationClass::Mutating
        }
        async fn dispatch(&self, call: ToolCallView<'_>) -> Result<ToolDispatchOutcome, ToolError> {
            std::fs::write(&self.marker, call.name).unwrap();
            Ok(ToolResult::new(call.id.to_string(), "mutated".into(), false).into())
        }
    }

    #[tokio::test]
    async fn factory_enforces_read_only_and_restores_the_same_policy_without_model_calls() {
        let root =
            std::env::temp_dir().join(format!("meerkat-policy-factory-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("source.txt"), "native read proof").unwrap();
        let marker = root.join("must-not-exist");
        let tools: Arc<dyn AgentToolDispatcher> = Arc::new(
            meerkat_core::ToolGatewayBuilder::new()
                .add_dispatcher(workspace_reader(root.clone()))
                .add_dispatcher(Arc::new(MutationProbe {
                    marker: marker.clone(),
                }))
                .build()
                .unwrap(),
        );
        let factory =
            meerkat::AgentFactory::new(root.join("state")).without_provider_auth_persistence();
        let mut agent = factory
            .build_agent(
                meerkat::AgentBuildConfig {
                    llm_client_override: Some(Arc::new(NeverCalledClient)),
                    tool_dispatcher_override: Some(tools.clone()),
                    tool_access_policy: ExecutionMode::ReadOnly.tool_policy(),
                    ..meerkat::AgentBuildConfig::new("claude-sonnet-4-5")
                },
                &meerkat::Config::default(),
            )
            .await
            .unwrap();
        for name in ["shell", "write_file"] {
            let result = agent
                .dispatch_external_tool_call(meerkat_core::ToolCall::new(
                    format!("denied-{name}"),
                    name.into(),
                    json!({}),
                ))
                .await
                .unwrap();
            assert!(result.result.is_error);
            assert!(result.result.text_content().contains("access_denied"));
            assert!(!marker.exists());
        }
        let result = agent
            .dispatch_external_tool_call(meerkat_core::ToolCall::new(
                "read".into(),
                "workspace_read_file".into(),
                json!({"path":"source.txt"}),
            ))
            .await
            .unwrap();
        assert!(!result.result.is_error);
        assert!(result.result.text_content().contains("native read proof"));
        let saved = serde_json::to_vec(agent.session()).unwrap();
        let original_id = agent.session().id().clone();
        drop(agent);
        let session: meerkat_core::Session = serde_json::from_slice(&saved).unwrap();
        let mut resumed = factory
            .build_agent(
                meerkat::AgentBuildConfig {
                    llm_client_override: Some(Arc::new(NeverCalledClient)),
                    tool_dispatcher_override: Some(tools.clone()),
                    resume_session: Some(session),
                    ..meerkat::AgentBuildConfig::new("claude-sonnet-4-5")
                },
                &meerkat::Config::default(),
            )
            .await
            .unwrap();
        assert_eq!(resumed.session().id(), &original_id);
        assert_eq!(
            resumed
                .session()
                .session_metadata()
                .unwrap()
                .tooling
                .tool_access_policy,
            Some(ToolAccessPolicy::ReadOnly)
        );
        let result = resumed
            .dispatch_external_tool_call(meerkat_core::ToolCall::new(
                "resumed-shell".into(),
                "shell".into(),
                json!({}),
            ))
            .await
            .unwrap();
        assert!(result.result.is_error);
        assert!(!marker.exists());
        let mut full_access = factory
            .build_agent(
                meerkat::AgentBuildConfig {
                    llm_client_override: Some(Arc::new(NeverCalledClient)),
                    tool_dispatcher_override: Some(tools),
                    ..meerkat::AgentBuildConfig::new("claude-sonnet-4-5")
                },
                &meerkat::Config::default(),
            )
            .await
            .unwrap();
        let result = full_access
            .dispatch_external_tool_call(meerkat_core::ToolCall::new(
                "allowed-shell".into(),
                "shell".into(),
                json!({}),
            ))
            .await
            .unwrap();
        assert!(!result.result.is_error);
        assert!(marker.exists());
        drop(resumed);
        drop(full_access);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reconnect_never_widens_or_narrows_a_saved_native_policy() {
        assert_eq!(
            persisted_mode(Some(&ToolAccessPolicy::ReadOnly)).unwrap(),
            ExecutionMode::ReadOnly
        );
        assert!(
            validate_requested_mode(Some(ExecutionMode::FullAccess), ExecutionMode::ReadOnly)
                .is_err()
        );
        assert!(
            validate_requested_mode(Some(ExecutionMode::ReadOnly), ExecutionMode::FullAccess)
                .is_err()
        );
        assert_eq!(
            validate_requested_mode(None, ExecutionMode::ReadOnly).unwrap(),
            ExecutionMode::ReadOnly
        );
        assert_eq!(requested_mode(
            json!({"accessMode":"approval-required"}).as_object().unwrap()
        ).unwrap(), Some(ExecutionMode::Approvals));
        assert!(requested_mode(
            json!({"accessMode":"auto-accept-edits"}).as_object().unwrap()
        ).is_err());
    }

    #[tokio::test]
    async fn native_read_only_gate_allows_workspace_reads_and_refuses_shell_and_unknown_tools() {
        let root = std::env::temp_dir().join(format!("meerkat-read-only-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("src/example.ts"),
            "const answer = 42;\nexport { answer };\n",
        )
        .unwrap();
        let reader = workspace_reader(root.clone());
        let gate = ExecutionPolicyGatedDispatcher::new(
            reader,
            meerkat_core::ToolExecutionPolicy::resolve(ToolAccessPolicy::ReadOnly).unwrap(),
        );
        let args =
            serde_json::value::RawValue::from_string(json!({"path":"src/example.ts"}).to_string())
                .unwrap();
        let read = gate
            .dispatch(ToolCallView {
                id: "read-1",
                name: "workspace_read_file",
                args: &args,
            })
            .await
            .unwrap();
        assert!(!read.result.is_error);
        assert!(read.result.text_content().contains("const answer = 42"));
        for name in ["shell", "write_file", "unaudited_mcp"] {
            assert!(gate
                .dispatch(ToolCallView {
                    id: "denied-1",
                    name,
                    args: &args
                })
                .await
                .is_err());
        }
        let list = WorkspaceReader { root: root.clone() }
            .execute("workspace_list_files", r#"{"recursive":true}"#)
            .unwrap();
        assert!(list["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["path"] == "src/example.ts"));
        let search = WorkspaceReader { root: root.clone() }
            .execute("workspace_search", r#"{"query":"ANSWER"}"#)
            .unwrap();
        assert_eq!(search["matches"].as_array().unwrap().len(), 2);
        assert!(WorkspaceReader { root: root.clone() }
            .execute("workspace_read_file", r#"{"path":"../"}"#)
            .is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("src/example.ts")).unwrap(),
            "const answer = 42;\nexport { answer };\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
