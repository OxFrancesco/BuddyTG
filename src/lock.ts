/**
 * Single-instance lock for each bot token's getUpdates stream: Telegram allows
 * one update consumer per bot, and a second local one would steal answers.
 *
 * A lock is a file created with O_EXCL in the secrets directory, holding the
 * owner's PID. A lock whose PID no longer runs is stale and is taken over, so a
 * crashed or SIGKILLed process cannot block later runs. Within one process a
 * lock is reentrant.
 */
import { Effect, Predicate, Redacted, Schema } from "effect"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import { defaultSecretsDirectory, ensurePrivateDirectory } from "./keychain"

export class InstanceLockError extends Schema.TaggedError<InstanceLockError>()("InstanceLockError", {
  message: Schema.String,
}) {}

/** A lock file younger than this may still be waiting for its PID to be written. */
const FRESH_LOCK_MS = 5_000

const held = new Map<string, { count: number; ready: Promise<string> }>()

const errorCode = (error: unknown) =>
  Predicate.hasProperty(error, "code") ? error.code : undefined

export const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return errorCode(error) === "EPERM"
  }
}

const readOwner = async (path: string): Promise<{ pid: number | undefined; mtimeMs: number } | undefined> => {
  try {
    const stats = await lstat(path)
    if (!stats.isFile()) throw new InstanceLockError({ message: `refusing lock that is not a regular file: ${path}` })
    const text = await readFile(path, "utf8")
    const pid = Number(text.trim())
    return { pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined, mtimeMs: stats.mtimeMs }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined
    throw error
  }
}

const tryCreate = async (path: string) => {
  try {
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try {
      await handle.writeFile(`${process.pid}\n`, "utf8")
    } finally {
      await handle.close()
    }
    return true
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false
    throw error
  }
}

const acquire = async (directory: string, name: string, busy: string) => {
  await ensurePrivateDirectory(directory)
  const path = join(directory, `${name}.lock`)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await tryCreate(path)) return path
    const owner = await readOwner(path)
    if (owner === undefined) continue
    const live = owner.pid === undefined
      ? Date.now() - owner.mtimeMs < FRESH_LOCK_MS
      : owner.pid !== process.pid && isProcessAlive(owner.pid)
    if (live) {
      throw new InstanceLockError({
        message: `Another buddytg process${owner.pid === undefined ? "" : ` (pid ${owner.pid})`} is running: ${busy}. Wait for it to finish and try again.`,
      })
    }
    await unlink(path).catch((error) => {
      if (errorCode(error) !== "ENOENT") throw error
    })
  }
  throw new InstanceLockError({ message: `Could not acquire ${path}` })
}

const release = async (path: string) => {
  const owner = await readOwner(path).catch(() => undefined)
  if (owner?.pid === process.pid) await unlink(path).catch(() => {})
}

/**
 * Hold the named lock for the rest of the current scope.
 * Fails at once with InstanceLockError when another live process holds it.
 */
export const holdInstanceLock = (
  name: string,
  busy: string,
  directory?: string,
) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const dir = directory ?? defaultSecretsDirectory()
        const key = join(dir, `${name}.lock`)
        let entry = held.get(key)
        if (entry) {
          entry.count += 1
        } else {
          // Registered before the first await, so concurrent fibers share one acquisition.
          entry = { count: 1, ready: acquire(dir, name, busy) }
          held.set(key, entry)
        }
        try {
          await entry.ready
        } catch (error) {
          entry.count -= 1
          if (entry.count === 0 && held.get(key) === entry) held.delete(key)
          throw error
        }
        return key
      },
      catch: (error) =>
        error instanceof InstanceLockError
          ? error
          : new InstanceLockError({ message: `Could not acquire the buddytg lock: ${error instanceof Error ? error.message : String(error)}` }),
    }),
    (key) =>
      Effect.promise(async () => {
        const entry = held.get(key)
        if (!entry) return
        entry.count -= 1
        if (entry.count > 0) return
        held.delete(key)
        await release(key)
      }),
  )

/** One lock per bot token. The name is a hash, so the token never reaches the filesystem. */
export const botUpdatesLockName = (token: Redacted.Redacted<string>) =>
  `bot-${createHash("sha256").update(Redacted.value(token)).digest("hex").slice(0, 16)}`

export const holdBotUpdatesLock = (token: Redacted.Redacted<string>) =>
  holdInstanceLock(botUpdatesLockName(token), "it is already waiting for a Telegram answer from this bot")
