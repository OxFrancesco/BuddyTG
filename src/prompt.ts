import { Effect, Redacted, Schema } from "effect"

export class PromptError extends Schema.TaggedError<PromptError>()("PromptError", {
  message: Schema.String,
}) {}

/**
 * Read a line from stdin, optionally masking the input (for passwords).
 * Ctrl+C interrupts the program; interruption also restores the terminal.
 */
export const prompt = (question: string, opts?: { hidden?: boolean }) =>
  Effect.callback<string, PromptError>((resume) => {
    const stdin = process.stdin
    const hidden = opts?.hidden ?? false
    let buf = ""
    let done = false
    const restore = () => {
      if (done) return
      done = true
      stdin.setRawMode?.(false)
      stdin.pause()
      stdin.off("data", onData)
      stdin.off("end", onEnd)
    }
    const onEnd = () => {
      restore()
      resume(Effect.fail(new PromptError({ message: "stdin closed before an answer was entered" })))
    }
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\n" || c === "\r") {
          restore()
          process.stdout.write("\n")
          resume(Effect.succeed(buf))
          return
        } else if (c === "\u0003") {
          // Raw mode turns off the terminal's own Ctrl+C. Raise the real signal so
          // the whole program (and any nested prompt) is interrupted the usual way.
          restore()
          process.stdout.write("\n")
          process.kill(process.pid, "SIGINT")
          return
        } else if (c === "\u007f" || c === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1)
            if (!hidden) process.stdout.write("\b \b")
          }
        } else {
          buf += c
          process.stdout.write(hidden ? "*" : c)
        }
      }
    }
    process.stdout.write(question)
    stdin.setRawMode?.(true)
    stdin.setEncoding("utf8")
    stdin.on("data", onData)
    stdin.once("end", onEnd)
    stdin.resume()
    return Effect.sync(restore)
  })

export const promptSecret = (question: string) =>
  prompt(question, { hidden: true }).pipe(Effect.map(Redacted.make))
