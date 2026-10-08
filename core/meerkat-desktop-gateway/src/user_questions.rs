use meerkat_core::types::{ContentBlock, ToolCallView, ToolDef, ToolResult};
use meerkat_core::{AgentToolDispatcher, ToolDispatchContext, ToolDispatchOutcome, ToolError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::oneshot;

use crate::GatewayError;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct QuestionOption {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Question {
    pub id: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    #[serde(default = "yes")]
    pub allow_custom: bool,
    #[serde(default)]
    pub multi_select: bool,
}
fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct QuestionInput {
    pub title: String,
    pub questions: Vec<Question>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Answer {
    pub question_id: String,
    #[serde(default)]
    pub selected_option_ids: Vec<String>,
    #[serde(default)]
    pub custom_text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingQuestion {
    pub request_id: String,
    pub session_id: String,
    pub mob_id: String,
    pub tool_call_id: String,
    pub created_at: String,
    #[serde(flatten)]
    pub input: QuestionInput,
}

struct Waiting {
    scope: Scope,
    question: PendingQuestion,
    sender: oneshot::Sender<Value>,
}

#[derive(Clone, PartialEq, Eq)]
struct Scope {
    project_path: PathBuf,
    state_root: PathBuf,
    mob_id: String,
}

#[derive(Default)]
struct Broker {
    waiting: BTreeMap<String, Waiting>,
}
static BROKER: OnceLock<Mutex<Broker>> = OnceLock::new();
fn broker() -> &'static Mutex<Broker> {
    BROKER.get_or_init(|| Mutex::new(Broker::default()))
}

// Dropping a cancelled native tool future withdraws its question. An answer
// never starts another turn or redirects itself to a replacement session.
struct PendingGuard(String);
impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Ok(mut broker) = broker().lock() {
            broker.waiting.remove(&self.0);
        }
    }
}

pub(crate) fn dispatcher(
    project_path: PathBuf,
    state_root: PathBuf,
    mob_id: String,
) -> Option<Arc<dyn AgentToolDispatcher>> {
    (std::env::var("MEERKAT_APP_QUESTIONS").as_deref() == Ok("1")).then(|| {
        Arc::new(QuestionDispatcher(Scope {
            project_path,
            state_root,
            mob_id,
        })) as Arc<dyn AgentToolDispatcher>
    })
}

struct QuestionDispatcher(Scope);

fn tool_definition() -> ToolDef {
    ToolDef::new("ui_multiple_choice", "Ask the user one to three short questions. Provide named choices where useful; allow a custom answer. Wait for the user's answer before dependent work.", json!({
        "type":"object", "additionalProperties":false,
        "required":["title","questions"],
        "properties": {
            "title":{"type":"string","minLength":1,"maxLength":200},
            "questions":{"type":"array","minItems":1,"maxItems":3,"items":{
                "type":"object","additionalProperties":false,"required":["id","question"],
                "properties":{
                    "id":{"type":"string","minLength":1,"maxLength":100},
                    "question":{"type":"string","minLength":1,"maxLength":2000},
                    "allowCustom":{"type":"boolean","default":true},
                    "multiSelect":{"type":"boolean","default":false},
                    "options":{"type":"array","maxItems":8,"items":{
                        "type":"object","additionalProperties":false,"required":["id","label"],
                        "properties":{
                            "id":{"type":"string","minLength":1,"maxLength":100},
                            "label":{"type":"string","minLength":1,"maxLength":200},
                            "description":{"type":"string","maxLength":2000}
                        }
                    }}
                }
            }}
        }
    }))
}

fn result(call_id: &str, value: Value, failed: bool) -> ToolDispatchOutcome {
    let block = ContentBlock::structured(&value).unwrap_or_else(|_| ContentBlock::Text {
        text: value.to_string(),
    });
    ToolResult::with_blocks(call_id.to_string(), vec![block], failed).into()
}

fn validate(input: &QuestionInput) -> Result<(), &'static str> {
    if input.title.trim().is_empty()
        || input.title.len() > 200
        || !(1..=3).contains(&input.questions.len())
    {
        return Err("Supply a title and one to three questions.");
    }
    let mut ids = HashSet::new();
    for question in &input.questions {
        if question.id.trim().is_empty()
            || question.id.len() > 100
            || !ids.insert(&question.id)
            || question.question.trim().is_empty()
            || question.question.len() > 2000
            || question.options.len() > 8
            || (question.options.is_empty() && !question.allow_custom)
        {
            return Err("Questions need unique IDs, valid text and an answer method.");
        }
        let mut options = HashSet::new();
        for option in &question.options {
            if option.id.trim().is_empty()
                || option.id.len() > 100
                || !options.insert(&option.id)
                || option.label.trim().is_empty()
                || option.label.len() > 200
                || option.description.len() > 2000
            {
                return Err("Choices need unique IDs and nonempty labels.");
            }
        }
    }
    Ok(())
}

