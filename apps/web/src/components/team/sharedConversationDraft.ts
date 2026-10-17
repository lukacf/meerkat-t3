import {
  SharedWorkContextInput,
  type SharedWorkContext,
  type SharedSpecialistSendInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { browserAgentDraftStorage, writeAgentDraftStorage } from "./agentDraftStorage";

export const SharedPendingRequest = Schema.Struct({
  requestId: Schema.String,
  participantId: Schema.String,
  workspaceId: Schema.String,
  context: SharedWorkContextInput,
  contextVersion: Schema.NullOr(Schema.String),
  text: Schema.String,
});
export type SharedPendingRequest = typeof SharedPendingRequest.Type;
const SharedDraft = Schema.Struct({
  text: Schema.String,
  pending: Schema.NullOr(SharedPendingRequest),
});
export type SharedDraft = typeof SharedDraft.Type;
const decodeDraft = Schema.decodeUnknownSync(SharedDraft);
export function readSharedDraft(key: string): SharedDraft {
  const raw = browserAgentDraftStorage("localStorage")?.getItem(key);
  if (!raw) return { text: "", pending: null };
  return decodeDraft(JSON.parse(raw));
}
export function saveSharedDraft(key: string, draft: SharedDraft): boolean {
  return writeAgentDraftStorage(browserAgentDraftStorage("localStorage"), key, draft);
}

/** Bind and persist the immutable context before any request may reach the native host. */
export async function deliverSharedRequest<T>(
  pending: SharedPendingRequest,
  specialistId: string,
  actions: {
    putContext: (input: SharedWorkContextInput) => Promise<SharedWorkContext>;
    persist: (pending: SharedPendingRequest) => boolean;
    send: (input: SharedSpecialistSendInput) => Promise<T>;
  },
): Promise<T> {
  let bound = pending;
  if (!bound.contextVersion) {
    const context = await actions.putContext(bound.context);
    if (
      context.contextId !== bound.context.contextId ||
      context.participantId !== bound.participantId
    )
      throw new Error("The shared host returned a different request context.");
    bound = { ...bound, contextVersion: context.contextVersion };
    if (!actions.persist(bound))
      throw new Error(
        "The request context could not be saved on this device. Nothing has been sent to the specialist.",
      );
  }
  return actions.send({
    specialistId,
    requestId: bound.requestId,
    contextId: bound.context.contextId,
    contextVersion: bound.contextVersion!,
    text: bound.text,
  });
}
