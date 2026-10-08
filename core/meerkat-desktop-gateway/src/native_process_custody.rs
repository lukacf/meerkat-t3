//! Bind the native custody owner before any lazy session attachment can serve.
use std::{path::PathBuf, sync::Arc};

use meerkat_core::tool_process::{
    InterruptedToolEvidence, InterruptedToolEvidenceError, InterruptedToolEvidenceSource,
};
use meerkat_tools::builtin::shell::{ProcessCustody, ProcessCustodyScope, PROCESS_CUSTODY_DIR};

pub(crate) struct NativeProcessCustody {
    runtime_root: PathBuf,
}

impl NativeProcessCustody {
    pub(crate) fn install(runtime: &meerkat_runtime::MeerkatMachine, runtime_root: PathBuf) {
        runtime.set_interrupted_tool_evidence_source(Arc::new(Self { runtime_root }));
    }

    pub(crate) async fn settle(
        runtime_root: PathBuf,
        session_id: &meerkat_core::SessionId,
    ) -> Result<Arc<ProcessCustody>, InterruptedToolEvidenceError> {
        let (custody, _) = ProcessCustody::recover_and_open(
            &runtime_root.join(PROCESS_CUSTODY_DIR),
            ProcessCustodyScope::session(session_id),
        )
        .await
        .map_err(|error| InterruptedToolEvidenceError {
            reason: error.to_string(),
        })?;
        Ok(custody)
    }

    pub(crate) async fn settle_realm(
        runtime_root: &std::path::Path,
    ) -> Result<(), InterruptedToolEvidenceError> {
        let report = ProcessCustody::sweep(&runtime_root.join(PROCESS_CUSTODY_DIR))
            .await
            .map_err(|error| InterruptedToolEvidenceError { reason: error.to_string() })?;
        for scope in report.scopes {
            scope.outcome.map_err(|error| InterruptedToolEvidenceError {
                reason: format!("Session {}: {error}", scope.scope),
            })?;
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl InterruptedToolEvidenceSource for NativeProcessCustody {
    async fn settle_session(
        &self,
        session_id: &meerkat_core::SessionId,
    ) -> Result<Option<Arc<dyn InterruptedToolEvidence>>, InterruptedToolEvidenceError> {
        // The factory opens this same native scope during agent construction.
        // This earlier seam also covers lazy attachments and schedule hosts.
        // Native custody alone proves cessation and owns interrupted-run facts.
        let custody = Self::settle(self.runtime_root.clone(), session_id).await?;
        Ok(Some(custody))
    }
}