#[async_trait::async_trait]
impl AgentToolDispatcher for QuestionDispatcher {
    fn tools(&self) -> Arc<[Arc<ToolDef>]> {
        Arc::from([Arc::new(tool_definition())])
    }
    fn tool_mutation_class(&self, name: &str) -> meerkat_core::ToolMutationClass {
        // This only presents a question and returns the answer to its owning
        // session. It does not execute the answer or grant tool permissions.
        if name == "ui_multiple_choice" {
            meerkat_core::ToolMutationClass::ReadOnly
        } else {
            meerkat_core::ToolMutationClass::Unknown
        }
    }
    async fn dispatch(&self, call: ToolCallView<'_>) -> Result<ToolDispatchOutcome, ToolError> {
        Ok(result(
            call.id,
            json!({"error":"A native session identity is required."}),
            true,
        ))
    }
    async fn dispatch_with_context(
        &self,
        call: ToolCallView<'_>,
        context: &ToolDispatchContext,
    ) -> Result<ToolDispatchOutcome, ToolError> {
        if call.name != "ui_multiple_choice" {
            return self.dispatch(call).await;
        }
        let Some(session_id) = context.origin_session_id() else {
            return self.dispatch(call).await;
        };
        let input: QuestionInput = match serde_json::from_str(call.args.get()) {
            Ok(input) => input,
            Err(error) => return Ok(result(call.id, json!({"error":error.to_string()}), true)),
        };
        if let Err(error) = validate(&input) {
            return Ok(result(call.id, json!({"error":error}), true));
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let question = PendingQuestion {
            request_id: request_id.clone(),
            session_id: session_id.to_string(),
            mob_id: self.0.mob_id.clone(),
            tool_call_id: call.id.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            input,
        };
        let (sender, receiver) = oneshot::channel();
        {
            let mut broker = broker().lock().map_err(|_| ToolError::ExecutionFailed {
                message: "Question service unavailable.".into(),
            })?;
            if broker.waiting.len() >= 128 {
                return Ok(result(
                    call.id,
                    json!({"error":"Too many unanswered questions."}),
                    true,
                ));
            }
            broker.waiting.insert(
                request_id.clone(),
                Waiting {
                    scope: self.0.clone(),
                    question,
                    sender,
                },
            );
        }
        let _guard = PendingGuard(request_id);
        Ok(match receiver.await {
            Ok(answer) => result(call.id, answer, false),
            Err(_) => result(call.id, json!({"dismissed":true}), false),
        })
    }
}

pub(crate) fn list(
    project_path: PathBuf,
    state_root: PathBuf,
    mob_id: String,
    session_id: Option<String>,
) -> Result<Value, GatewayError> {
    let scope = Scope {
        project_path,
        state_root,
        mob_id,
    };
    let broker = broker()
        .lock()
        .map_err(|_| GatewayError::policy("Question service unavailable", None))?;
    let requests: Vec<_> = broker
        .waiting
        .values()
        .filter(|entry| {
            entry.scope == scope
                && session_id
                    .as_ref()
                    .is_none_or(|session| session == &entry.question.session_id)
        })
        .map(|entry| &entry.question)
        .collect();
    Ok(json!({"requests":requests}))
}

pub(crate) fn answer(
    project_path: PathBuf,
    state_root: PathBuf,
    mob_id: String,
    session_id: String,
    request_id: String,
    answers: Vec<Answer>,
    dismissed: bool,
) -> Result<Value, GatewayError> {
    let scope = Scope {
        project_path,
        state_root,
        mob_id,
    };
    let mut broker = broker()
        .lock()
        .map_err(|_| GatewayError::policy("Question service unavailable", None))?;
    let entry = broker
        .waiting
        .get(&request_id)
        .ok_or_else(|| GatewayError::policy("This question is no longer pending", None))?;
    if entry.scope != scope || entry.question.session_id != session_id {
        return Err(GatewayError::policy(
            "Question belongs to another agent session",
            None,
        ));
    }
    if !dismissed {
        if answers.len() != entry.question.input.questions.len() {
            return Err(GatewayError::invalid("Answer every question", None));
        }
        for question in &entry.question.input.questions {
            let matching: Vec<_> = answers
                .iter()
                .filter(|a| a.question_id == question.id)
                .collect();
            if matching.len() != 1 {
                return Err(GatewayError::invalid(
                    "Question answer IDs must match",
                    None,
                ));
            }
            let answer = matching[0];
            let selected: HashSet<_> = answer.selected_option_ids.iter().collect();
            if (!question.multi_select && selected.len() > 1)
                || selected.len() != answer.selected_option_ids.len()
                || selected
                    .iter()
                    .any(|id| !question.options.iter().any(|o| &o.id == *id))
                || (!question.allow_custom && !answer.custom_text.is_empty())
                || answer.custom_text.len() > 16000
                || (selected.is_empty() && answer.custom_text.trim().is_empty())
            {
                return Err(GatewayError::invalid("Invalid or empty answer", None));
            }
        }
    }
    let entry = broker
        .waiting
        .remove(&request_id)
        .expect("validated pending question");
    entry
        .sender
        .send(json!({"dismissed":dismissed,"answers":answers}))
        .map_err(|_| GatewayError::policy("The agent stopped waiting for this answer", None))?;
    Ok(json!({"accepted":true,"requestId":request_id}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::{poll_fn, Future};
    use std::task::Poll;

    fn scope() -> Scope {
        Scope {
            project_path: PathBuf::from("/fixture/project"),
            state_root: PathBuf::from("/fixture/state"),
            mob_id: uuid::Uuid::new_v4().to_string(),
        }
    }
    fn arguments() -> Box<serde_json::value::RawValue> {
        serde_json::value::RawValue::from_string(json!({"title":"Choose a direction","questions":[{"id":"direction","question":"Which direction?","options":[{"id":"left","label":"Left"},{"id":"right","label":"Right"}],"allowCustom":true}]}).to_string()).unwrap()
    }
    fn pending(scope: &Scope) -> Value {
        list(
            scope.project_path.clone(),
            scope.state_root.clone(),
            scope.mob_id.clone(),
            None,
        )
        .unwrap()
    }
    fn respond(
        scope: &Scope,
        session: &str,
        id: &str,
        selected: &str,
    ) -> Result<Value, GatewayError> {
        answer(
            scope.project_path.clone(),
            scope.state_root.clone(),
            scope.mob_id.clone(),
            session.into(),
            id.into(),
            vec![Answer {
                question_id: "direction".into(),
                selected_option_ids: vec![selected.into()],
                custom_text: String::new(),
            }],
            false,
        )
    }

    #[tokio::test]
    async fn exact_session_answers_resume_only_the_waiting_tool() {
        let scope = scope();
        let dispatcher = QuestionDispatcher(scope.clone());
        let session = meerkat_core::types::SessionId::new();
        let context = ToolDispatchContext::default().with_runtime_identity(session.clone(), None);
        let args = arguments();
        let mut future = Box::pin(dispatcher.dispatch_with_context(
            ToolCallView {
                id: "call-1",
                name: "ui_multiple_choice",
                args: &args,
            },
            &context,
        ));
        poll_fn(|cx| {
            assert!(future.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        let snapshot = pending(&scope);
        let id = snapshot["requests"][0]["requestId"].as_str().unwrap();
        assert_eq!(snapshot["requests"][0]["sessionId"], session.to_string());
        assert_eq!(snapshot["requests"][0]["questions"][0]["allowCustom"], true);
        assert!(respond(&scope, "replacement-session", id, "left").is_err());
        assert!(respond(&scope, &session.to_string(), id, "not-a-choice").is_err());
        let mut other_scope = scope.clone();
        other_scope.state_root = PathBuf::from("/other-state");
        assert!(respond(&other_scope, &session.to_string(), id, "left").is_err());
        assert_eq!(pending(&scope)["requests"].as_array().unwrap().len(), 1);
        assert_eq!(
            respond(&scope, &session.to_string(), id, "left").unwrap()["accepted"],
            true
        );
        let outcome = future.await.unwrap();
        assert!(!outcome.result.is_error);
        assert!(pending(&scope)["requests"].as_array().unwrap().is_empty());
        assert!(respond(&scope, &session.to_string(), id, "left").is_err());
    }

    #[tokio::test]
    async fn read_only_question_waits_for_its_answer_without_admitting_other_tools() {
        let scope = scope();
        let tools = meerkat_core::ToolGatewayBuilder::new()
            .add_dispatcher(Arc::new(QuestionDispatcher(scope.clone())))
            .build()
            .unwrap();
        let dispatcher = meerkat_core::tool_execution_policy::ExecutionPolicyGatedDispatcher::new(
            Arc::new(tools),
            meerkat_core::ToolExecutionPolicy::resolve(meerkat_core::ops::ToolAccessPolicy::ReadOnly)
                .unwrap(),
        );
        let session = meerkat_core::types::SessionId::new();
        let context = ToolDispatchContext::default().with_runtime_identity(session.clone(), None);
        let args = arguments();
        assert!(dispatcher
            .dispatch_with_context(
                ToolCallView { id: "blocked", name: "unaudited_mcp", args: &args },
                &context,
            )
            .await
            .is_err());
        assert!(pending(&scope)["requests"].as_array().unwrap().is_empty());
        let mut future = Box::pin(dispatcher.dispatch_with_context(
            ToolCallView { id: "read-only-question", name: "ui_multiple_choice", args: &args },
            &context,
        ));
        poll_fn(|cx| {
            assert!(future.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        }).await;
        let snapshot = pending(&scope);
        let id = snapshot["requests"][0]["requestId"].as_str().unwrap();
        assert!(respond(&scope, "different-session", id, "left").is_err());
        respond(&scope, &session.to_string(), id, "right").unwrap();
        let outcome = future.await.unwrap();
        assert!(!outcome.result.is_error);
        assert!(outcome.result.text_content().contains("right"));
        assert!(pending(&scope)["requests"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn stopping_the_native_tool_withdraws_its_question() {
        let scope = scope();
        let dispatcher = QuestionDispatcher(scope.clone());
        let context = ToolDispatchContext::default()
            .with_runtime_identity(meerkat_core::types::SessionId::new(), None);
        let args = arguments();
        let mut future = Box::pin(dispatcher.dispatch_with_context(
            ToolCallView {
                id: "call-stop",
                name: "ui_multiple_choice",
                args: &args,
            },
            &context,
        ));
        poll_fn(|cx| {
            assert!(future.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        assert_eq!(pending(&scope)["requests"].as_array().unwrap().len(), 1);
        drop(future);
        assert!(pending(&scope)["requests"].as_array().unwrap().is_empty());
    }
}
