//! Only transient, tool-free writing requests support transport cancellation.
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
};

use meerkat_desktop_contracts::{RpcId, RpcRequest, RpcResponse};
use serde_json::json;
use tokio::sync::oneshot;

#[derive(Clone, Default)]
pub(crate) struct AuxiliaryRequests(Arc<Mutex<HashMap<String, Option<oneshot::Sender<()>>>>>);

pub(crate) struct Cancellation {
    owner: AuxiliaryRequests,
    key: String,
    cancelled: oneshot::Receiver<()>,
}

impl AuxiliaryRequests {
    // Called by the serial input loop, before spawning provider work. This
    // avoids an immediate cancel overtaking registration on another task.
    pub(crate) fn register(
        &self,
        request: &RpcRequest,
    ) -> Result<Option<Cancellation>, RpcResponse> {
        if request.method != "text.v1.generate" {
            return Ok(None);
        }
        let Some(id) = request.id.as_ref().filter(|_| request.jsonrpc == "2.0") else {
            return Err(invalid(
                request,
                "Writing requests require a JSON-RPC request identity",
            ));
        };
        let key = request_key(id);
        let mut pending = self.0.lock().expect("auxiliary request lock");
        if pending.contains_key(&key) {
            return Err(invalid(
                request,
                "Writing request identity is already active",
            ));
        }
        let (send, cancelled) = oneshot::channel();
        pending.insert(key.clone(), Some(send));
        Ok(Some(Cancellation {
            owner: self.clone(),
            key,
            cancelled,
        }))
    }

    pub(crate) fn cancel(&self, request: &RpcRequest) -> RpcResponse {
        let id = request.params.as_ref().and_then(|params| {
            let params = params.as_object()?;
            if params.len() != 1 {
                return None;
            }
            serde_json::from_value::<RpcId>(params.get("requestId")?.clone()).ok()
        });
        let Some(id) = id.filter(|_| request.jsonrpc == "2.0" && request.id.is_some()) else {
            return invalid(request, "Cancellation requires the exact writing requestId");
        };
        let mut pending = self.0.lock().expect("auxiliary request lock");
        let status = if let Some(slot) = pending.get_mut(&request_key(&id)) {
            if let Some(send) = slot.take() {
                let _ = send.send(());
            }
            "cancel_requested"
        } else {
            "not_running"
        };
        RpcResponse::ok(request.id.clone(), json!({"status":status}))
    }
}

impl Cancellation {
    pub(crate) async fn run(
        mut self,
        id: Option<RpcId>,
        work: impl Future<Output = RpcResponse>,
    ) -> RpcResponse {
        tokio::select! {
            biased;
            _ = &mut self.cancelled => RpcResponse::err(
                id, -32800, "Writing request cancelled", "REQUEST_CANCELLED",
                uuid::Uuid::new_v4().to_string(), None,
            ),
            response = work => response,
        }
    }
}

impl Drop for Cancellation {
    fn drop(&mut self) {
        self.owner
            .0
            .lock()
            .expect("auxiliary request lock")
            .remove(&self.key);
    }
}

fn request_key(id: &RpcId) -> String {
    serde_json::to_string(id).expect("JSON-RPC identity serializes")
}

fn invalid(request: &RpcRequest, message: &str) -> RpcResponse {
    RpcResponse::err(
        request.id.clone(),
        -32602,
        message,
        "INVALID_REQUEST",
        uuid::Uuid::new_v4().to_string(),
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: i64, method: &str, params: serde_json::Value) -> RpcRequest {
        RpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(RpcId::Number(id)),
            method: method.into(),
            params: Some(params),
        }
    }

    #[tokio::test]
    async fn cancellation_drops_only_its_writing_future_and_preserves_other_requests() {
        let owner = AuxiliaryRequests::default();
        let first = request(1, "text.v1.generate", json!({}));
        let second = request(2, "text.v1.generate", json!({}));
        let first_cancel = owner.register(&first).unwrap().unwrap();
        let second_cancel = owner.register(&second).unwrap().unwrap();
        assert!(
            owner
                .register(&request(3, "mobs.v1.turnStart", json!({})))
                .unwrap()
                .is_none()
        );
        assert!(owner.register(&first).is_err());
        let (dropped, observed) = oneshot::channel();
        struct DropReceipt(Option<oneshot::Sender<()>>);
        impl Drop for DropReceipt {
            fn drop(&mut self) {
                let _ = self.0.take().unwrap().send(());
            }
        }
        let receipt = DropReceipt(Some(dropped));
        let work = async move {
            let _receipt = receipt;
            std::future::pending::<RpcResponse>().await
        };
        let task = tokio::spawn(first_cancel.run(first.id, work));
        let cancel = request(4, "text.v1.cancel", json!({"requestId":1}));
        assert_eq!(
            owner.cancel(&cancel).result.unwrap()["status"],
            "cancel_requested"
        );
        assert!(
            owner
                .register(&request(1, "text.v1.generate", json!({})))
                .is_err()
        );
        assert_eq!(
            task.await.unwrap().error.unwrap().data.code,
            "REQUEST_CANCELLED"
        );
        observed.await.unwrap();
        let output = second_cancel
            .run(second.id.clone(), async {
                RpcResponse::ok(second.id, json!({"output":"kept"}))
            })
            .await;
        assert_eq!(output.result.unwrap()["output"], "kept");
        assert_eq!(
            owner.cancel(&cancel).result.unwrap()["status"],
            "not_running"
        );
        assert!(owner.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn completion_wins_before_late_cancellation_and_bad_ids_do_not_match() {
        let owner = AuxiliaryRequests::default();
        let request = request(1, "text.v1.generate", json!({}));
        let slot = owner.register(&request).unwrap().unwrap();
        let mut cancel = self::request(2, "text.v1.cancel", json!({"requestId":"1"}));
        assert_eq!(
            owner.cancel(&cancel).result.unwrap()["status"],
            "not_running"
        );
        cancel.params = Some(json!({"requestId":1,"method":"mobs.v1.turnStart"}));
        assert_eq!(
            owner.cancel(&cancel).error.unwrap().data.code,
            "INVALID_REQUEST"
        );
        assert!(
            slot.run(request.id.clone(), async {
                RpcResponse::ok(request.id, json!({}))
            })
            .await
            .error
            .is_none()
        );
        assert!(owner.0.lock().unwrap().is_empty());
    }
}
