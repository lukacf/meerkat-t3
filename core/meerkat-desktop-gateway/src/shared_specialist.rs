//! The shared host owns application operations and revision-bound repository
//! inspection. Native session/run context identifies the caller; tool arguments
//! are never identity authority. The gateway does not retry uncertain writes.
use std::{
    collections::BTreeSet,
    sync::{Arc, OnceLock},
    time::Duration,
};

use meerkat_core::{
    types::{ToolCallView, ToolDef, ToolResult},
    AgentToolDispatcher, Config, ConfigDelta, ConfigError, ConfigStore, EffectiveConfigReader,
    RealmConfigSource, RealmId, ToolDispatchContext, ToolDispatchOutcome, ToolError,
    ToolMutationClass,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const ACTIONS: &[&str] = &[
    "projects.list",
    "projects.get",
    "specialists.list",
    "specialists.get",
    "specialists.send",
    "specialists.request",
    "specialists.create",
    "specialists.update",
    "specialists.connect",
    "specialists.split",
    "specialists.consolidate",
    "specialists.supersede",
    "operations.get",
    "inbox.list",
    "inbox.ack",
    "activity.publish",
    "activity.publish_from_inbox",
    "knowledge.search",
    "knowledge.record",
    "knowledge.record_from_inbox",
    "knowledge.supersede",
    "repository.list",
    "repository.read",
    "repository.search",
];

// These capabilities are available only through the local task's personal
// delegation. Configuration advertises possibilities, never grants authority.
const LOCAL_ACTIONS: &[&str] = &[
    "projects.list",
    "projects.get",
    "specialists.list",
    "specialists.get",
    "specialists.send",
    "specialists.request",
    "inbox.list",
    "inbox.ack",
    "activity.publish",
    "knowledge.search",
    "knowledge.record",
    "knowledge.supersede",
];
const LOCAL_ONLY_ACTIONS: &[&str] = &["specialists.send", "specialists.request"];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    action: String,
    arguments: serde_json::Map<String, Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Invocation<'a> {
    version: u8,
    mob_id: &'a str,
    session_id: String,
    run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    interaction_id: Option<String>,
    call_id: &'a str,
    action: &'a str,
    arguments: &'a serde_json::Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Response {
    content: Value,
    #[serde(default)]
    is_error: bool,
}

struct SharedWorkspaceDispatcher {
    client: reqwest::Client,
    endpoint: reqwest::Url,
    authorization: reqwest::header::HeaderValue,
    mob_id: String,
    actions: BTreeSet<String>,
    definition: Arc<ToolDef>,
}

fn endpoint(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid shared workspace endpoint")?;
    let loopback = url
        .host_str()
        .and_then(|host| {
            host.trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .ok()
        })
        .is_some_and(|ip| ip.is_loopback());
    if url.scheme() != "http"
        || !loopback
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Shared workspace tools require an explicit loopback HTTP endpoint".into());
    }
    Ok(url)
}

fn capabilities(actions: Vec<String>) -> Result<BTreeSet<String>, String> {
    let count = actions.len();
    let actions: BTreeSet<_> = actions.into_iter().collect();
    if actions.is_empty()
        || actions.len() != count
        || actions.iter().any(|a| !ACTIONS.contains(&a.as_str()))
    {
        return Err(
            "Shared workspace action capabilities are empty, duplicated, or unsupported".into(),
        );
    }
    Ok(actions)
}

