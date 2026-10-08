use super::super::Grant;
use super::*;
use meerkat_core::{ExecutionPolicyGatedDispatcher, ToolExecutionPolicy, types::ToolResult};
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

mod native_lifecycle;

struct CurrentChild {
    binding: MobMemberBinding,
    current: AtomicBool,
}

#[async_trait::async_trait]
impl ChildGrantGuard for CurrentChild {
    fn binding(&self) -> &MobMemberBinding {
        &self.binding
    }
    async fn validate(&self) -> Result<(), String> {
        if self.current.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err("Native member changed".into())
        }
    }
}

struct Preview {
    names: Vec<&'static str>,
    calls: AtomicU64,
    invalidate_on_probe: Option<Arc<CurrentChild>>,
}

#[async_trait::async_trait]
impl AgentToolDispatcher for Preview {
    fn tools(&self) -> Arc<[Arc<ToolDef>]> {
        self.names
            .iter()
            .map(|name| Arc::new(ToolDef::new(*name, "Fixture", json!({}))))
            .collect::<Vec<_>>()
            .into()
    }
    fn tool_mutation_class(&self, name: &str) -> ToolMutationClass {
        match name {
            "preview_status" | "read_file" => ToolMutationClass::ReadOnly,
            "preview_open" => ToolMutationClass::Mutating,
            _ => ToolMutationClass::Unknown,
        }
    }
    async fn dispatch(&self, call: ToolCallView<'_>) -> Result<ToolDispatchOutcome, ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let text = if call.name == "preview_status" {
            if let Some(guard) = &self.invalidate_on_probe {
                guard.current.store(false, Ordering::SeqCst);
            }
            json!({"hostConnectionId":"child-test-host"}).to_string()
        } else {
            "done".to_owned()
        };
        Ok(ToolResult::new(call.id.to_owned(), text, false).into())
    }
}

fn binding(member: &str) -> MobMemberBinding {
    MobMemberBinding {
        mob_id: "native-child".into(),
        role: "worker".into(),
        member: member.into(),
    }
}

fn view(
    proxy: &Arc<BrowserDispatcher>,
    session: &SessionId,
    member: &str,
) -> Arc<dyn AgentToolDispatcher> {
    Arc::new(SessionBrowserTools {
        session: session.clone(),
        binding: binding(member),
        proxy: proxy.clone(),
    })
}

fn grant(
    proxy: &BrowserDispatcher,
    session: &SessionId,
    member: &str,
    invalidate_on_probe: bool,
) -> (Arc<CurrentChild>, Arc<Preview>) {
    let guard = Arc::new(CurrentChild {
        binding: binding(member),
        current: AtomicBool::new(true),
    });
    let preview = Arc::new(Preview {
        names: vec!["preview_status", "preview_open", "device_click"],
        calls: AtomicU64::new(0),
        invalidate_on_probe: invalidate_on_probe.then(|| guard.clone()),
    });
    let revision = proxy.revoke(&session.to_string());
    proxy.grants.write().unwrap().insert(
        session.to_string(),
        Grant {
            host_thread_id: Some("original-thread".into()),
            host_session_id: Some("original-host-session".into()),
            dispatcher: preview.clone(),
            revision,
            child_guard: Some(guard.clone()),
        },
    );
    proxy.epoch.fetch_add(1, Ordering::SeqCst);
    (guard, preview)
}

async fn call(
    dispatcher: &dyn AgentToolDispatcher,
    session: &SessionId,
    name: &str,
) -> Result<ToolDispatchOutcome, ToolError> {
    let args = serde_json::value::RawValue::from_string("{}".into()).unwrap();
    let context = ToolDispatchContext::default().with_runtime_identity(session.clone(), None);
    dispatcher
        .dispatch_with_context(
            ToolCallView {
                id: "test",
                name,
                args: &args,
            },
            &context,
        )
        .await
}

