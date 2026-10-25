import { afterEach, beforeEach, expect, test } from "bun:test"
import { Effect, Exit, Redacted, Scope } from "effect"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { botUpdatesLockName, holdInstanceLock, InstanceLockError } from "./lock"

let dir: string
const lockPath = () => join(dir, "t.lock")
const hold = () => holdInstanceLock("t", "testing", dir)
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromiseExit(Effect.scoped(effect))

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "buddytg-lock-")), "secrets")
})
afterEach(async () => {
  await rm(join(dir, ".."), { recursive: true, force: true })
})

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected failure")
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  return (error as { error: unknown } | undefined)?.error
}

test("holds the lock with this PID for the scope and removes it afterwards", async () => {
  const exit = await run(Effect.gen(function* () {
    yield* hold()
    return yield* Effect.promise(() => readFile(lockPath(), "utf8"))
  }))
  expect(exit).toEqual(Exit.succeed(`${process.pid}\n`))
  expect(existsSync(lockPath())).toBe(false)
})

test("is reentrant within one process", async () => {
  const nested = await run(Effect.gen(function* () {
    yield* hold()
    yield* Effect.scoped(hold())
    return existsSync(lockPath())
  }))
  expect(nested).toEqual(Exit.succeed(true))
  expect(existsSync(lockPath())).toBe(false)
})

test("concurrent fibers in one process share the lock", async () => {
  const exit = await run(Effect.all([hold(), hold(), hold()], { concurrency: "unbounded" }))
  expect(Exit.isSuccess(exit)).toBe(true)
  expect(existsSync(lockPath())).toBe(false)
})

test("fails fast while another live process holds it, and leaves its lock alone", async () => {
  const other = Bun.spawn(["sleep", "30"])
  try {
    await Effect.runPromise(Effect.scoped(hold()))
    await writeFile(lockPath(), `${other.pid}\n`, { mode: 0o600 })
    const error = failureOf(await run(hold()))
    expect(error).toBeInstanceOf(InstanceLockError)
    expect((error as InstanceLockError).message).toBe(
      `Another buddytg process (pid ${other.pid}) is running: testing. Wait for it to finish and try again.`,
    )
    expect(await readFile(lockPath(), "utf8")).toBe(`${other.pid}\n`)
  } finally {
    other.kill()
  }
})

test("takes over a lock left by a process that no longer runs", async () => {
  const dead = Bun.spawn(["true"])
  await dead.exited
  await Effect.runPromise(Effect.scoped(hold()))
  await writeFile(lockPath(), `${dead.pid}\n`, { mode: 0o600 })
  const exit = await run(Effect.gen(function* () {
    yield* hold()
    return yield* Effect.promise(() => readFile(lockPath(), "utf8"))
  }))
  expect(exit).toEqual(Exit.succeed(`${process.pid}\n`))
})

test("an unreadable lock is busy while fresh and stale once old", async () => {
  await Effect.runPromise(Effect.scoped(hold()))
  await writeFile(lockPath(), "", { mode: 0o600 })
  expect(failureOf(await run(hold()))).toBeInstanceOf(InstanceLockError)
  const old = new Date(Date.now() - 60_000)
  await utimes(lockPath(), old, old)
  expect(Exit.isSuccess(await run(hold()))).toBe(true)
})

test("bot lock names are per token and never contain it", () => {
  const token = "123456:SECRET-TOKEN"
  const name = botUpdatesLockName(Redacted.make(token))
  expect(name).toMatch(/^bot-[0-9a-f]{16}$/)
  expect(name).not.toContain("SECRET")
  expect(botUpdatesLockName(Redacted.make("654321:OTHER"))).not.toBe(name)
})
