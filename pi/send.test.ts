import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEventBus, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Value } from "typebox/value"
import { registerBuddyTG } from "./index"
import { createSendLimiter, type SendClock } from "./send-limiter"

const original = process.env.BUDDYTG_CONFIRM_SENDS
const limitEnv = ["BUDDYTG_SEND_COOLDOWN_MS", "BUDDYTG_SEND_SESSION_CAP"] as const
const originalLimits = limitEnv.map(name => process.env[name])
let directory: string
beforeEach(async () => {
  delete process.env.BUDDYTG_CONFIRM_SENDS
  for (const name of limitEnv) delete process.env[name]
  directory = await mkdtemp(join(tmpdir(), "buddytg-send-test-"))
  await writeFile(join(directory, "animation.gif"), "GIF89a")
})
afterEach(async () => {
  if (original === undefined) delete process.env.BUDDYTG_CONFIRM_SENDS
  else process.env.BUDDYTG_CONFIRM_SENDS = original
  limitEnv.forEach((name, index) => {
    if (originalLimits[index] === undefined) delete process.env[name]
    else process.env[name] = originalLimits[index]
  })
  await rm(directory, { recursive: true, force: true })
})

function harness(hasUI = false, confirm: ExtensionContext["ui"]["confirm"] = async () => { throw new Error("must not prompt") }) {
  const tools = new Map<string, Pick<ToolDefinition, "parameters" | "execute">>()
  const calls: string[][] = []
  let now = 0
  registerBuddyTG({ registerTool(tool) { tools.set(tool.name, tool) }, registerCommand() {}, on() {}, events: createEventBus() }, async (args, signal) => {
    signal?.throwIfAborted()
    calls.push([...args])
    return "fake delivery"
  }, { now: () => now, sleep: async ms => { now += ms } })
  // Only these context fields are read by send tools. No session or live CLI exists.
  const ctx = { cwd: directory, hasUI, ui: { confirm } } as ExtensionContext
  return {
    calls,
    async send(name: string, params: unknown, signal?: AbortSignal) {
      const tool = tools.get(name)
      if (!tool) throw new Error("Missing tool")
      // Pi validates the registered schema before execute; reproduce that boundary.
      if (!Value.Check(tool.parameters, params)) throw new Error("Invalid send arguments")
      return tool.execute("test", params, signal, undefined, ctx)
    },
  }
}

for (const hasUI of [true, false]) test(`both tools default to no prompt, hasUI=${hasUI}`, async () => {
  const h = harness(hasUI)
  const message = 'literal $(echo no); "hello"\nnext'
  await h.send("buddytg_send", { recipientId: "123", message })
  await h.send("buddytg_send_file", { recipientId: "123", path: "@animation.gif", caption: "exact caption" })
  expect(h.calls).toEqual([
    ["send", "123", message],
    ["file", "send", "123", join(directory, "animation.gif"), "--confirm-to", "123", "--caption", "exact caption"],
  ])
})

for (const name of ["buddytg_send", "buddytg_send_file"]) {
  const params = { recipientId: "123", message: "hello", path: "animation.gif" }
  test(`${name}: opt-in denial, headless, approval and cancellation`, async () => {
    process.env.BUDDYTG_CONFIRM_SENDS = "1"
    for (const hasUI of [true, false]) {
      const denied = harness(hasUI, async () => false)
      await expect(denied.send(name, params)).rejects.toThrow()
      expect(denied.calls).toEqual([])
    }
    let prompts = 0
    const approved = harness(true, async (_title, manifest, options) => {
      prompts++
      expect(options?.timeout).toBe(60_000)
      expect(JSON.parse(manifest)).toEqual(name === "buddytg_send"
        ? { recipientId: "123", message: "hello" }
        : { recipientId: "123", path: join(directory, "animation.gif"), bytes: 6, mode: "document", caption: "" })
      return true
    })
    await approved.send(name, params)
    expect(prompts).toBe(1)
    expect(approved.calls).toHaveLength(1)
    const controller = new AbortController()
    const cancelled = harness(true, async () => { controller.abort(); return true })
    await expect(cancelled.send(name, params, controller.signal)).rejects.toThrow()
    expect(cancelled.calls).toEqual([])
    delete process.env.BUDDYTG_CONFIRM_SENDS
    const preAborted = harness()
    await expect(preAborted.send(name, params, AbortSignal.abort())).rejects.toThrow()
    expect(preAborted.calls).toEqual([])
  })
  test(`${name}: invalid recipients never reach CLI`, async () => {
    const h = harness()
    for (const recipientId of ["self", "@someone", "0", "--help", "12345678901234567"])
      await expect(h.send(name, { ...params, recipientId })).rejects.toThrow("Invalid send")
    expect(h.calls).toEqual([])
  })
}

test("message, caption and path schema limits remain enforced", async () => {
  const h = harness()
  for (const message of ["", "x".repeat(4097)])
    await expect(h.send("buddytg_send", { recipientId: "123", message })).rejects.toThrow("Invalid send")
  for (const params of [{ path: "" }, { path: "animation.gif", caption: "x".repeat(1025) }])
    await expect(h.send("buddytg_send_file", { recipientId: "123", ...params })).rejects.toThrow("Invalid send")
  expect(h.calls).toEqual([])
})

test("missing, empty, directory and symlink files never upload without prompts", async () => {
  await writeFile(join(directory, "empty"), "")
  await symlink(join(directory, "animation.gif"), join(directory, "link"))
  const h = harness()
  for (const path of ["missing", "empty", ".", "link"])
    await expect(h.send("buddytg_send_file", { recipientId: "123", path })).rejects.toThrow()
  expect(h.calls).toEqual([])
})

