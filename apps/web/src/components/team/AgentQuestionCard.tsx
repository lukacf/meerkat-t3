import type { MeerkatPendingQuestion, MeerkatQuestionAnswerInput } from "@t3tools/contracts";
import { MessageCircleQuestionIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import {
  createNativeQuestionDraft,
  nativeQuestionDraftKey,
  type NativeQuestionDraftScope,
} from "./nativeQuestionDraftStore";

type AgentQuestionCardProps = {
  request: MeerkatPendingQuestion;
  draftScope: NativeQuestionDraftScope;
  disabledReason?: string | null;
  onAnswer: (
    answers: MeerkatQuestionAnswerInput["answers"],
    dismissed: boolean,
  ) => Promise<string | null>;
};

export function AgentQuestionCard(props: AgentQuestionCardProps) {
  return (
    <QuestionController key={nativeQuestionDraftKey(props.draftScope, props.request)} {...props} />
  );
}

function QuestionController({
  request,
  draftScope,
  onAnswer,
  disabledReason,
}: AgentQuestionCardProps) {
  const [store] = useState(() => createNativeQuestionDraft(draftScope, request));
  const [draft, setDraft] = useState(store.getSnapshot);
  const answers = draft.answers;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<MeerkatQuestionAnswerInput["answers"] | null>(null);
  const [cleanupFailed, setCleanupFailed] = useState(false);
  const confirmedResponse = useRef<MeerkatQuestionAnswerInput["answers"] | null>(null);
  const inFlight = useRef(false);
  const active = useRef(false);
  const currentDisabledReason = useRef(disabledReason);
  useLayoutEffect(() => {
    currentDisabledReason.current = disabledReason;
  }, [disabledReason]);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const setAnswers = (
    change: (
      previous: MeerkatQuestionAnswerInput["answers"],
    ) => MeerkatQuestionAnswerInput["answers"],
  ) => {
    if (!active.current || inFlight.current || confirmedResponse.current) return;
    setDraft(store.update(change));
  };
  const changeLocalDraft = (action: "retrySave" | "reload" | "discard") => {
    if (!active.current || inFlight.current || confirmedResponse.current) return;
    setDraft(store[action]());
  };
  const submit = async (dismissed: boolean) => {
    if (!active.current || confirmedResponse.current) return;
    if (currentDisabledReason.current) {
      setError(currentDisabledReason.current);
      return;
    }
    if (inFlight.current) return;
    const submitted = store.getSnapshot().answers;
    if (
      !dismissed &&
      submitted.some((answer) => !answer.selectedOptionIds.length && !answer.customText.trim())
    )
      return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const failure = await onAnswer(submitted, dismissed);
      const cleared = failure ? null : store.clearConfirmed(submitted);
      if (!active.current) return;
      setError(
        failure ??
          (cleared === "unavailable"
            ? "Answers were accepted, but the saved draft could not be cleared. Retry clearing it."
            : cleared === "changed"
              ? "Answers were accepted. A newer draft in another view was kept."
              : null),
      );
      if (!failure) {
        confirmedResponse.current = submitted;
        setConfirmed(submitted);
        setCleanupFailed(cleared === "unavailable");
        if (cleared === "cleared") setOpen(false);
      }
    } catch (cause) {
      if (!active.current) return;
      setError(
        cause instanceof Error ? cause.message : "Unable to send answers. Please try again.",
      );
    } finally {
      inFlight.current = false;
      if (active.current) setPending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="flex min-w-0 items-center gap-3 rounded-lg border border-primary/20 bg-card px-3 py-2">
        <MessageCircleQuestionIcon className="size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{request.title}</p>
          <p className="text-xs text-muted-foreground">
            {request.questions.length === 1
              ? "Your answer is needed"
              : `${request.questions.length} questions need your input`}
          </p>
        </div>
        <DialogTrigger render={<Button size="sm" variant="outline" />}>
          Answer question
        </DialogTrigger>
      </div>
      <DialogPopup
        className="max-h-[min(85dvh,720px)] max-w-xl"
        render={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit(false);
            }}
          />
        }
      >
        <DialogHeader>
          <div className="pr-4">
            <DialogTitle>{request.title}</DialogTitle>
          </div>
          <DialogDescription>
            Review the questions and send your answers together.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {request.questions.map((question, index) => (
            <fieldset
              key={question.id}
              disabled={pending || confirmed !== null}
              className="space-y-2"
            >
              <legend className="mb-2 text-sm">{question.question}</legend>
              {question.options.map((option) => (
                <label
                  key={option.id}
                  className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm"
                >
                  <input
                    type={question.multiSelect ? "checkbox" : "radio"}
                    name={`${request.requestId}:${question.id}`}
                    checked={answers[index]!.selectedOptionIds.includes(option.id)}
                    onChange={(event) =>
                      setAnswers((previous) =>
                        previous.map((answer, i) =>
                          i !== index
                            ? answer
                            : {
                                ...answer,
                                selectedOptionIds: question.multiSelect
                                  ? event.target.checked
                                    ? answer.selectedOptionIds.includes(option.id)
                                      ? answer.selectedOptionIds
                                      : [...answer.selectedOptionIds, option.id]
                                    : answer.selectedOptionIds.filter((id) => id !== option.id)
                                  : [option.id],
                              },
                        ),
                      )
                    }
                  />
                  <span>
                    <span className="font-medium">{option.label}</span>
                    {option.description && (
                      <span className="block text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                </label>
              ))}
              {question.allowCustom && (
                <Textarea
                  aria-label={`Your answer: ${question.question}`}
                  placeholder={question.options.length ? "Or write your own answer" : "Your answer"}
                  value={answers[index]!.customText}
                  maxLength={16000}
                  onChange={(event) =>
                    setAnswers((previous) =>
                      previous.map((answer, i) =>
                        i !== index ? answer : { ...answer, customText: event.target.value },
                      ),
                    )
                  }
                />
              )}
            </fieldset>
          ))}
        </DialogPanel>
        <DialogFooter className="shrink-0 flex-col sm:flex-col">
          {!confirmed && draft.error ? (
            <div className="space-y-2">
              <p role="alert" className="text-xs text-destructive">
                {draft.error}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => changeLocalDraft("retrySave")}
                >
                  Retry saving
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => changeLocalDraft("reload")}
                >
                  Reload saved answers
                </Button>
              </div>
            </div>
          ) : !confirmed && draft.saved ? (
            <p role="status" className="text-xs text-muted-foreground">
              Draft saved on this device.
            </p>
          ) : null}
          {disabledReason ? (
            <p role="status" className="text-xs text-muted-foreground">
              {disabledReason}
            </p>
          ) : null}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          {confirmed ? (
            <p role="status" className="text-xs text-muted-foreground">
              Response accepted by the agent.
            </p>
          ) : null}
          {confirmed && cleanupFailed ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                if (!active.current) return;
                const result = store.clearConfirmed(confirmed);
                setCleanupFailed(result === "unavailable");
                setError(
                  result === "unavailable"
                    ? "The saved draft could not be cleared. Your confirmed answer will not be sent again."
                    : result === "changed"
                      ? "A newer draft in another view was kept."
                      : null,
                );
                if (result === "cleared") setOpen(false);
              }}
            >
              Retry clearing saved draft
            </Button>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={
                pending ||
                confirmed !== null ||
                Boolean(disabledReason) ||
                answers.some(
                  (answer) => !answer.selectedOptionIds.length && !answer.customText.trim(),
                )
              }
            >
              {pending ? "Sending..." : "Send answers"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending || confirmed !== null || Boolean(disabledReason)}
              onClick={() => void submit(true)}
            >
              Dismiss
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending || confirmed !== null}
              onClick={() => changeLocalDraft("discard")}
            >
              Discard draft
            </Button>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
