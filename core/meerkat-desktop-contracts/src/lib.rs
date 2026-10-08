use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum RpcId {
    String(String),
    Number(i64),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub id: Option<RpcId>,
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcErrorData {
    pub code: String,
    pub trace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: RpcErrorData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<RpcId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcResponse {
    pub fn ok(id: Option<RpcId>, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(
        id: Option<RpcId>,
        code: i64,
        message: impl Into<String>,
        typed_code: impl Into<String>,
        trace_id: impl Into<String>,
        details: Option<Value>,
    ) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: None,
            error: Some(RpcError {
                code,
                message: message.into(),
                data: RpcErrorData {
                    code: typed_code.into(),
                    trace_id: trace_id.into(),
                    details,
                },
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventEmit {
    pub event_id: String,
    pub kind: String,
    pub timestamp: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub payload: Value,
    pub trace_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DesktopLiveRunEvent {
    ThinkingDelta {
        thread_id: String,
        run_id: String,
        created_at: DateTime<Utc>,
        text_delta: String,
    },
    ThinkingSummary {
        thread_id: String,
        run_id: String,
        created_at: DateTime<Utc>,
        text: String,
    },
    ToolCommandStarted {
        thread_id: String,
        run_id: String,
        created_at: DateTime<Utc>,
        title: String,
        caption: Option<String>,
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_id: Option<String>,
    },
    ToolCommandFinished {
        thread_id: String,
        run_id: String,
        created_at: DateTime<Utc>,
        title: String,
        caption: Option<String>,
        command: String,
        output: Option<String>,
        status: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timed_out: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_result: Option<Value>,
    },
    ToolSearchFinished {
        thread_id: String,
        run_id: String,
        created_at: DateTime<Utc>,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_phase: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_arguments: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
    AssistantDelta {
        thread_id: String,
        run_id: String,
        created_at: DateTime<Utc>,
        text_delta: String,
    },
    AssistantFinal {
        thread_id: String,
        run_id: String,
        created_at: DateTime<Utc>,
        text: String,
    },
}

#[derive(Debug, Clone)]
pub struct RequestContext {
    pub trace_id: String,
}

impl RequestContext {
    pub fn local() -> Self {
        Self {
            trace_id: uuid::Uuid::new_v4().to_string(),
        }
    }
}