test("file mutation during opt-in approval blocks upload", async () => {
  process.env.BUDDYTG_CONFIRM_SENDS = "1"
  const h = harness(true, async () => { await writeFile(join(directory, "animation.gif"), "changed"); return true })
  await expect(h.send("buddytg_send_file", { recipientId: "123", path: "animation.gif" })).rejects.toThrow("File changed")
  expect(h.calls).toEqual([])
})

function fakeClock() {
  let now = 0
  const waits: number[] = []
  const clock: SendClock = { now: () => now, sleep: async ms => { waits.push(ms); now += ms } }
  return { clock, waits, advance(ms: number) { now += ms } }
}

test("cooldown waits only the remainder and does not delay the first send", async () => {
  const time = fakeClock()
  const send = createSendLimiter(time.clock)
  await send(async () => "first")
  expect(time.waits).toEqual([])
  time.advance(700)
  await send(async () => "second")
  expect(time.waits).toEqual([2300])
  time.advance(4000)
  await send(async () => "third")
  expect(time.waits).toEqual([2300])
})

test("default cap bounds failed and unknown-delivery CLI attempts", async () => {
  const time = fakeClock()
  const send = createSendLimiter(time.clock)
  let calls = 0
  const cli = async () => { calls++; throw new Error("unknown delivery") }
  for (let i = 0; i < 30; i++) await expect(send(cli)).rejects.toThrow("unknown delivery")
  await expect(send(cli)).rejects.toThrow("session send cap (30) reached")
  expect(calls).toBe(30)
})

test("all send tools share the configured cap and cooldown", async () => {
  process.env.BUDDYTG_SEND_SESSION_CAP = " 2 "
  process.env.BUDDYTG_SEND_COOLDOWN_MS = " 100 "
  const h = harness()
  await h.send("buddytg_send", { recipientId: "123", message: "one" })
  await h.send("buddytg_reply", { recipientId: "123", messageId: 1, message: "two" })
  await expect(h.send("buddytg_send_file", { recipientId: "123", path: "animation.gif" })).rejects.toThrow("session send cap (2) reached")
  expect(h.calls.map(call => call[0])).toEqual(["send", "reply"])
})

test("abort during cooldown sends nothing and does not consume the cap", async () => {
  process.env.BUDDYTG_SEND_SESSION_CAP = "2"
  const controller = new AbortController()
  const time = fakeClock()
  let calls = 0
  const send = createSendLimiter({ ...time.clock, sleep: async () => { controller.abort(); controller.signal.throwIfAborted() } })
  await send(async () => { calls++ })
  await expect(send(async () => { calls++ }, controller.signal)).rejects.toThrow()
  expect(calls).toBe(1)
  time.advance(3000)
  await send(async () => { calls++ })
  expect(calls).toBe(2)
})

test("concurrent sends serialize through CLI completion, cooldown and cap", async () => {
  process.env.BUDDYTG_SEND_SESSION_CAP = "2"
  const time = fakeClock()
  const send = createSendLimiter(time.clock)
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const calls: number[] = []
  const first = send(async () => { calls.push(1); started.resolve(); await finish.promise })
  await started.promise
  const second = send(async () => { calls.push(2) })
  const rejected = send(async () => { calls.push(3) }).catch(error => error)
  expect(calls).toEqual([1])
  expect(time.waits).toEqual([])
  finish.resolve()
  await Promise.all([first, second, rejected])
  expect(await rejected).toBeInstanceOf(Error)
  expect((await rejected).message).toContain("session send cap")
  expect(calls).toEqual([1, 2])
  expect(time.waits).toEqual([3000])
})

test("validation and pre-abort leave the budget available and the queue usable", async () => {
  process.env.BUDDYTG_SEND_SESSION_CAP = "1"
  const send = createSendLimiter(fakeClock().clock)
  let calls = 0
  const cli = async () => { calls++ }
  await expect(send(cli, AbortSignal.abort())).rejects.toThrow()
  await expect(send(cli, undefined, async () => { throw new Error("invalid file") })).rejects.toThrow("invalid file")
  await send(cli)
  expect(calls).toBe(1)
})

test("a queued abort never reaches CLI and does not block later sends", async () => {
  process.env.BUDDYTG_SEND_SESSION_CAP = "2"
  const send = createSendLimiter(fakeClock().clock)
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const controller = new AbortController()
  let calls = 0
  const first = send(async () => { calls++; started.resolve(); await finish.promise })
  await started.promise
  const cancelled = send(async () => { calls++ }, controller.signal).catch(error => error)
  controller.abort()
  finish.resolve()
  await Promise.all([first, cancelled])
  expect(await cancelled).toBeInstanceOf(Error)
  await send(async () => { calls++ })
  expect(calls).toBe(2)
})

test("strict invalid environment values fail closed without consuming budget", async () => {
  const send = createSendLimiter(fakeClock().clock)
  let calls = 0
  const cli = async () => { calls++ }
  for (const name of limitEnv) {
    for (const value of ["", " ", "0", "-1", "1.5", "1e3", "Infinity", "no", "9007199254740992", ...(name === "BUDDYTG_SEND_COOLDOWN_MS" ? ["2147483648"] : [])]) {
      process.env[name] = value
      await expect(send(cli)).rejects.toThrow(name)
    }
    delete process.env[name]
  }
  expect(calls).toBe(0)
  await send(cli)
  expect(calls).toBe(1)
})
