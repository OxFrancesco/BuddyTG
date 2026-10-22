import { Effect } from "effect"

/**
 * Like `Effect.tryPromise`, but interruption waits for the promise to settle
 * (bounded), so the operation's own `finally` cleanup, such as removing a
 * partial temporary file, finishes before the process exits.
 */
export const tryPromiseSettled = <A, E>(options: {
  readonly try: (signal: AbortSignal) => Promise<A>
  readonly catch: (error: unknown) => E
  readonly settleTimeoutMs?: number
}) =>
  Effect.callback<A, E>((resume) => {
    const controller = new AbortController()
    let settled: Promise<unknown>
    try {
      settled = options.try(controller.signal).then(
        (value) => resume(Effect.succeed(value)),
        (error) => resume(Effect.fail(options.catch(error))),
      )
    } catch (error) {
      resume(Effect.fail(options.catch(error)))
      return
    }
    return Effect.promise(() => {
      controller.abort()
      return Promise.race([settled, Bun.sleep(options.settleTimeoutMs ?? 10_000)])
    })
  })

/** Bound a cleanup promise so a stuck close cannot block shutdown. */
export const boundedCleanup = (cleanup: () => Promise<unknown>, timeoutMs = 5_000) =>
  Effect.promise(() => Promise.race([cleanup().catch(() => {}), Bun.sleep(timeoutMs)]))
