import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const MeerkatUsageInput = Schema.Struct({ instanceId: ProviderInstanceId });
export type MeerkatUsageInput = typeof MeerkatUsageInput.Type;

/** Native normalized counters. Cache is part of input; reasoning is part of output. */
export const MeerkatLifetimeTokens = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadTokens: Schema.NullOr(NonNegativeInt),
  cacheCreationTokens: Schema.NullOr(NonNegativeInt),
  reasoningTokens: Schema.NullOr(NonNegativeInt),
});
export type MeerkatLifetimeTokens = typeof MeerkatLifetimeTokens.Type;

const snapshotFields = {
  observedAt: IsoDateTime,
  scope: Schema.Literal("current-provider-storage"),
  stores: NonNegativeInt,
  sessions: NonNegativeInt,
  exclusions: Schema.Tuple([
    Schema.Literal("auxiliary-generation"),
    Schema.Literal("previous-provider-storage"),
  ]),
};
export const MeerkatUsageIssue = Schema.Struct({
  code: TrimmedNonEmptyString,
  store: Schema.NullOr(Schema.String),
  message: TrimmedNonEmptyString,
});
const CompleteSnapshot = Schema.Struct({
  ...snapshotFields,
  coverage: Schema.Literal("complete"),
  totals: MeerkatLifetimeTokens,
  issues: Schema.Tuple([]),
});
const UnavailableSnapshot = Schema.Struct({
  ...snapshotFields,
  coverage: Schema.Literal("unavailable"),
  totals: Schema.Null,
  issues: Schema.Array(MeerkatUsageIssue).check(Schema.isMinLength(1)),
});
export const MeerkatNativeUsageSnapshot = Schema.Union([CompleteSnapshot, UnavailableSnapshot]);
export type MeerkatNativeUsageSnapshot = typeof MeerkatNativeUsageSnapshot.Type;
export const MeerkatUsageSnapshot = Schema.Union([
  Schema.Struct({ instanceId: ProviderInstanceId, ...CompleteSnapshot.fields }),
  Schema.Struct({ instanceId: ProviderInstanceId, ...UnavailableSnapshot.fields }),
]);
export type MeerkatUsageSnapshot = typeof MeerkatUsageSnapshot.Type;

export class MeerkatUsageError extends Schema.TaggedError<MeerkatUsageError>()(
  "MeerkatUsageError",
  { message: Schema.String },
) {}
