import { Effect, Redacted } from "effect"

export class PromptError extends Error {
  readonly _tag = "PromptError"
}

/** Read a line from stdin, optionally masking the input (for passwords). */
export const prompt = (question: string, opts?: { hidden?: boolean }) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        process.stdout.write(question)
        const stdin = process.stdin
        const hidden = opts?.hidden ?? false
        let buf = ""
        stdin.setRawMode?.(true)
        stdin.resume()
        stdin.setEncoding("utf8")
        const onData = (ch: string) => {
          for (const c of ch) {
            if (c === "\n" || c === "\r") {
              stdin.setRawMode?.(false)
              stdin.pause()
              stdin.off("data", onData)
              process.stdout.write("\n")
              resolve(buf)
              return
            } else if (c === "\u0003") {
              stdin.setRawMode?.(false)
              stdin.pause()
              stdin.off("data", onData)
              process.stdout.write("\n")
              reject(new PromptError("interrupted"))
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
        stdin.on("data", onData)
      }),
    catch: (e) => (e instanceof PromptError ? e : new PromptError(String(e))),
  })

export const promptSecret = (question: string) =>
  prompt(question, { hidden: true }).pipe(Effect.map(Redacted.make))
