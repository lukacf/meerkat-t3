import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useEnvironments } from "../../state/environments";
import { meerkatControlsEnvironment } from "../../state/meerkatControls";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";

const count = (value: number | null) => (value === null ? "Not reported" : value.toLocaleString());

export function NativeUsageSection({
  selectedEnvironmentIds,
}: {
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
}) {
  const { environments } = useEnvironments();
  const sources = environments
    .filter(
      (environment) =>
        !selectedEnvironmentIds || selectedEnvironmentIds.has(environment.environmentId),
    )
    .flatMap((environment) =>
      (environment.serverConfig?.providers ?? [])
        .filter((provider) => provider.driver === "meerkat" && provider.enabled)
        .map((provider) => ({
          environmentId: environment.environmentId,
          instanceId: provider.instanceId,
          label: `${environment.label} / ${provider.displayName ?? "Meerkat"}`,
        })),
    );
  return (
    <section
      className="mb-5 space-y-3 rounded-lg border border-border bg-muted/20 p-4"
      aria-label="Meerkat usage"
    >
      <div>
        <h2 className="text-sm font-medium">Meerkat lifetime tokens</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Recorded coordinator, specialist, and worker usage in each connection's current storage.
          These snapshots are separate from the period charts and cost estimates below.
        </p>
      </div>
      {sources.map((source) => (
        <NativeUsageCard key={`${source.environmentId}:${source.instanceId}`} {...source} />
      ))}
      {sources.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No enabled Meerkat connection in the selected computers.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Cache is part of input; reasoning is part of output. Previous storage locations and
        auxiliary generation, such as titles, are excluded. Connections using the same storage may
        overlap; their totals are not added together. Provider accounts determine actual charges. A
        zero in the charts below does not mean no Meerkat usage.{" "}
        <Link to="/help" search={{ topic: "accounts" }} className="underline underline-offset-2">
          Account and billing guide
        </Link>
      </p>
    </section>
  );
}

export function NativeUsageCard({
  environmentId,
  instanceId,
  label,
}: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  label: string;
}) {
  const [requested, setRequested] = useState(false);
  const query = useEnvironmentQuery(
    requested
      ? meerkatControlsEnvironment.usageSnapshot({
          environmentId,
          input: { instanceId },
        })
      : null,
  );
  const snapshot = query.data;
  const totals = !query.error && snapshot?.coverage === "complete" ? snapshot.totals : null;
  return (
    <div className="space-y-2 rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{label}</h3>
        <Button
          size="xs"
          variant="outline"
          disabled={query.isPending}
          onClick={() => {
            if (requested) query.refresh();
            else setRequested(true);
          }}
        >
          {query.isPending
            ? "Reading usage..."
            : requested
              ? "Refresh snapshot"
              : "Load recorded usage"}
        </Button>
      </div>
      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          Usage is unavailable. {query.error}
        </p>
      )}
      {snapshot && !query.error && (
        <>
          <p className="text-xs text-muted-foreground">
            {snapshot.coverage === "complete" ? "Included" : "Inspected"} {snapshot.sessions}{" "}
            retained sessions in {snapshot.stores} stores. Snapshot taken{" "}
            {new Date(snapshot.observedAt).toLocaleString()}.
          </p>
          {totals ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-5">
              {(
                [
                  ["Input", totals.inputTokens],
                  ["Output", totals.outputTokens],
                  ["Cache read", totals.cacheReadTokens],
                  ["Cache write", totals.cacheCreationTokens],
                  ["Reasoning", totals.reasoningTokens],
                ] as const
              ).map(([name, value]) => (
                <div key={name}>
                  <dt className="text-xs text-muted-foreground">{name}</dt>
                  <dd className="tabular-nums">{count(value)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p role="status" className="text-sm">
              A complete snapshot is unavailable. No total is shown.
            </p>
          )}
          {snapshot.issues.length > 0 && (
            <ul className="list-inside list-disc text-xs text-muted-foreground">
              {snapshot.issues.map((issue) => (
                <li key={`${issue.code}:${issue.store ?? "root"}:${issue.message}`}>
                  {issue.message}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {requested && !snapshot && !query.error && !query.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Waiting for the usage snapshot.
        </p>
      )}
    </div>
  );
}
