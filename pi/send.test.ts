import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEventBus, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Value } from "typebox/value"
import { registerBuddyTG } from "./index"

const original = process.env.BUDDYTG_CONFIRM_SENDS
let directory: string
beforeEach(async () => {
  delete process.env.BUDDYTG_CONFIRM_SENDS
  directory = await mkdtemp(join(tmpdir(), "buddytg-send-test-"))
  await writeFile(join(directory, "animation.gif"), "GIF89a")
})
afterEach(async () => {
  if (original === undefined) delete process.env.BUDDYTG_CONFIRM_SENDS
  else process.env.BUDDYTG_CONFIRM_SENDS = original
  await rm(directory, { recursive: true, force: true })
})

function harness(hasUI = false, confirm: ExtensionContext["ui"]["confirm"] = async () => { throw new Error("must not prompt") }) {
  const tools = new Map<string, Pick<ToolDefinition, "parameters" | "execute">>()
  const calls: string[][] = []
  registerBuddyTG({ registerTool(tool) { tools.set(tool.name, tool) }, registerCommand() {}, on() {}, events: createEventBus() }, async (args, signal) => {
    signal?.throwIfAborted()
    calls.push([...args])
    return "fake delivery"
  })
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
