import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { confirmSend, requiresSendConfirmation } from "./index"

const originalConfirmation = process.env.BUDDYTG_CONFIRM_SENDS
beforeEach(() => { delete process.env.BUDDYTG_CONFIRM_SENDS })
afterEach(() => {
  if (originalConfirmation === undefined) delete process.env.BUDDYTG_CONFIRM_SENDS
  else process.env.BUDDYTG_CONFIRM_SENDS = originalConfirmation
})
import { OUTPUT_LIMIT, runProcess } from "./runner"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"

// Only the confirmation method is accessed by this helper.
const context = (hasUI: boolean, confirm: ExtensionContext["ui"]["confirm"]) => ({ hasUI, ui: { confirm } })

describe("process boundary, no Telegram", () => {
  test("passes shell metacharacters as literal argv", async () => {
    const payload = '$(touch /tmp/buddytg-should-not-exist); `echo bad` "quoted"\nnext'
    expect(await runProcess(["bun", "-e", "process.stdout.write(process.argv[1])", payload])).toBe(payload)
  })
  test("caps output and discards diagnostics", async () => {
    const output = await runProcess(["bun", "-e", `process.stderr.write('SECRET'); process.stdout.write('x'.repeat(${OUTPUT_LIMIT * 3}))`])
    expect(output).not.toContain("SECRET")
    expect(output).toContain("truncated")
    expect(output.length).toBeLessThan(OUTPUT_LIMIT + 150)
  })
  test("failure never exposes stderr", async () => {
    await expect(runProcess(["bun", "-e", "console.error('SECRET');process.exit(1)"])).rejects.toThrow("Diagnostics withheld")
  })
  test("timeout stops child", async () => {
    await expect(runProcess(["bun", "-e", "setInterval(()=>{},1000)"], undefined, 30)).rejects.toThrow("delivery is unknown")
  })
  test("abort stops child and pre-abort does not spawn", async () => {
    const controller = new AbortController()
    const pending = runProcess(["bun", "-e", "setInterval(()=>{},1000)"], controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow("cancelled")
    await expect(runProcess(["missing-command"], controller.signal)).rejects.toThrow()
  })
})

// Narrow adapter keeps test doubles honest without fabricating a full pi context.
async function approval(hasUI: boolean, confirm: ExtensionContext["ui"]["confirm"], signal?: AbortSignal) {
  const ctx = context(hasUI, confirm)
  return confirmSend(ctx, 'recipient: 123; message: exact', signal)
}

describe("send defaults", () => {
  test("no prompt in UI or headless by default", async () => {
    for (const hasUI of [true, false]) await approval(hasUI, async () => { throw new Error("must not prompt") })
  })
  test("configuration parses explicit opt-in and rejects typos", () => {
    for (const value of ["", "0", "false", "no"]) expect(requiresSendConfirmation(value)).toBe(false)
    for (const value of ["1", "true", "yes", " TRUE "]) expect(requiresSendConfirmation(value)).toBe(true)
    expect(() => requiresSendConfirmation("tru")).toThrow("Nothing sent")
  })
  test("pre-abort never auto-approves", async () => {
    await expect(approval(false, async () => true, AbortSignal.abort())).rejects.toThrow()
  })
})

describe("send approval", () => {
  beforeEach(() => { process.env.BUDDYTG_CONFIRM_SENDS = "1" })
  test("noninteractive denied without prompting", async () => {
    await expect(approval(false, async () => { throw new Error("must not prompt") })).rejects.toThrow("live pi UI")
  })
  test("decline denied", async () => { await expect(approval(true, async () => false)).rejects.toThrow("Nothing sent") })
  test("approval presents exact manifest and timeout", async () => {
    await approval(true, async (_title, message, options) => {
      expect(message).toBe('recipient: 123; message: exact')
      expect(options?.timeout).toBe(60_000)
      return true
    })
  })
  test("abort during approval cannot authorize send", async () => {
    const controller = new AbortController()
    await expect(approval(true, async () => { controller.abort(); return true }, controller.signal)).rejects.toThrow()
  })
})
