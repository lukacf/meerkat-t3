use super::*;
use std::{
    pin::Pin,
    sync::Mutex,
    task::{Context, Poll},
};
use tokio::sync::oneshot;

struct PendingModelStream {
    dropped: Option<oneshot::Sender<()>>,
}

impl futures_util::Stream for PendingModelStream {
    type Item = Result<meerkat::LlmEvent, meerkat::LlmError>;

    fn poll_next(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Poll::Pending
    }
}

impl Drop for PendingModelStream {
    fn drop(&mut self) {
        if let Some(dropped) = self.dropped.take() {
            let _ = dropped.send(());
        }
    }
}

struct PendingModel {
    admitted: Mutex<Option<oneshot::Sender<()>>>,
    dropped: Mutex<Option<oneshot::Sender<()>>>,
}

#[async_trait::async_trait]
impl LlmClient for PendingModel {
    fn project_replay_messages(
        &self,
        messages: &[Message],
    ) -> Result<Vec<Message>, meerkat::LlmError> {
        Ok(messages.to_vec())
    }

    fn stream<'a>(
        &'a self,
        request: &'a meerkat::LlmRequest,
    ) -> Pin<
        Box<
            dyn futures_util::Stream<Item = Result<meerkat::LlmEvent, meerkat::LlmError>>
                + Send
                + 'a,
        >,
    > {
        assert!(request.tools.is_empty());
        self.admitted
            .lock()
            .unwrap()
            .take()
            .expect("only one model call")
            .send(())
            .unwrap();
        Box::pin(PendingModelStream {
            dropped: self.dropped.lock().unwrap().take(),
        })
    }

    fn provider(&self) -> Provider {
        Provider::Anthropic
    }

    async fn health_check(&self) -> Result<(), meerkat::LlmError> {
        Ok(())
    }
}

#[tokio::test]
async fn cancellation_drops_model_future_and_unregisters_native_session() {
    let (admitted_tx, admitted_rx) = oneshot::channel();
    let (dropped_tx, dropped_rx) = oneshot::channel();
    let (cleanup_tx, cleanup_rx) = oneshot::channel();
    let mut request_runtime = WritingRuntime::new();
    let machine = request_runtime.runtime.clone();
    let session_id = request_runtime.session_id.as_ref().unwrap().clone();
    request_runtime.cleanup_receipt = Some(cleanup_tx);
    let task = tokio::spawn(async move {
        let input = GenerationInput {
            project_path: "/unused".into(),
            config_state_root: "/unused".into(),
            model: "claude-sonnet-4-6".into(),
            provider: "anthropic".into(),
            provider_params: None,
            prompt: "Title the supplied change".into(),
            output_schema: json!({"type":"object","properties":{"title":{"type":"string"}},"required":["title"],"additionalProperties":false}),
            images: vec![],
        };
        let identity = SessionLlmIdentity {
            model: input.model.clone(),
            provider: Provider::Anthropic,
            self_hosted_server_id: None,
            provider_params: None,
            auth_binding: None,
        };
        execute_in_runtime(
            &AgentFactory::minimal(),
            &meerkat::Config::default(),
            &identity,
            None,
            Some(Arc::new(PendingModel {
                admitted: Mutex::new(Some(admitted_tx)),
                dropped: Mutex::new(Some(dropped_tx)),
            })),
            &input,
            request_runtime,
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), admitted_rx)
        .await
        .unwrap()
        .unwrap();
    assert!(
        machine.contains_session(&session_id).await,
        "Model call has native session authority"
    );
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(5), dropped_rx)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), cleanup_rx)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        !machine.contains_session(&session_id).await,
        "Cancelled helper leaked its native registration"
    );
}
