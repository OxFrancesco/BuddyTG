/**
 * Secret storage for BuddyTG credentials and sessions.
 *
 * macOS uses the Keychain via the `security` CLI when it is available.
 * Linux (and any host without Keychain) uses a private user-level directory:
 * `$XDG_CONFIG_HOME/buddytg/secrets` or `~/.config/buddytg/secrets`.
 * Environment variables still override stored values at the call sites.
 */
import { Context, Effect, Layer, Predicate, Redacted, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { tryPromiseSettled } from "./settled"

const SERVICE = "buddytg"
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const SECURITY = "/usr/bin/security"
const MAX_SECRET_BYTES = 64 * 1024
const MAX_SECURITY_LINE_BYTES = 4_000
/** `security` exits 44 (errSecItemNotFound) for a missing item. */
const ITEM_NOT_FOUND = 44

export class KeychainError extends Schema.TaggedError<KeychainError>()("KeychainError", {
  message: Schema.String,
}) {}

export interface KeychainService {
  readonly get: (account: string) => Effect.Effect<Redacted.Redacted<string> | null, KeychainError>
  readonly set: (account: string, value: Redacted.Redacted<string>) => Effect.Effect<void, KeychainError>
  readonly delete: (account: string) => Effect.Effect<void, KeychainError>
}

const isNotFound = (error: unknown) => Predicate.hasProperty(error, "code") && error.code === "ENOENT"

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
    options && "securityPath" in options ? options.securityPath : Bun.which(SECURITY)
  const secretsDir =
    options && "secretsDir" in options ? options.secretsDir : process.env.BUDDYTG_SECRETS_DIR
  if (secretsDir?.trim()) return false
  return platform === "darwin" && Boolean(securityPath)
}

const assertAccount = (account: string) => {
  if (!ACCOUNT_PATTERN.test(account)) {
    throw new KeychainError({ message: "invalid secret account name" })
  }
}

const currentUid = () => process.getuid?.()

/** Another account must not be able to plant or swap secrets: owner-only, not group/other-writable. */
const assertPrivate = (stats: { uid: number; mode: number }, what: string) => {
  const uid = currentUid()
  if (uid !== undefined && stats.uid !== uid) {
    throw new KeychainError({ message: `refusing ${what} owned by another user` })
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new KeychainError({ message: `refusing ${what} writable by group or others` })
  }
}

export const ensurePrivateDirectory = async (directory: string) => {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stats = await lstat(directory)
  if (!stats.isDirectory()) {
    throw new KeychainError({ message: "secret directory is not a directory" })
  }
  const uid = currentUid()
  if (uid !== undefined && stats.uid !== uid) {
    throw new KeychainError({ message: "refusing secret directory owned by another user" })
  }
  await chmod(directory, 0o700)
}

const secretPath = (directory: string, account: string) => {
  assertAccount(account)
  return join(directory, account)
}

const asKeychainError = (fallback: string, error: unknown) =>
  error instanceof KeychainError ? error : new KeychainError({ message: `${fallback}: ${error}` })

const readPrivateFile = async (directory: string, path: string) => {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (isNotFound(error)) return null
    if (Predicate.hasProperty(error, "code") && error.code === "ELOOP") {
      throw new KeychainError({ message: "refusing to read secret through a symbolic link" })
    }
    throw error
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new KeychainError({ message: "secret is not a regular file" })
    assertPrivate(stats, "secret file")
    assertPrivate(await lstat(directory), "secret directory")
    if (stats.size > MAX_SECRET_BYTES) throw new KeychainError({ message: "secret file is too large" })
    return await handle.readFile("utf8")
  } finally {
    await handle.close().catch(() => {})
  }
}

export const makeFileKeychain = (directory: string | (() => string)): KeychainService => {
  const dirOf = () => (typeof directory === "string" ? directory : directory())

  return {
    get: (account) =>
      Effect.tryPromise({
        try: async () => {
          const directory = dirOf()
          const value = await readPrivateFile(directory, secretPath(directory, account))
          return value === null ? null : Redacted.make(value)
        },
        catch: (error) => asKeychainError("failed to read secret", error),
      }),
    set: (account, value) =>
      tryPromiseSettled({
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

const runSecurity = (args: ReadonlyArray<string>, stdin?: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const proc = Bun.spawn([SECURITY, ...args], {
        stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
        signal,
      })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { out, err, code }
    },
    catch: () => new KeychainError({ message: "failed to invoke the macOS security tool" }),
  })

const checkAccount = (account: string) =>
  Effect.try({ try: () => assertAccount(account), catch: (error) => asKeychainError("invalid secret account name", error) })

/** Quoting for one argument of a `security -i` command line. */
const securityQuote = (value: string) => `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`

export const makeMacOSKeychain = (): KeychainService => ({
  get: (account) =>
    checkAccount(account).pipe(
      Effect.andThen(runSecurity(["find-generic-password", "-s", SERVICE, "-a", account, "-w"])),
      Effect.flatMap(({ out, code }) => {
        if (code === ITEM_NOT_FOUND) return Effect.succeed(null)
        if (code !== 0) {
          return Effect.fail(new KeychainError({ message: `Keychain read failed (security exit ${code})` }))
        }
        return Effect.succeed(Redacted.make(out.trimEnd()))
      }),
    ),
  // The secret goes over stdin (`security -i`), never argv, where `ps` would show it.
  set: (account, value) =>
    checkAccount(account).pipe(
      Effect.andThen(() => {
        const secret = Redacted.value(value)
        if (/[\u0000-\u001f\u007f]/.test(secret)) {
          return Effect.fail(new KeychainError({ message: "secret contains control characters" }))
        }
        const line = `add-generic-password -U -s ${SERVICE} -a ${account} -w ${securityQuote(secret)}\n`
        // `security -i` splits input lines at 4095 bytes and runs the rest as another command.
        if (Buffer.byteLength(line) > MAX_SECURITY_LINE_BYTES) {
          return Effect.fail(new KeychainError({ message: "secret is too long for the macOS Keychain helper" }))
        }
        return runSecurity(["-i"], line)
      }),
      Effect.flatMap(({ code, err }) =>
        code === 0 && !err.trim()
          ? Effect.void
          : Effect.fail(new KeychainError({ message: `Keychain write failed (security exit ${code})` })),
      ),
    ),
  delete: (account) =>
    checkAccount(account).pipe(
      Effect.andThen(runSecurity(["delete-generic-password", "-s", SERVICE, "-a", account])),
      Effect.flatMap(({ code }) =>
        code === 0 || code === ITEM_NOT_FOUND
          ? Effect.void
          : Effect.fail(new KeychainError({ message: `Keychain delete failed (security exit ${code})` })),
      ),
    ),
})

export class Keychain extends Context.Service<Keychain, KeychainService>()("buddytg/Keychain") {
  /** File store in a fixed directory, for tests and explicit overrides. */
  static readonly layerFile = (directory: string | (() => string)) =>
    Layer.succeed(Keychain, makeFileKeychain(directory))

  /** macOS Keychain when available, otherwise the private file store. */
  static readonly layer = Layer.sync(Keychain, () =>
    usesMacOSKeychain() ? makeMacOSKeychain() : makeFileKeychain(defaultSecretsDirectory),
  )
}