fn argument_contract(action: &str) -> &'static str {
    match action {
        "projects.list" => {
            "{after?: opaque nextCursor returned by the previous page, limit?: integer 1-100} - list bounded directory summaries. Returns {items, nextCursor}; pass nextCursor until null. Use the corresponding get action for a full definition. No caller identity fields."
        }
        "specialists.list" => {
            "{sharedProjectId?: string, paths?: relative path strings[], tags?: exact domain tags[], query?: literal description text, includeSuperseded?: boolean (default false), after?: opaque nextCursor from previous page, limit?: integer 1-100}. Search assignments and expertise. Paths match directory boundaries in either direction; tags match exactly; query filters labels and charters. Results {items, nextCursor} include per-assignment match reasons and labelled charter excerpts. Follow nextCursor until null and use specialists.get for full definitions. Discovery does not prove native availability."
        }
        "projects.get" => {
            "{sharedProjectId: string} - read the full registered project definition by its directory ID."
        }
        "specialists.get" => {
            "{specialistId: string} - read the full specialist definition by its directory ID."
        }
        "specialists.send" => {
            "{specialistId: directory specialist ID, requestId: stable unique string, text: nonempty string up to 32768 characters}. Send this task's request to the exact shared specialist. The broker supplies the enabled task's context; omit contextId, contextVersion and revision. Retain the returned requestId for specialists.request. Reuse the input requestId only for an identical retry. Acceptance is not completion."
        }
        "specialists.request" => {
            "{requestId: exact returned request ID from specialists.send} - reconcile this delegation's request from its exact native receipt. unresolved is not completion. Do not infer an answer from another request, peer message or latest timeline output."
        }
        "specialists.create"
        | "specialists.update"
        | "specialists.connect"
        | "specialists.split"
        | "specialists.consolidate"
        | "specialists.supersede" => {
            "{operationId: stable unique string, creations: Creation[], revisions: Revision[], peers: {source: Ref, target: Ref}[], transitions: Transition[]}. Include every array, using [] when unused. The action selects create|revise|connect|split|consolidate|supersede. Creation={key: unique string, anchorSharedProjectId: registered project ID, instanceId: existing native provider instance, label: string, role: lowercase letters/numbers/hyphens starting with a letter, instructions: string, model: authenticated model ID, options?: native provider options, assignments: Assignment[]}. Assignment={sharedProjectId: registered ID, charter: string, paths: repository-relative strings[], tags: strings[]}; assignments must include the anchor project. Ref={specialistId: existing ID, expectedVersion: current assignmentVersion} OR {creationKey: a Creation.key in this operation}. Revision={specialistId, expectedVersion, label?: string, assignments: Assignment[], instructions?: string}; instructions activates native responsibilities at the idle boundary, omission changes directory routing only. Transition={predecessorId: existing ID, expectedVersion, successors: Ref[], supersede: boolean}. create requires creations; update requires revisions; connect requires peers; split requires one transition with at least two successors; consolidate requires at least two superseded predecessors with the same successor; supersede requires superseding transitions. A nonsuperseding split must revise the predecessor's remaining assignments. Max 8 creations/revisions/transitions and 16 peer edges, total input 48 KiB. Agents are permanent independent identities, never children. All changes affect future routing only; admitted requests, histories, inbox acknowledgements and predecessor agents remain intact. Returns pending|conflict|completed with exact native evidence and lineage. Retry only identical contents with the same operationId. Pending is not completion. No caller identity fields."
        }
        "operations.get" => {
            "{operationId: string} - observe this authenticated actor's retained composition operation, including pending details, permanent native identities and completed lineage. Observation does not retry native work. The host continues retained pending operations in bounded passes, including revisions waiting for native idle. An explicit retry must use the original action, identical arguments and same operationId."
        }
        "inbox.list" => {
            "{limit?: integer 1-100} - read this specialist's retained product inbox batch."
        }
        "inbox.ack" => {
            "{batchId: string} - acknowledge the exact sealed batch returned by inbox.list. This does not acknowledge native execution."
        }
        "activity.publish" => {
            "{eventId: stable unique string, contextId: string, contextVersion: string, revision: {branch: string, commit: full 40/64 lowercase hex, applicability: proposal|branch|merged, snapshotId?: string}, kind: task_started|objective_changed|finding|decision|blocker|changes|test_result|commit|pull_request|merge|abandoned|briefing|correction, summary: string, paths: string[], tags: string[], sources: {title: string, uri: string}[], recipientIds?: string[]}. Copy contextId, contextVersion and revision exactly from the current participant request. Never borrow a different request's context. Reuse eventId only for an identical retry."
        }
        "activity.publish_from_inbox" => {
            "{source: {batchId: exact retained inbox batch ID, eventId: one event ID in that batch}, eventId: stable new publication ID, kind: task_started|objective_changed|finding|decision|blocker|changes|test_result|commit|pull_request|merge|abandoned|briefing|correction, summary: string, sources?: additional {title: string, uri: string}[]}. Publish your own observation of one retained delivered event, including on a peer turn without participant-request authority. The host verifies your current assignment and derives a specialist-owned observation context, original revision/applicability/snapshot, affected paths/tags and all inherited sources. Do not supply author, context, revision, recipient or native identity fields. Exact source proof is retained in context.source; its host association does not claim the source revision is checked out there. At most 64 unioned sources; none are dropped. This does not acknowledge the batch, complete a request or create subscriptions. Reuse eventId only for an identical retry."
        }
        "knowledge.search" => {
            "{sharedProjectId?: string, query?: string, evidenceId?: string, supersedes?: string, branch?: string, commit?: full 40/64 lowercase hex, kind?: finding|decision|incident|resolution|investigation|commitment, limit?: integer 1-100, cursor?: opaque nextCursor from the previous page} - search retained revision-qualified evidence. evidenceId fetches one exact record; supersedes pages direct corrections to that evidence. Returns {records, hasMore, nextCursor}; follow nextCursor while hasMore is true. Each record includes corrections (up to 8 reverse references with their own revision, context and author) and hasMoreCorrections. Corrections remain visible even if they do not match the original query/revision; inspect their own applicability before relying on earlier evidence. Fetch references by evidenceId and page all corrections with supersedes. Pages contain whole records, never truncated evidence."
        }
        "knowledge.record" | "knowledge.supersede" => {
            "{evidenceId: stable unique string, contextId: string, contextVersion: string, revision: {branch: string, commit: full 40/64 lowercase hex, applicability: proposal|branch|merged, snapshotId?: string}, kind: finding|decision|incident|resolution|investigation|commitment, title: string, body: string, sources: {title: string, uri: string}[], supersedes: string[], state: open|resolved|abandoned}. Copy contextId, contextVersion and revision exactly from the current participant request. Never borrow a different request's context. knowledge.supersede requires at least one retained evidence ID in supersedes and atomically publishes a correction observation to matching product inboxes. Original evidence is preserved; a correction is not proof of task completion. Reuse evidenceId only for an identical retry."
        }
        "knowledge.record_from_inbox" => {
            "{source: {batchId: exact retained inbox batch ID, eventId: one event ID in that batch}, evidenceId: stable new evidence ID, kind: finding|decision|incident|resolution|investigation|commitment, title: string, body: string, sources?: additional {title: string, uri: string}[], supersedes: retained evidence IDs[], state: open|resolved|abandoned}. Record specialist-authored evidence derived from your own sealed inbox event. The host derives an independent observation context and preserves the source revision/applicability/snapshot, inherited references and observationSource proof. Never supply caller identity, context or revision. Nonempty supersedes requires existing evidence in the same project and atomically emits the normal correction activity. It never merges histories, acknowledges the inbox or completes native work. Reuse evidenceId only for an identical retry."
        }
        "repository.list" => {
            "{sharedProjectId: string, commit: full 40/64 lowercase hex, path?: relative prefix, limit?: integer 1-400} - list regular committed files; no symlink/submodule traversal or network fetch."
        }
        "repository.read" => {
            "{sharedProjectId: string, commit: full 40/64 lowercase hex, path?: relative file, snapshotId?: string, startLine?: positive integer, limit?: integer 1-500}. Supply exactly one of path or snapshotId. A snapshot returns retained patch evidence with applied:false, not synthesized file contents. Commit is the snapshot base commit. No branch/HEAD shortcuts or local checkout paths."
        }
        "repository.search" => {
            "{sharedProjectId: string, commit: full 40/64 lowercase hex, query: nonempty literal string, path?: relative prefix, limit?: integer 1-100} - search regular committed text files, never the mutable checkout."
        }
        _ => {
            "Use the host-published operation contract and a stable operationId. Society changes affect future work only; existing admitted work is never transferred or destroyed."
        }
    }
}

