import {
  MeerkatQuestionAnswerInput,
  type EnvironmentId,
  type MeerkatPendingQuestion,
  type ProjectId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { browserAgentDraftStorage, type AgentDraftStorage } from "./agentDraftStorage";

export type NativeQuestionDraftScope = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  instanceId: ProviderInstanceId;
};
type Answers = MeerkatQuestionAnswerInput["answers"];
const StoredDraft = Schema.Struct({
  version: Schema.Literal(1),
  answers: MeerkatQuestionAnswerInput.fields.answers,
});
const decode = Schema.decodeUnknownSync(StoredDraft);
const emptyAnswers = (request: MeerkatPendingQuestion): Answers =>
  request.questions.map((question) => ({
    questionId: question.id,
    selectedOptionIds: [],
    customText: "",
  }));

/** Exact structural content is the fingerprint, so schema changes cannot collide or reuse answers. */
export function nativeQuestionDraftKey(
  scope: NativeQuestionDraftScope,
  request: MeerkatPendingQuestion,
) {
  return `t3code:meerkat-question-draft:v1:${JSON.stringify([
    scope.environmentId,
    scope.projectId,
    scope.instanceId,
    request.mobId,
    request.sessionId,
    request.requestId,
    request.toolCallId,
    request.createdAt,
    request.title,
    request.questions.map((question) => [
      question.id,
      question.question,
      question.multiSelect,
      question.allowCustom,
      question.options.map((option) => [option.id, option.label, option.description]),
    ]),
  ])}`;
}

export type NativeQuestionDraftSnapshot = {
  answers: Answers;
  saved: boolean;
  error: string | null;
};

/** Stores only local form state. A recovered draft never submits or determines native question state. */
export function createNativeQuestionDraft(
  scope: NativeQuestionDraftScope,
  request: MeerkatPendingQuestion,
  storage: () => AgentDraftStorage | undefined = () => browserAgentDraftStorage("localStorage"),
) {
  const key = nativeQuestionDraftKey(scope, request);
  let lastStored: string | null | undefined;
  let snapshot: NativeQuestionDraftSnapshot = {
    answers: emptyAnswers(request),
    saved: false,
    error: null,
  };
  const read = () => {
    const target = storage();
    if (!target) throw new Error("Local storage unavailable");
    return { target, raw: target.getItem(key) };
  };
  const readAnswers = (raw: string | null): Answers => {
    if (raw === null) return emptyAnswers(request);
    const answers = decode(JSON.parse(raw)).answers;
    if (
      answers.length !== request.questions.length ||
      answers.some((answer, index) => {
        const question = request.questions[index]!;
        return (
          answer.questionId !== question.id ||
          (!question.allowCustom && answer.customText !== "") ||
          (!question.multiSelect && answer.selectedOptionIds.length > 1) ||
          new Set(answer.selectedOptionIds).size !== answer.selectedOptionIds.length ||
          answer.selectedOptionIds.some(
            (id) => !question.options.some((option) => option.id === id),
          )
        );
      })
    )
      throw new Error("Saved answers do not match the question");
    return answers;
  };
  try {
    const { raw } = read();
    snapshot = { answers: readAnswers(raw), saved: raw !== null, error: null };
    lastStored = raw;
  } catch {
    snapshot.error =
      "Saved answers could not be read. Edits stay in this view until they can be saved.";
  }
  const save = () => {
    const serialized = JSON.stringify({ version: 1, answers: snapshot.answers });
    try {
      const { target, raw } = read();
      if (raw !== serialized && raw !== lastStored && !(lastStored === undefined && raw === null)) {
        snapshot = {
          ...snapshot,
          saved: false,
          error:
            "The saved draft changed in another view or could not be read. Your edits are still here. Reload saved answers or discard the draft before replacing it.",
        };
        return snapshot;
      }
      target.setItem(key, serialized);
      if (target.getItem(key) !== serialized) throw new Error("Draft write was not confirmed");
      lastStored = serialized;
      snapshot = { ...snapshot, saved: true, error: null };
    } catch {
      snapshot = {
        ...snapshot,
        saved: false,
        error:
          "Answers are only in this view. This device could not save them; keep this view open and retry saving.",
      };
    }
    return snapshot;
  };
  const remove = (target: AgentDraftStorage) => {
    if (!target.removeItem) throw new Error("Draft removal unavailable");
    target.removeItem(key);
    if (target.getItem(key) !== null) throw new Error("Draft removal was not confirmed");
    lastStored = null;
  };
  return {
    key,
    getSnapshot: () => snapshot,
    update: (change: (answers: Answers) => Answers) => {
      snapshot = { ...snapshot, answers: change(snapshot.answers) };
      return save();
    },
    retrySave: save,
    reload: () => {
      try {
        const { raw } = read();
        const answers = readAnswers(raw);
        lastStored = raw;
        snapshot = { answers, saved: raw !== null, error: null };
      } catch {
        snapshot = {
          ...snapshot,
          error: "Saved answers could not be read. Your edits are still here.",
        };
      }
      return snapshot;
    },
    discard: () => {
      try {
        const { target } = read();
        remove(target);
        snapshot = { answers: emptyAnswers(request), saved: false, error: null };
      } catch {
        snapshot = {
          ...snapshot,
          error: "The saved draft could not be discarded. Your answers have been kept.",
        };
      }
      return snapshot;
    },
    clearConfirmed: (submitted: Answers) => {
      try {
        const { target, raw } = read();
        // A response from an earlier mount cannot erase newer edits in another view.
        if (raw !== null && JSON.stringify(readAnswers(raw)) !== JSON.stringify(submitted)) {
          return "changed" as const;
        }
        remove(target);
        return "cleared" as const;
      } catch {
        return "unavailable" as const;
      }
    },
  };
}
