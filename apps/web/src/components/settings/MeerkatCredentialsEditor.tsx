import { Link } from "@tanstack/react-router";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderInstanceEnvironmentVariable,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  attemptCredentialSetup,
  requireCredentialSetupReady,
  type CredentialSetupStage,
} from "../../onboarding/credentialSubmission";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ProviderEnvironmentSection } from "./ProviderInstanceCard";

interface MeerkatCredentialsEditorProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly readOnly?: boolean;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly onErrorChange?: (hasError: boolean) => void;
  /** Covers the request lifetime, including completion after this editor unmounts. */
  readonly onActivityChange?: (pending: boolean) => void;
}

/** Retry values belong only to the selected environment and provider instance. */
export function MeerkatCredentialsEditor(props: MeerkatCredentialsEditorProps) {
  return (
    <CredentialEditor key={JSON.stringify([props.environmentId, props.instanceId])} {...props} />
  );
}

function CredentialEditor({
  environmentId,
  environmentLabel,
  instanceId,
  readOnly = false,
  onPendingChange,
  onErrorChange,
  onActivityChange,
}: MeerkatCredentialsEditorProps) {
  const settings = useEnvironmentSettings(environmentId);
  const settingsRef = useRef(settings);
  const readOnlyRef = useRef(readOnly);
  useLayoutEffect(() => {
    settingsRef.current = settings;
    readOnlyRef.current = readOnly;
  }, [readOnly, settings]);
  const update = useAtomCommand(serverEnvironment.updateProviderSettings, { reportFailure: false });
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<CredentialSetupStage | null>(null);
  const [saved, setSaved] = useState(false);
  const [ready, setReady] = useState(false);
  const [retryStage, setRetryStage] = useState<CredentialSetupStage | null>(null);
  const pendingRef = useRef(false);
  const activeRef = useRef(true);
  // Failed values are held only in this mounted editor, never client storage.
  const retryAttempt = useRef<{
    variables: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
    stage: CredentialSetupStage;
  } | null>(null);
  useLayoutEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      retryAttempt.current = null;
    };
  }, []);
  useEffect(() => {
    onPendingChange?.(pending !== null);
  }, [onPendingChange, pending]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);
  useEffect(() => {
    onErrorChange?.(error !== null);
  }, [error, onErrorChange]);
  useEffect(() => () => onErrorChange?.(false), [onErrorChange]);

  const canEdit = () => activeRef.current && !readOnlyRef.current && !pendingRef.current;
  const save = async (
    variables: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
    stage: CredentialSetupStage = "save",
  ) => {
    if (!canEdit()) return;
    pendingRef.current = true;
    onActivityChange?.(true);
    retryAttempt.current = null;
    setRetryStage(null);
    setPending(stage);
    setError(null);
    setSaved(stage === "check");
    setReady(false);
    const result = await attemptCredentialSetup({
      variables,
      stage,
      save: async (attemptedVariables) => {
        const current = settingsRef.current;
        const instance = current.providerInstances[instanceId];
        if (!instance || instance.driver !== "meerkat") {
          throw new Error("This Meerkat provider is no longer configured.");
        }
        const result = await update({
          environmentId,
          input: {
            kind: "edit",
            instanceId,
            driver: instance.driver,
            changes: { environment: attemptedVariables },
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        if (activeRef.current) setSaved(true);
      },
      check: async () => {
        if (!activeRef.current) return;
        setPending("check");
        const result = await refresh({ environmentId, input: { instanceId } });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        requireCredentialSetupReady(
          result.value.providers.find((provider) => provider.instanceId === instanceId),
        );
      },
    });
    onActivityChange?.(false);
    if (!activeRef.current) return;
    retryAttempt.current = result.ok ? null : { variables, stage: result.stage };
    setRetryStage(result.ok ? null : result.stage);
    // A provider diagnostic can echo input. Never render entered values in errors.
    const message = result.ok
      ? null
      : variables.reduce(
          (message, variable) =>
            variable.value.length > 0 ? message.replaceAll(variable.value, "[redacted]") : message,
          result.message,
        );
    setError(message);
    setReady(result.ok);
    pendingRef.current = false;
    setPending(null);
  };
  const instance = settings.providerInstances[instanceId];
  if (!instance || instance.driver !== "meerkat") {
    return <p role="status">This Meerkat provider is no longer configured.</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Use an API key from your model provider's developer account. API usage may be billed
        separately from a chat subscription. Credentials stay on {environmentLabel}.
      </p>
      <Link
        to="/help"
        search={{ topic: "accounts" }}
        className="text-xs text-primary underline underline-offset-2"
      >
        How to get provider credentials
      </Link>
      <fieldset disabled={pending !== null || readOnly}>
        <ProviderEnvironmentSection
          nativeCredentials
          canEdit={canEdit}
          environment={instance.environment ?? []}
          onChange={(variables) => {
            void save(variables);
          }}
        />
      </fieldset>
      <p className="text-xs text-muted-foreground" role="status">
        {pending === "save"
          ? "Saving credential changes..."
          : pending === "check"
            ? "Credential changes saved. Checking the runtime..."
            : ready
              ? "Credentials saved. Runtime setup is ready; your first request will confirm model access."
              : saved
                ? "Credential changes saved. The runtime still needs attention."
                : null}
      </p>
      {error ? (
        <div className="space-y-2">
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
          {retryStage ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending !== null || readOnly}
              onClick={() => {
                const attempt = retryAttempt.current;
                if (attempt) void save(attempt.variables, attempt.stage);
              }}
            >
              {retryStage === "save" ? "Retry save" : "Retry check"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
