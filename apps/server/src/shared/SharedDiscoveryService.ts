import {
  SharedDiscoveryInput,
  SharedWorkspaceError,
  type SharedDiscoveryAssignmentMatch,
  type SharedDiscoveryMatch,
  type SharedDiscoveryReason,
  type SharedDiscoveryResult,
  type SharedSpecialistAssignment,
  type SharedSpecialistSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SharedWorkspaceStore } from "./SharedWorkspaceStore.ts";

const MAX_DIRECTORY_SPECIALISTS = 100;
const MAX_RESPONSE_BYTES = 192 * 1024;
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeInput = Schema.decodeUnknownEffect(SharedDiscoveryInput);
const fail = (code: SharedWorkspaceError["code"], message: string) =>
  new SharedWorkspaceError({ code, message });
const overlaps = (left: string, right: string) => {
  const a = left.replace(/\/+$/, "");
  const b = right.replace(/\/+$/, "");
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

const matchAssignment = (
  assignment: SharedSpecialistAssignment,
  label: string,
  input: SharedDiscoveryInput,
): SharedDiscoveryAssignmentMatch | null => {
  if (input.sharedProjectId && assignment.sharedProjectId !== input.sharedProjectId) return null;
  const query = input.query?.toLowerCase();
  const textSource = query
    ? label.toLowerCase().includes(query)
      ? "label"
      : assignment.charter.toLowerCase().includes(query)
        ? "charter"
        : null
    : null;
  // A general assignment does not bypass an explicit text query.
  if (query && !textSource) return null;
  const paths = input.paths ?? [];
  const tags = input.tags ?? [];
  const hasScope = paths.length > 0 || tags.length > 0;
  const path = assignment.paths.find((candidate) =>
    paths.some((value) => overlaps(candidate, value)),
  );
  const tag = assignment.tags.find((candidate) => tags.includes(candidate));
  const general = !assignment.paths.length && !assignment.tags.length;
  if (hasScope && path === undefined && tag === undefined && !general) return null;

  const reasons: SharedDiscoveryReason[] = [];
  if (input.sharedProjectId || (!hasScope && !query)) reasons.push({ kind: "project" });
  if (path !== undefined) reasons.push({ kind: "path", path });
  if (tag !== undefined) reasons.push({ kind: "tag", tag });
  if (textSource) reasons.push({ kind: "description", source: textSource });
  if (hasScope && general) reasons.push({ kind: "general" });
  // Avoid ending an excerpt in the middle of a Unicode surrogate pair.
  const charterExcerpt = assignment.charter.slice(0, 600).replace(/[\uD800-\uDBFF]$/, "");
  return {
    sharedProjectId: assignment.sharedProjectId,
    reasons,
    charterExcerpt,
    charterExcerptTruncated: charterExcerpt.length < assignment.charter.length,
  };
};

/** Directory inspection only. Native existence and execution are not discovery facts. */
export const makeSharedDiscoveryService = (
  workspace: Pick<SharedWorkspaceStore, "listSpecialists" | "specialist">,
) => {
  const discover = Effect.fn("SharedDiscovery.discover")(function* (
    raw: SharedDiscoveryInput,
  ): Effect.fn.Return<SharedDiscoveryResult, SharedWorkspaceError> {
    const input = yield* decodeInput(raw).pipe(
      Effect.mapError(() => fail("invalid_input", "Invalid specialist discovery filters.")),
    );
    if (
      input.paths?.some(
        (path) =>
          !path ||
          path.startsWith("/") ||
          path.includes("\\") ||
          path.split("/").some((segment) => segment === "." || segment === "..") ||
          Array.from(path).some((character) => character.charCodeAt(0) < 32),
      )
    )
      return yield* fail(
        "invalid_input",
        "Discovery paths must be literal repository-relative paths without traversal.",
      );

    // The directory caps retained specialists at 100. Bound every scan even if
    // storage is inconsistent, and never use an unbounded full-workspace snapshot.
    const candidates: SharedSpecialistSummary[] = [];
    let after = input.after;
    do {
      const page = yield* workspace.listSpecialists({
        ...(after ? { after } : {}),
        limit: MAX_DIRECTORY_SPECIALISTS - candidates.length,
      });
      candidates.push(...page.items);
      if (!page.nextCursor) break;
      if (candidates.length >= MAX_DIRECTORY_SPECIALISTS || !page.items.length)
        return yield* fail(
          "limit_exceeded",
          "The shared specialist directory exceeds its bounded scan limit.",
        );
      if (after && page.nextCursor <= after)
        return yield* fail(
          "unavailable",
          "The shared specialist directory cursor did not advance.",
        );
      after = page.nextCursor;
    } while (true);

    const matched: SharedDiscoveryMatch[] = [];
    for (const candidate of candidates) {
      if (candidate.supersededAt && !input.includeSuperseded) continue;
      const specialist = yield* workspace.specialist(candidate.specialistId);
      if (specialist.supersededAt && !input.includeSuperseded) continue;
      const matches = specialist.assignments.flatMap((assignment) => {
        const match = matchAssignment(assignment, specialist.label, input);
        return match ? [match] : [];
      });
      if (matches.length)
        matched.push({
          specialistId: specialist.specialistId,
          label: specialist.label,
          sharedProjectIds: specialist.assignments.map((assignment) => assignment.sharedProjectId),
          assignmentVersion: specialist.assignmentVersion,
          supersededAt: specialist.supersededAt,
          successorId: specialist.successorId,
          matches,
        });
    }

    const items: SharedDiscoveryMatch[] = [];
    for (const match of matched) {
      if (items.length >= (input.limit ?? 25)) break;
      if (
        Buffer.byteLength(encode({ items: [...items, match], nextCursor: match.specialistId })) >
        MAX_RESPONSE_BYTES
      ) {
        if (!items.length)
          return yield* fail(
            "limit_exceeded",
            "This specialist's discovery summary exceeds the response limit. Fetch its directory detail instead.",
          );
        break;
      }
      items.push(match);
    }
    return {
      items,
      nextCursor: matched.length > items.length ? items[items.length - 1]!.specialistId : null,
    };
  });
  return { discover };
};
