/**
 * Secret storage for BuddyTG credentials and sessions.
 *
 * macOS uses the Keychain via the `security` CLI when it is available.
 * Linux (and any host without Keychain) uses a private user-level directory:
 * `$XDG_CONFIG_HOME/buddytg/secrets` or `~/.config/buddytg/secrets`.
 * Environment variables still override stored values at the call sites.
 */
import { Context, Effect, Layer, Redacted } from "effect"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

const SERVICE = "buddytg"
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/

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

export type KeychainService = Context.Tag.Service<typeof Keychain>

const isNotFound = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

const resolveUserPath = (path: string) =>
  isAbsolute(path) ? resolve(path) : resolve(homedir(), path)

export type SecretStoreEnv = {
  readonly BUDDYTG_SECRETS_DIR?: string
  readonly XDG_CONFIG_HOME?: string
}

/** Directory used by the file-backed store. Never resolved against the process cwd. */
export const defaultSecretsDirectory = (
  env: SecretStoreEnv = {
    BUDDYTG_SECRETS_DIR: process.env.BUDDYTG_SECRETS_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  },
): string => {
  const override = env.BUDDYTG_SECRETS_DIR?.trim()
  if (override) return resolveUserPath(override)
  const xdg = env.XDG_CONFIG_HOME?.trim()
  const base = xdg ? resolveUserPath(xdg) : join(homedir(), ".config")
  return join(base, "buddytg", "secrets")
}

export const usesMacOSKeychain = (options?: {
  readonly platform?: string
  readonly securityPath?: string | null
  readonly secretsDir?: string | undefined
}): boolean => {
  const platform = options?.platform ?? process.platform
  const securityPath =
    options && "securityPath" in options ? options.securityPath : Bun.which("security")
  const secretsDir =
    options && "secretsDir" in options ? options.secretsDir : process.env.BUDDYTG_SECRETS_DIR
  if (secretsDir?.trim()) return false
  return platform === "darwin" && Boolean(securityPath)
}

const assertAccount = (account: string) => {
  if (!ACCOUNT_PATTERN.test(account)) {
    throw new KeychainError("invalid secret account name")
  }
}

const ensurePrivateDirectory = async (directory: string) => {
  await mkdir(directory, { recursive: true })
  await chmod(directory, 0o700)
}

const secretPath = (directory: string, account: string) => {
  assertAccount(account)
  return join(directory, account)
}

const asKeychainError = (fallback: string, error: unknown) =>
  error instanceof KeychainError ? error : new KeychainError(`${fallback}: ${error}`)

export const makeFileKeychain = (directory: string | (() => string)): KeychainService => {
  const dirOf = () => (typeof directory === "string" ? directory : directory())

  return {
    get: (account) =>
      Effect.tryPromise({
        try: async () => {
          const path = secretPath(dirOf(), account)
          try {
            const stats = await lstat(path)
            if (stats.isSymbolicLink()) {
              throw new KeychainError("refusing to read secret through a symbolic link")
            }
            return Redacted.make(await readFile(path, "utf8"))
          } catch (error) {
            if (isNotFound(error)) return null
            throw error
          }
        },
        catch: (error) => asKeychainError("failed to read secret", error),
      }),
    set: (account, value) =>
      Effect.tryPromise({
        try: async () => {
          const directory = dirOf()
          const path = secretPath(directory, account)
          await ensurePrivateDirectory(directory)
          const temporary = join(directory, `.${account}.${randomUUID()}.tmp`)
          const handle = await open(
            temporary,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600,
          )
          try {
            await handle.writeFile(Redacted.value(value), "utf8")
            await handle.sync()
            await handle.chmod(0o600)
          } catch (error) {
            await handle.close().catch(() => {})
            await unlink(temporary).catch(() => {})
            throw error
          }
          await handle.close()
          try {
            await rename(temporary, path)
            await chmod(path, 0o600)
          } catch (error) {
            await unlink(temporary).catch(() => {})
            throw error
          }
        },
        catch: (error) => asKeychainError("failed to write secret", error),
      }),
    delete: (account) =>
      Effect.tryPromise({
        try: async () => {
          try {
            await unlink(secretPath(dirOf(), account))
          } catch (error) {
            if (!isNotFound(error)) throw error
          }
        },
        catch: (error) => asKeychainError("failed to delete secret", error),
      }),
  }
}

const runSecurity = (args: string[], stdin?: string) =>
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

export const makeMacOSKeychain = (): KeychainService => ({
  get: (account) =>
    runSecurity(["find-generic-password", "-s", SERVICE, "-a", account, "-w"]).pipe(
      Effect.flatMap(({ out, code }) =>
        code === 0 ? Effect.succeed(Redacted.make(out.trimEnd())) : Effect.succeed(null),
      ),
    ),
  set: (account, value) =>
    runSecurity([
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
    runSecurity(["delete-generic-password", "-s", SERVICE, "-a", account]).pipe(
      Effect.asVoid,
    ),
})

const macOSKeychain = makeMacOSKeychain()
const fileKeychain = makeFileKeychain(defaultSecretsDirectory)

const liveBackend = () => (usesMacOSKeychain() ? macOSKeychain : fileKeychain)

export const KeychainLive = Layer.succeed(Keychain, {
  get: (account) => Effect.suspend(() => liveBackend().get(account)),
  set: (account, value) => Effect.suspend(() => liveBackend().set(account, value)),
  delete: (account) => Effect.suspend(() => liveBackend().delete(account)),
})