#[tokio::test]
async fn late_grants_are_session_and_member_bound_and_revocation_updates_catalog() {
    let proxy = Arc::new(BrowserDispatcher::default());
    let session = SessionId::new();
    let sibling = SessionId::new();
    let child = view(&proxy, &session, "worker");
    let other = view(&proxy, &sibling, "sibling");
    let replaced = view(&proxy, &session, "replacement");
    assert!(child.tools().is_empty());
    let epoch = child.execution_binding_epoch("preview_status");
    let (_, host) = grant(&proxy, &session, "worker", false);
    assert!(child.execution_binding_epoch("preview_status") > epoch);
    assert_eq!(
        child
            .tools()
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["preview_status", "preview_open"]
    );
    assert!(other.tools().is_empty());
    assert!(replaced.tools().is_empty());
    assert!(
        call(child.as_ref(), &sibling, "preview_open")
            .await
            .unwrap()
            .result
            .is_error
    );
    assert!(
        call(replaced.as_ref(), &session, "preview_open")
            .await
            .unwrap()
            .result
            .is_error
    );
    assert!(
        call(child.as_ref(), &session, "device_click")
            .await
            .unwrap()
            .result
            .is_error
    );
    assert_eq!(host.calls.load(Ordering::SeqCst), 0);
    assert!(
        !call(child.as_ref(), &session, "preview_open")
            .await
            .unwrap()
            .result
            .is_error
    );
    assert_eq!(host.calls.load(Ordering::SeqCst), 2);
    proxy.revoke(&session.to_string());
    assert!(child.tools().is_empty());
    assert!(
        call(child.as_ref(), &session, "preview_open")
            .await
            .unwrap()
            .result
            .is_error
    );
    assert_eq!(host.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn child_profile_or_session_changes_fail_before_or_after_host_probe() {
    for invalidate_during_probe in [false, true] {
        let proxy = Arc::new(BrowserDispatcher::default());
        let session = SessionId::new();
        let child = view(&proxy, &session, "worker");
        let (guard, host) = grant(&proxy, &session, "worker", invalidate_during_probe);
        if !invalidate_during_probe {
            guard.current.store(false, Ordering::SeqCst);
        }
        assert!(
            call(child.as_ref(), &session, "preview_open")
                .await
                .unwrap()
                .result
                .is_error
        );
        assert_eq!(
            host.calls.load(Ordering::SeqCst),
            u64::from(invalidate_during_probe)
        );
        assert!(child.tools().is_empty());
    }
}

#[tokio::test]
async fn native_composition_preserves_tools_mutation_policy_and_late_collision_denial() {
    let proxy = Arc::new(BrowserDispatcher::default());
    let session = SessionId::new();
    let child = view(&proxy, &session, "worker");
    let existing = Arc::new(Preview {
        names: vec!["read_file"],
        calls: AtomicU64::new(0),
        invalidate_on_probe: None,
    });
    let composed: Arc<dyn AgentToolDispatcher> = Arc::new(DynamicToolComposite::new(vec![
        existing.clone(),
        child.clone(),
    ]));
    assert_eq!(composed.tools().len(), 1);
    let (_, host) = grant(&proxy, &session, "worker", false);
    assert_eq!(composed.tools().len(), 3);
    assert_eq!(
        composed.tool_mutation_class("preview_status"),
        ToolMutationClass::ReadOnly
    );
    assert_eq!(
        composed.tool_mutation_class("preview_open"),
        ToolMutationClass::Mutating
    );
    let gated = ExecutionPolicyGatedDispatcher::new(
        composed,
        ToolExecutionPolicy::resolve(meerkat_core::ops::ToolAccessPolicy::ReadOnly).unwrap(),
    );
    assert!(matches!(call(&gated, &session, "preview_open").await,
            Err(ToolError::AccessDenied { name }) if name == "preview_open"));
    assert_eq!(host.calls.load(Ordering::SeqCst), 0);
    assert!(
        !call(&gated, &session, "read_file")
            .await
            .unwrap()
            .result
            .is_error
    );
    assert!(
        !call(&gated, &session, "preview_status")
            .await
            .unwrap()
            .result
            .is_error
    );
    assert_eq!(existing.calls.load(Ordering::SeqCst), 1);
    assert_eq!(host.calls.load(Ordering::SeqCst), 2);

    proxy.revoke(&session.to_string());
    let collision = Arc::new(Preview {
        names: vec!["preview_open"],
        calls: AtomicU64::new(0),
        invalidate_on_probe: None,
    });
    let ambiguous = DynamicToolComposite::new(vec![collision.clone(), child]);
    assert_eq!(ambiguous.tools().len(), 1);
    let (_, new_host) = grant(&proxy, &session, "worker", false);
    assert!(
        !ambiguous
            .tools()
            .iter()
            .any(|tool| tool.name == "preview_open")
    );
    assert!(call(&ambiguous, &session, "preview_open").await.is_err());
    assert_eq!(collision.calls.load(Ordering::SeqCst), 0);
    assert_eq!(new_host.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn browser_source_requires_the_native_profile_allowlist() {
    assert!(allows_browser_source(&[]));
    assert!(allows_browser_source(&[
        "files".into(),
        "t3_preview".into()
    ]));
    assert!(!allows_browser_source(&["files".into()]));
    assert!(!allows_browser_source(&["T3_PREVIEW".into()]));
}

#[test]
fn unowned_or_top_level_builds_do_not_acquire_browser_tools() {
    let helper = BrowserChildTools {
        owner_mob_id: "top".into(),
        proxy: Arc::new(BrowserDispatcher::default()),
    };
    let mut build = SessionBuildOptions::default();
    helper.compose(&mut build);
    assert!(build.external_tools.is_none());
    build.mob_member_binding = Some(binding("worker"));
    helper.compose(&mut build);
    assert!(
        build.external_tools.is_none(),
        "child identity without native runtime authority is insufficient"
    );
    build.mob_member_binding.as_mut().unwrap().mob_id = "top".into();
    helper.compose(&mut build);
    assert!(build.external_tools.is_none());
}