fn local_argument_contract(action: &str) -> &'static str {
    match action {
        "inbox.list" => {
            "{limit?: integer 1-100} - read this delegated task's retained product inbox batch. Caller identity and context come from the active grant."
        }
        "activity.publish" => {
            "{eventId: stable unique string, kind: task_started|objective_changed|finding|decision|blocker|changes|test_result|commit|pull_request|merge|abandoned|briefing|correction, summary: string, paths: string[], tags: string[], sources: {title: string, uri: string}[], recipientIds?: string[]}. Omit contextId, contextVersion and revision; the broker supplies the enabled task's exact immutable context and rejects conflicting supplied values. Reuse eventId only for an identical retry."
        }
        "knowledge.record" | "knowledge.supersede" => {
            "{evidenceId: stable unique string, kind: finding|decision|incident|resolution|investigation|commitment, title: string, body: string, sources: {title: string, uri: string}[], supersedes: string[], state: open|resolved|abandoned}. Omit contextId, contextVersion and revision; the broker supplies the enabled task's exact immutable context and rejects conflicting supplied values. knowledge.supersede requires retained evidence IDs in supersedes. Reuse evidenceId only for an identical retry."
        }
        _ => argument_contract(action),
    }
}

/// Received only from the owning server over private stdio. Never persisted,
/// logged, advertised in tools, or copied into process environment variables.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SharedToolsConfigure {
    url: String,
    token: String,
    actions: Vec<String>,
}

#[derive(Default)]
pub(crate) struct SharedWorkspaceHost {
    configured: OnceLock<SharedHostConfiguration>,
}

struct SharedHostConfiguration {
    client: reqwest::Client,
    endpoint: reqwest::Url,
    authorization: reqwest::header::HeaderValue,
    actions: BTreeSet<String>,
}

