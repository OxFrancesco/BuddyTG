import { Cause, Console, Effect, Runtime } from "effect"
import { escapeTerminalText } from "./file-transfer"

/**
 * Process entrypoint on the stable `Runtime.makeRunMain`.
 * SIGINT/SIGTERM interrupt the main fiber so finalizers run (client shutdown,
 * keyboard cleanup, temp-file removal); a second signal exits at once.
 * The process always exits explicitly, because mtcute can leave handles open.
 */
const runMainWithSignals = Runtime.makeRunMain(({ fiber, teardown }) => {
  let received: NodeJS.Signals | undefined
  // 128 + signal number: 130 for SIGINT, 143 for SIGTERM.
  const signalExit = () => (received === "SIGTERM" ? 143 : 130)
  const onSignal = (signal: NodeJS.Signals) => {
    if (received) process.exit(signalExit())
    received = signal
    fiber.interruptUnsafe(fiber.id)
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  fiber.addObserver((exit) => {
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    teardown(exit, (code) => process.exit(received && code === 130 ? signalExit() : code))
  })
})

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Failures print one `Error: …` line to stderr. stdout stays a data channel:
 * hook decisions, MCP JSON-RPC and pi tool output read it.
 */
const reportFailure = (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.void
    : Console.error(`Error: ${messageOf(Cause.squash(cause)).split("\n").map(escapeTerminalText).join("\n")}`)

export const runMain = <A, E>(program: Effect.Effect<A, E>) =>
  runMainWithSignals(program.pipe(Effect.tapCause(reportFailure)), { disableErrorReporting: true })
