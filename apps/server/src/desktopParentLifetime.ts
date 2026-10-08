// @effect-diagnostics nodeBuiltinImport:off
import * as NodeNet from "node:net";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

export class DesktopParentLifetimeError extends Schema.TaggedError<DesktopParentLifetimeError>()(
  "DesktopParentLifetimeError",
  { fd: Schema.Number, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Desktop ownership channel ${this.fd} failed.`;
  }
}

const openParentReader = (fd: number) =>
  Effect.try({
    try: () => {
      // The dedicated inherited pipe is not forwarded to provider children.
      // Socket uses a cancellable, nonblocking read even if the server exits first.
      const reader = new NodeNet.Socket({ fd, readable: true, writable: false });
      // Keep an error listener until close, including while server cleanup runs
      // after the waiter has completed or been interrupted.
      const ignoreLateError = () => {};
      reader.on("error", ignoreLateError);
      return { reader, ignoreLateError };
    },
    catch: (cause) => new DesktopParentLifetimeError({ fd, cause }),
  });

const awaitParentRelease = (fd: number, reader: NodeNet.Socket) =>
  Effect.suspend(() => {
    let removeListeners = () => {};
    return Effect.callback<void, DesktopParentLifetimeError>((resume) => {
      const onEnd = () => resume(Effect.void);
      const onError = (cause: Error) =>
        resume(Effect.fail(new DesktopParentLifetimeError({ fd, cause })));
      const onClose = () => onError(new Error("Ownership channel closed before EOF."));
      removeListeners = () => {
        reader.removeListener("end", onEnd);
        reader.removeListener("error", onError);
        reader.removeListener("close", onClose);
      };
      reader.once("end", onEnd);
      reader.on("error", onError);
      reader.once("close", onClose);
      if (reader.errored) onError(reader.errored);
      else if (reader.readableEnded) onEnd();
      else if (reader.destroyed) onError(new Error("Ownership channel is closed."));
      else reader.resume();
    }).pipe(Effect.ensuring(Effect.sync(() => removeListeners())));
  });

export const withDesktopParentLifetime = Effect.fn("withDesktopParentLifetime")(function* <A, E, R>(
  fd: number | undefined,
  server: Effect.Effect<A, E, R>,
): Effect.fn.Return<A | void, E | DesktopParentLifetimeError, R> {
  if (fd === undefined) return yield* server;
  const result = yield* Effect.acquireUseRelease(
    openParentReader(fd),
    ({ reader }) =>
      Effect.acquireUseRelease(
        server.pipe(Effect.interruptible, Effect.forkChild),
        (fiber) =>
          Effect.raceFirst(
            awaitParentRelease(fd, reader).pipe(Effect.as(Exit.void)),
            Fiber.await(fiber),
          ),
        (fiber) =>
          Effect.gen(function* () {
            // Own the actual server fiber independently of the race's joiner.
            // This release also runs after external interruption of the race.
            yield* Fiber.interrupt(fiber);
            const exit = yield* Fiber.await(fiber);
            if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
              return yield* Effect.failCause(exit.cause);
            }
          }),
      ),
    ({ reader, ignoreLateError }) =>
      Effect.callback<void>((resume) => {
        const closed = () => {
          reader.removeListener("error", ignoreLateError);
          resume(Effect.void);
        };
        if (reader.closed) closed();
        else {
          reader.once("close", closed);
          reader.destroy();
        }
      }),
  );
  return yield* result;
});
