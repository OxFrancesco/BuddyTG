import { describe, expect, test } from "bun:test"
import { confirmSend } from "./index"
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

describe("send approval", () => {
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