impl SharedWorkspaceHost {
    pub(crate) fn configure(&self, input: SharedToolsConfigure) -> Result<(), String> {
        if input.url.len() > 2048 || input.token.trim().is_empty() || input.token.len() > 8192 {
            return Err("Invalid shared workspace host configuration".into());
        }
        let endpoint = endpoint(&input.url)?;
        let actions = capabilities(input.actions)?;
        let mut authorization =
            reqwest::header::HeaderValue::from_str(&format!("Bearer {}", input.token))
                .map_err(|_| "Invalid shared workspace tool credential")?;
        authorization.set_sensitive(true);
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|_| "Cannot initialize shared workspace transport")?;
        let configuration = SharedHostConfiguration {
            client,
            endpoint,
            authorization,
            actions,
        };
        if let Err(rejected) = self.configured.set(configuration) {
            let retained = self.configured.get().expect("configuration is write-once");
            if retained.endpoint != rejected.endpoint
                || retained.authorization != rejected.authorization
                || retained.actions != rejected.actions
            {
                return Err(
                    "The shared workspace host is already configured for this gateway owner".into(),
                );
            }
        }
        Ok(())
    }

    pub(crate) fn dispatcher(&self, mob_id: &str) -> Result<Arc<dyn AgentToolDispatcher>, String> {
        let configuration = self
            .configured
            .get()
            .ok_or_else(|| "The shared workspace tool host is not configured".to_string())?;
        let actions = configuration
            .actions
            .iter()
            .filter(|action| !LOCAL_ONLY_ACTIONS.contains(&action.as_str()))
            .cloned()
            .collect::<BTreeSet<_>>();
        if actions.is_empty() {
            return Err("No shared specialist tool capabilities are configured".into());
        }
        Ok(configured_dispatcher(mob_id, configuration, actions, false))
    }

    pub(crate) fn local_dispatcher(&self, mob_id: &str) -> Option<Arc<dyn AgentToolDispatcher>> {
        let configuration = self.configured.get()?;
        let actions = configuration
            .actions
            .iter()
            .filter(|action| LOCAL_ACTIONS.contains(&action.as_str()))
            .cloned()
            .collect::<BTreeSet<_>>();
        (!actions.is_empty()).then(|| configured_dispatcher(mob_id, configuration, actions, true))
    }
}

