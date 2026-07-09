import { Context, Effect, Layer, Redacted } from "effect"

const SERVICE = "buddytg"

export class KeychainError extends Error {
  readonly _tag = "KeychainError"
}

export class Keychain extends Context.Tag("Keychain")<
  Keychain,
  {
    readonly get: (account: string) => Effect.Effect<Redacted.Redacted<string> | null, KeychainError>
    readonly set: (account: string, value: Redacted.Redacted<string>) => Effect.Effect<void, KeychainError>
    readonly delete: (account: string) => Effect.Effect<void, KeychainError>
  }
>() {}

const run = (args: string[], stdin?: string) =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["security", ...args], {
        stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : undefined,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { out, err, code }
    },
    catch: (e) => new KeychainError(`failed to invoke security: ${e}`),
  })

export const KeychainLive = Layer.succeed(Keychain, {
  get: (account) =>
    run(["find-generic-password", "-s", SERVICE, "-a", account, "-w"]).pipe(
      Effect.flatMap(({ out, code }) =>
        code === 0
          ? Effect.succeed(Redacted.make(out.trimEnd()))
          : Effect.succeed(null),
      ),
    ),
  set: (account, value) =>
    run([
      "add-generic-password",
      "-U", // update if exists
      "-s",
      SERVICE,
      "-a",
      account,
      "-w",
      Redacted.value(value),
    ]).pipe(
      Effect.flatMap(({ code, err }) =>
        code === 0
          ? Effect.void
          : Effect.fail(new KeychainError(`keychain write failed: ${err.trim()}`)),
      ),
    ),
  delete: (account) =>
    run(["delete-generic-password", "-s", SERVICE, "-a", account]).pipe(
      Effect.asVoid,
    ),
})
