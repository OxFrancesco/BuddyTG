/**
 * Tests for BuddyTG secret storage: Linux file backend, permissions, and
 * macOS Keychain selection. Uses fake values only; no live Telegram.
 */
import { expect, test } from "bun:test"
import { Effect, Layer, Redacted } from "effect"
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import {
  defaultSecretsDirectory,
  Keychain,
  makeFileKeychain,
  usesMacOSKeychain,
} from "./keychain"

const ACCOUNTS = ["api-id", "api-hash", "session", "bot-token", "chat-id"] as const

const isInside = (root: string, path: string) => {
  const rel = relative(resolve(root), resolve(path))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const withTempDirectory = async (run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "buddytg-secrets-test-"))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const runStore = <A, E>(
  directory: string,
  effect: Effect.Effect<A, E, Keychain>,
) => Effect.runPromise(effect.pipe(Effect.provide(Layer.succeed(Keychain, makeFileKeychain(directory)))))

test("selects macOS Keychain only on darwin when security is available", () => {
  expect(
    usesMacOSKeychain({
      platform: "darwin",
      securityPath: "/usr/bin/security",
      secretsDir: undefined,
    }),
  ).toBe(true)
  expect(
    usesMacOSKeychain({
      platform: "darwin",
      securityPath: null,
      secretsDir: undefined,
    }),
  ).toBe(false)
  expect(
    usesMacOSKeychain({
      platform: "linux",
      securityPath: "/usr/bin/security",
      secretsDir: undefined,
    }),
  ).toBe(false)
  expect(
    usesMacOSKeychain({
      platform: "darwin",
      securityPath: "/usr/bin/security",
      secretsDir: "/private/buddytg-secrets",
    }),
  ).toBe(false)
})

test("this Linux host uses the file-backed store, not Keychain", () => {
  if (process.platform === "darwin") return
  expect(usesMacOSKeychain()).toBe(false)
})

test("default secrets directory is a private user path, never the repo", () => {
  const repo = resolve(import.meta.dir, "..")
  const fallback = defaultSecretsDirectory({
    BUDDYTG_SECRETS_DIR: "",
    XDG_CONFIG_HOME: "",
  })
  expect(fallback).toBe(join(homedir(), ".config", "buddytg", "secrets"))
  expect(isInside(repo, fallback)).toBe(false)

  expect(
    defaultSecretsDirectory({
      XDG_CONFIG_HOME: "/var/tmp/xdg-config",
    }),
  ).toBe("/var/tmp/xdg-config/buddytg/secrets")

  const relativeOverride = defaultSecretsDirectory({
    BUDDYTG_SECRETS_DIR: "relative-secrets",
  })
  expect(relativeOverride).toBe(resolve(homedir(), "relative-secrets"))
  expect(isInside(repo, relativeOverride)).toBe(false)
  expect(relativeOverride.startsWith(homedir())).toBe(true)
})

test("file store round-trips credentials and session strings with private permissions", async () => {
  await withTempDirectory(async (directory) => {
    const values = {
      "api-id": "123456",
      "api-hash": "0123456789abcdef0123456789abcdef",
      session: "1,fake-mtcute-session-export",
      "bot-token": "000000:fake-bot-token",
      "chat-id": "123456789",
    } as const

    await chmod(directory, 0o755)
    await runStore(
      directory,
      Effect.gen(function* () {
        const store = yield* Keychain
        for (const account of ACCOUNTS) {
          yield* store.set(account, Redacted.make(values[account]))
        }
      }),
    )

    const loaded = await runStore(
      directory,
      Effect.gen(function* () {
        const store = yield* Keychain
        const entries: Record<string, string | null> = {}
        for (const account of ACCOUNTS) {
          const value = yield* store.get(account)
          entries[account] = value ? Redacted.value(value) : null
        }
        return entries
      }),
    )

    expect(loaded).toEqual({ ...values })

    const dirMode = (await lstat(directory)).mode & 0o777
    expect(dirMode).toBe(0o700)
    for (const account of ACCOUNTS) {
      const stats = await lstat(join(directory, account))
      expect(stats.isFile()).toBe(true)
      expect(stats.mode & 0o777).toBe(0o600)
    }

    const repo = resolve(import.meta.dir, "..")
    expect(isInside(repo, directory)).toBe(false)
  })
})

test("file store overwrites, returns null for missing accounts, and delete is idempotent", async () => {
  await withTempDirectory(async (directory) => {
    await runStore(
      directory,
      Effect.gen(function* () {
        const store = yield* Keychain
        yield* store.set("session", Redacted.make("first"))
        yield* store.set("session", Redacted.make("second"))
        const updated = yield* store.get("session")
        expect(Redacted.value(updated!)).toBe("second")
        yield* store.delete("session")
        expect(yield* store.get("session")).toBeNull()
        yield* store.delete("session")
        expect(yield* store.get("api-id")).toBeNull()
      }),
    )
  })
})

test("file store rejects path-traversal account names", async () => {
  await withTempDirectory(async (directory) => {
    const result = await runStore(
      directory,
      Effect.gen(function* () {
        const store = yield* Keychain
        return yield* store.set("../session", Redacted.make("nope"))
      }),
    ).then(
      () => "ok" as const,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(result).toContain("invalid secret account name")
  })
})

test("file store refuses to follow a symlink secret path", async () => {
  await withTempDirectory(async (directory) => {
    const outside = join(directory, "outside")
    await writeFile(outside, "leaked", { mode: 0o600 })
    await symlink(outside, join(directory, "session"))
    const result = await runStore(
      directory,
      Effect.gen(function* () {
        const store = yield* Keychain
        return yield* store.get("session")
      }),
    ).then(
      () => "ok" as const,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(result).toContain("symbolic link")
  })
})