fn configured_dispatcher(
    mob_id: &str,
    configuration: &SharedHostConfiguration,
    actions: BTreeSet<String>,
    local: bool,
) -> Arc<dyn AgentToolDispatcher> {
    let SharedHostConfiguration {
        client,
        endpoint,
        authorization,
        ..
    } = configuration;
    let argument_help = actions
        .iter()
        .map(|action| {
            format!(
                "{action}: {}",
                if local {
                    local_argument_contract(action)
                } else {
                    argument_contract(action)
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let description = if local {
        "Use the advertised shared workspace operations through this task's personal connection. The user must enable shared access for this task before calls are authorized; ask them to enable it if unavailable. The broker supplies caller identity and the granted immutable task context. Omit credentials, grant IDs, caller identity, contextId, contextVersion and revision from arguments. A changed branch or revision requires the user to update the enabled task context. Retain stable write IDs and reconcile uncertain results before retrying. No composition or repository inspection capabilities are provided here."
    } else {
        "Use only the advertised shared workspace operations. At the start of each specialist turn, inspect one bounded inbox.list batch for relevant retained updates. This is a tool pull, not a timer or scheduling authority. The host derives caller identity from native session context. Follow the action argument contract, retain its stable write ID and reconcile uncertain results before retrying. A turn without a participant-request binding cannot publish under a participant's work context; use the explicit from_inbox actions for specialist-authored observations with an exact sealed batch/event source. Acknowledge only after processing the chosen batch. Repository operations inspect immutable commits or retained patch evidence; local paths are not repository identity."
    };
    let definition = Arc::new(ToolDef::new(
        "shared_workspace",
        description,
        json!({"type":"object","additionalProperties":false,"required":["action","arguments"],"properties":{
            "action":{"type":"string","enum":actions},
            "arguments":{"type":"object","description":argument_help}
        }}),
    ));
    Arc::new(SharedWorkspaceDispatcher {
        client: client.clone(),
        endpoint: endpoint.clone(),
        authorization: authorization.clone(),
        mob_id: mob_id.to_owned(),
        actions,
        definition,
    })
}

#[async_trait::async_trait]
impl AgentToolDispatcher for SharedWorkspaceDispatcher {
    fn tools(&self) -> Arc<[Arc<ToolDef>]> {
        vec![Arc::clone(&self.definition)].into()
    }

    fn tool_mutation_class(&self, name: &str) -> ToolMutationClass {
        if name == "shared_workspace" {
            ToolMutationClass::Mutating
        } else {
            ToolMutationClass::Unknown
        }
    }

    async fn dispatch(&self, call: ToolCallView<'_>) -> Result<ToolDispatchOutcome, ToolError> {
        Err(ToolError::access_denied(call.name))
    }

    async fn dispatch_with_context(
        &self,
        call: ToolCallView<'_>,
        context: &ToolDispatchContext,
    ) -> Result<ToolDispatchOutcome, ToolError> {
        if call.name != "shared_workspace" || call.args.get().len() > MAX_REQUEST_BYTES {
            return Err(ToolError::access_denied(call.name));
        }
        let args: Arguments = serde_json::from_str(call.args.get())
            .map_err(|_| ToolError::Other("Invalid shared workspace arguments".into()))?;
        if !self.actions.contains(&args.action) {
            return Err(ToolError::access_denied(call.name));
        }
        let session = context
            .origin_session_id()
            .ok_or_else(|| ToolError::access_denied(call.name))?;
        let run = context
            .run_id()
            .ok_or_else(|| ToolError::access_denied(call.name))?;
        let body = Invocation {
            version: 1,
            mob_id: &self.mob_id,
            session_id: session.to_string(),
            run_id: run.to_string(),
            interaction_id: context.interaction_lineage_id().map(|id| id.to_string()),
            call_id: call.id,
            action: &args.action,
            arguments: &args.arguments,
        };
        let mut response = self.client.post(self.endpoint.clone())
            .header(reqwest::header::AUTHORIZATION, self.authorization.clone())
            .json(&body).send().await
            .map_err(|_| ToolError::Other("Shared workspace delivery is uncertain. Reconcile the operation before retrying.".into()))?;
        if !response.status().is_success() {
            return Err(ToolError::Other("The shared workspace host refused this operation. Reconcile its operationId before retrying.".into()));
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_RESPONSE_BYTES as u64)
        {
            return Err(ToolError::Other(
                "Shared workspace response exceeds its size limit".into(),
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ToolError::Other("Shared workspace response was interrupted; reconcile the operation before retrying.".into()))? {
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err(ToolError::Other("Shared workspace response exceeds its size limit".into()));
            }
            bytes.extend_from_slice(&chunk);
        }
        let response: Response = serde_json::from_slice(&bytes)
            .map_err(|_| ToolError::Other("Shared workspace returned an invalid response; reconcile the operation before retrying.".into()))?;
        let content = match response.content {
            Value::String(text) => text,
            other => other.to_string(),
        };
        Ok(ToolResult::new(call.id.to_owned(), content, response.is_error).into())
    }
}

/// Resolve native realm inheritance first, then narrow executable capabilities
/// for this host profile without writing a flattened configuration back to disk.
pub(crate) struct RestrictedSpecialistConfigStore {
    pub inner: Arc<dyn ConfigStore>,
    pub source: Arc<dyn RealmConfigSource>,
    pub head: RealmId,
}

fn restrict_config(mut config: Config) -> Config {
    config.tools.mcp_servers.clear();
    config.tools.builtins_enabled = false;
    config.tools.shell_enabled = false;
    config.tools.mob_enabled = false;
    config.tools.schedule_enabled = false;
    config.tools.workgraph_enabled = false;
    config.tools.comms_enabled = true;
    config.hooks.entries.clear();
    config.skills.enabled = false;
    config.provider_tools.anthropic.web_search = false;
    config.provider_tools.openai.web_search = false;
    config.provider_tools.gemini.google_search = false;
    config
}

#[async_trait::async_trait]
impl ConfigStore for RestrictedSpecialistConfigStore {
    async fn get(&self) -> Result<Config, ConfigError> {
        let head = self.inner.get().await?;
        let effective = EffectiveConfigReader::new(Arc::clone(&self.source))
            .effective_config_over_head(&self.head, head)
            .await?;
        Ok(restrict_config(effective))
    }
    async fn set(&self, _config: Config) -> Result<(), ConfigError> {
        Err(ConfigError::Validation(
            "Specialist configuration is owned by its workspace".into(),
        ))
    }
    async fn patch(&self, _delta: ConfigDelta) -> Result<Config, ConfigError> {
        Err(ConfigError::Validation(
            "Specialist configuration is owned by its workspace".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_host_endpoint_and_capabilities_fail_closed() {
        for allowed in [
            "http://127.0.0.1:1234/shared/tools",
            "http://[::1]:1234/shared/tools",
        ] {
            assert!(endpoint(allowed).is_ok());
        }
        for denied in [
            "https://127.0.0.1/tools",
            "http://localhost/tools",
            "http://example.com/tools",
            "http://user@127.0.0.1/tools",
            "http://127.0.0.1/tools?token=secret",
            "http://127.0.0.1/tools#fragment",
        ] {
            assert!(endpoint(denied).is_err());
        }
        assert!(capabilities(vec![
            "projects.list".into(),
            "inbox.ack".into(),
            "operations.get".into()
        ])
        .is_ok());
        for denied in [
            "[]",
            r#"["shell"]"#,
            r#"["projects.list","projects.list"]"#,
            r#"["specialists.disconnect"]"#,
        ] {
            assert!(capabilities(serde_json::from_str(denied).unwrap()).is_err());
        }
        assert!(serde_json::from_str::<Arguments>(
            r#"{"action":"projects.list","arguments":{},"sessionId":"forged"}"#
        )
        .is_err());
    }

    #[tokio::test]
    async fn shared_host_configuration_is_private_write_once_and_owner_scoped() {
        use meerkat_desktop_contracts::{RequestContext, RpcId, RpcRequest};
        let gateway = crate::MeerkatGateway::new();
        let other_gateway = crate::MeerkatGateway::new();
        assert!(gateway.inner.shared_tools.dispatcher("shared").is_err());
        let params = json!({
            "url": "http://127.0.0.1:1234/native-tool",
            "token": "private-shared-host-secret",
            "actions": ["projects.list", "projects.get", "specialists.get", "knowledge.search"]
        });
        let request = |params| RpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(RpcId::String("configure".into())),
            method: "sharedTools.v1.configure".into(),
            params: Some(params),
        };
        for _ in 0..2 {
            let response = gateway
                .handle(request(params.clone()), RequestContext::local())
                .await;
            assert_eq!(response.result, Some(json!({"configured": true})));
            assert!(response.error.is_none());
            assert!(!serde_json::to_string(&response)
                .unwrap()
                .contains("private-shared-host-secret"));
        }
        assert!(other_gateway
            .inner
            .shared_tools
            .dispatcher("shared")
            .is_err());
        let tools = gateway.inner.shared_tools.dispatcher("shared").unwrap();
        let definition = serde_json::to_string(&tools.tools()).unwrap();
        assert!(
            !definition.contains("private-shared-host-secret") && !definition.contains("127.0.0.1")
        );
        assert!(definition.contains("projects.get") && definition.contains("specialists.get"));
        assert!(definition.contains("nextCursor") && definition.contains("hasMore"));
        let mut changed = params.clone();
        changed["token"] = json!("different-private-token");
        let response = gateway
            .handle(request(changed), RequestContext::local())
            .await;
        assert!(response.error.is_some());
        assert!(!serde_json::to_string(&response)
            .unwrap()
            .contains("different-private-token"));
        let mut forged = params;
        forged["principal"] = json!("model-supplied-identity");
        assert!(gateway
            .handle(request(forged), RequestContext::local())
            .await
            .error
            .is_some());
        // Identical gateways share no configuration, even in the same process.
        assert!(other_gateway
            .inner
            .shared_tools
            .dispatcher("shared")
            .is_err());
    }

    #[test]
    fn local_task_capabilities_are_filtered_without_grant_or_secret_arguments() {
        let host = SharedWorkspaceHost::default();
        assert!(host.local_dispatcher("thread").is_none());
        host.configure(SharedToolsConfigure {
            url: "http://127.0.0.1:1234/native-tool".into(),
            token: "private-local-tool-token".into(),
            actions: ACTIONS.iter().map(|action| (*action).to_owned()).collect(),
        })
        .unwrap();
        let local = host.local_dispatcher("thread").unwrap();
        let local_tools = local.tools();
        let local_schema = &local_tools[0].input_schema;
        let advertised: BTreeSet<String> =
            serde_json::from_value(local_schema["properties"]["action"]["enum"].clone()).unwrap();
        assert_eq!(
            advertised,
            LOCAL_ACTIONS
                .iter()
                .map(|action| (*action).to_owned())
                .collect()
        );
        let help = local_schema["properties"]["arguments"]["description"]
            .as_str()
            .unwrap();
        assert!(help.contains("Omit contextId, contextVersion and revision"));
        assert!(help.contains("specialists.request: {requestId:"));
        assert!(!help.contains("specialists.create") && !help.contains("repository.read"));
        let definition = serde_json::to_string(&local_tools).unwrap();
        assert!(definition.contains("user must enable shared access"));
        assert!(
            !definition.contains("private-local-tool-token") && !definition.contains("127.0.0.1")
        );
        let specialist = host.dispatcher("domain").unwrap();
        let specialist_tools = specialist.tools();
        let specialist_actions: BTreeSet<String> = serde_json::from_value(
            specialist_tools[0].input_schema["properties"]["action"]["enum"].clone(),
        )
        .unwrap();
        assert!(specialist_actions.contains("specialists.create"));
        assert!(LOCAL_ONLY_ACTIONS
            .iter()
            .all(|action| !specialist_actions.contains(*action)));

        let composition_only = SharedWorkspaceHost::default();
        composition_only
            .configure(SharedToolsConfigure {
                url: "http://127.0.0.1:1234/native-tool".into(),
                token: "private-local-tool-token".into(),
                actions: vec!["specialists.create".into()],
            })
            .unwrap();
        assert!(composition_only.local_dispatcher("thread").is_none());
    }

    #[test]
    fn shared_profile_disables_external_execution_without_removing_accounts() {
        let mut config = Config::default();
        config.tools.shell_enabled = true;
        config.tools.builtins_enabled = true;
        config
            .tools
            .mcp_servers
            .push(meerkat_core::McpServerConfig::stdio(
                "untrusted",
                "arbitrary-command",
                Vec::new(),
                Default::default(),
            ));
        let before_realms = config.realm.clone();
        let config = restrict_config(config);
        assert!(!config.tools.shell_enabled && !config.tools.builtins_enabled);
        assert!(config.tools.mcp_servers.is_empty() && config.hooks.entries.is_empty());
        assert!(config.tools.comms_enabled);
        assert!(!config.skills.enabled && !config.provider_tools.openai.web_search);
        assert_eq!(config.realm, before_realms);
    }

    struct ParentConfig(Config);
    #[async_trait::async_trait]
    impl RealmConfigSource for ParentConfig {
        async fn config_for_realm(&self, realm: &RealmId) -> Result<Option<Config>, ConfigError> {
            Ok((realm.as_str() == "account-owner").then(|| self.0.clone()))
        }
    }

    #[tokio::test]
    async fn native_inheritance_keeps_auth_but_cannot_restore_an_ancestor_executor() {
        let mut head = Config::default();
        head.realm.entry("workspace".into()).or_default().parent =
            Some(RealmId::parse("account-owner").unwrap());
        let mut ancestor: Config = toml::from_str(
            r#"
[realm.account-owner.backend.fixture]
provider = "openai"
backend_kind = "openai_api"
base_url = "http://127.0.0.1:1"
[realm.account-owner.auth.fixture]
provider = "openai"
auth_method = "api_key"
source = { kind = "inline_secret", secret = "test-only" }
[realm.account-owner.binding.fixture]
backend_profile = "fixture"
auth_profile = "fixture"
provider_default = true
"#,
        )
        .unwrap();
        ancestor
            .tools
            .mcp_servers
            .push(meerkat_core::McpServerConfig::stdio(
                "ancestor-command",
                "never-execute-this",
                Vec::new(),
                Default::default(),
            ));
        ancestor.tools.shell_enabled = true;
        ancestor.provider_tools.openai.web_search = true;
        let native_ancestor_auth = ancestor.realm["account-owner"].clone();
        let store = RestrictedSpecialistConfigStore {
            inner: Arc::new(meerkat_core::MemoryConfigStore::new(
                head,
                meerkat_models::canonical(),
            )),
            source: Arc::new(ParentConfig(ancestor)),
            head: RealmId::parse("workspace").unwrap(),
        };
        let config = store.get().await.unwrap();
        assert_eq!(config.realm["account-owner"], native_ancestor_auth);
        assert_eq!(
            config.realm["workspace"].parent.as_ref().unwrap().as_str(),
            "account-owner"
        );
        assert!(config.tools.mcp_servers.is_empty());
        assert!(!config.tools.shell_enabled && !config.provider_tools.openai.web_search);
        assert!(store.set(config).await.is_err());
    }

    struct HostToolModel(std::sync::atomic::AtomicUsize);
    #[async_trait::async_trait]
    impl meerkat::LlmClient for HostToolModel {
        fn project_replay_messages(
            &self,
            messages: &[meerkat_core::Message],
        ) -> Result<Vec<meerkat_core::Message>, meerkat::LlmError> {
            Ok(messages.to_vec())
        }
        fn stream<'a>(
            &'a self,
            request: &'a meerkat::LlmRequest,
        ) -> std::pin::Pin<
            Box<
                dyn futures_util::Stream<Item = Result<meerkat::LlmEvent, meerkat::LlmError>>
                    + Send
                    + 'a,
            >,
        > {
            let events = if self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                let tool = request
                    .tools
                    .iter()
                    .find(|tool| tool.name.as_str() == "shared_workspace")
                    .unwrap();
                assert_eq!(
                    tool.input_schema["properties"]["action"]["enum"],
                    json!(["projects.list"])
                );
                let arguments = tool.input_schema["properties"]["arguments"]["description"]
                    .as_str()
                    .unwrap();
                assert!(arguments.contains("projects.list: {after?"));
                assert!(!arguments.contains("specialists.create"));
                vec![
                    meerkat::LlmEvent::ToolCallComplete {
                        id: "native-host-call".into(),
                        name: "shared_workspace".into(),
                        args: json!({"action":"projects.list","arguments":{"participantId":"model-is-not-authority"}}),
                        meta: None,
                    },
                    meerkat::LlmEvent::Done {
                        outcome: meerkat::LlmDoneOutcome::Success {
                            stop_reason: meerkat_core::StopReason::ToolUse,
                        },
                    },
                ]
            } else {
                vec![
                    meerkat::LlmEvent::TextDelta {
                        delta: "Host returned project evidence.".into(),
                        meta: None,
                    },
                    meerkat::LlmEvent::Done {
                        outcome: meerkat::LlmDoneOutcome::Success {
                            stop_reason: meerkat_core::StopReason::EndTurn,
                        },
                    },
                ]
            };
            Box::pin(futures_util::stream::iter(events.into_iter().map(Ok)))
        }
        fn provider(&self) -> meerkat_core::Provider {
            meerkat_core::Provider::Other
        }
        async fn health_check(&self) -> Result<(), meerkat::LlmError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn host_callback_uses_native_session_and_run_not_model_identity() {
        prove_host_callback(false).await;
    }

    #[tokio::test]
    async fn local_host_callback_uses_native_session_and_run_not_model_identity() {
        prove_host_callback(true).await;
    }

    async fn prove_host_callback(local: bool) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/shared/tools", listener.local_addr().unwrap());
        let host = SharedWorkspaceHost::default();
        host.configure(SharedToolsConfigure {
            url,
            token: "test-host-token".into(),
            actions: vec!["projects.list".into()],
        })
        .unwrap();
        let tools = if local {
            host.local_dispatcher("owned-mob").unwrap()
        } else {
            host.dispatcher("owned-mob").unwrap()
        };
        let args = serde_json::value::RawValue::from_string(
            json!({"action":"projects.list","arguments":{"sessionId":"forged"}}).to_string(),
        )
        .unwrap();
        assert!(tools
            .dispatch_with_context(
                ToolCallView {
                    id: "unbound",
                    name: "shared_workspace",
                    args: &args
                },
                &ToolDispatchContext::default()
            )
            .await
            .is_err());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let (header_end, length) = loop {
                let mut chunk = [0; 2048];
                let count = stream.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                assert!(bytes.len() <= MAX_REQUEST_BYTES);
                if let Some(index) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                    let header = std::str::from_utf8(&bytes[..index])
                        .unwrap()
                        .to_ascii_lowercase();
                    assert!(header.contains("authorization: bearer test-host-token"));
                    let length = header
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .unwrap()
                        .trim()
                        .parse::<usize>()
                        .unwrap();
                    break (index + 4, length);
                }
            };
            while bytes.len() < header_end + length {
                let mut chunk = [0; 2048];
                let count = stream.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
            }
            let body: Value =
                serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
            let response = r#"{"content":{"projects":[]}}"#;
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).as_bytes()).await.unwrap();
            body
        });
        let root = tempfile::tempdir().unwrap();
        let mut agent = meerkat::AgentFactory::new(root.path())
            .without_provider_auth_persistence()
            .build_agent(
                meerkat::AgentBuildConfig {
                    llm_client_override: Some(Arc::new(HostToolModel(Default::default()))),
                    tool_dispatcher_override: Some(tools),
                    tool_access_policy: if local {
                        crate::native_execution_modes::ExecutionMode::FullAccess.tool_policy()
                    } else {
                        crate::native_execution_modes::ExecutionMode::RepositoryReadOnly
                            .tool_policy()
                    },
                    ..meerkat::AgentBuildConfig::new("claude-sonnet-4-5")
                },
                &restrict_config(Config::default()),
            )
            .await
            .unwrap();
        let session = agent.session().id().to_string();
        tokio::time::timeout(
            Duration::from_secs(10),
            agent.run(meerkat_core::ContentInput::Text(
                "Inspect shared projects".into(),
            )),
        )
        .await
        .unwrap()
        .unwrap();
        let body = tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(body["sessionId"], session);
        assert_eq!(body["mobId"], "owned-mob");
        assert_eq!(body["callId"], "native-host-call");
        assert!(uuid::Uuid::parse_str(body["runId"].as_str().unwrap()).is_ok());
        assert!(body.get("participantId").is_none());
        assert_eq!(body["arguments"]["participantId"], "model-is-not-authority");
        assert!(!body.to_string().contains("test-host-token"));
    }
}
