import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createEventBus, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent"
import { visibleWidth, type Component } from "@earendil-works/pi-tui"
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"
import { registerAccount, type AccountState } from "./account"

const ownerPath = process.env.NOSTOP_EXTENSION ?? join(homedir(), ".pi/agent/extensions/nostop/index.ts")
const integration = existsSync(ownerPath) ? test : test.skip

for (const accountFirst of [true, false]) integration(`real No-Stop row + BuddyTG, account starts ${accountFirst ? "first" : "last"}`, async () => {
  const events = createEventBus()
  const loaded = await loadExtensions([ownerPath], process.cwd(), events)
  expect(loaded.errors).toEqual([])
  const owner = loaded.extensions[0]
  if (!owner) throw new Error("No-Stop did not load")
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>()
  const pending: { signal: AbortSignal; resolve: (state: AccountState) => void }[] = []
  const command = registerAccount({
    events,
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, handler) },
  } as Pick<ExtensionAPI, "on" | "events">, {
    check: signal => new Promise(resolve => { pending.push({ signal, resolve }) }),
    interactive: () => { throw new Error("No live auth allowed") },
  })
  let component: Component | undefined
  let widgetInstalls = 0
  const ui = {
    setWidget(key: string, factory: unknown) {
      expect(key).toBe("nostop")
      if (typeof factory === "function") {
        widgetInstalls++
        component = factory({ requestRender() {} }, { fg: (_: string, text: string) => text })
      } else component = undefined
    },
    setStatus() {}, onTerminalInput: () => () => {},
    notify() {}, confirm: async () => false,
    custom: async () => { throw new Error("Status must not open overlays or custom UI") },
  }
  // Partial host is confined to the test. No model, terminal or Telegram client exists.
  const ctx = { mode: "tui", hasUI: true, ui } as unknown as ExtensionCommandContext
  const ownerEvent = async (name: string) => {
    for (const handler of owner.handlers.get(name) ?? []) await handler({ type: name, reason: "reload" }, ctx)
  }
  const accountStart = () => handlers.get("session_start")?.({}, ctx)
  if (accountFirst) { await accountStart(); await ownerEvent("session_start") }
  else { await ownerEvent("session_start"); await accountStart() }
  expect(component?.render(100)[0]).toContain("No-Stop: disabled")
  expect(component?.render(100)[0]?.endsWith("BuddyTG: Checking... ")).toBe(true)
  pending[0]?.resolve({ kind: "signed-in", account: "PRIVATE" })
  await Promise.resolve(); await Promise.resolve()
  const lines = component?.render(100)
  expect(lines).toHaveLength(1)
  expect(lines?.[0]?.endsWith("BuddyTG: Active ")).toBe(true)
  expect(visibleWidth(lines?.[0] ?? "")).toBe(100)
  expect(lines?.[0]).not.toContain("PRIVATE")
  await owner.commands.get("nostop")?.handler("on", ctx)
  expect(component?.render(100)[0]).toContain("Don't Stop: Enabled | Sol")
  expect(component?.render(100)[0]).toContain("BuddyTG: Active")
  await owner.commands.get("nostop")?.handler("off", ctx)
  expect(component?.render(100)[0]).toContain("No-Stop: disabled")
  expect(widgetInstalls).toBe(1)
  for (const kind of ["signed-out", "error"] as const) {
    const refresh = command("refresh", ctx)
    expect(component?.render(100)[0]).toContain("BuddyTG: Checking...")
    pending.at(-1)?.resolve({ kind })
    await refresh
    expect(component?.render(100)[0]).toContain(kind === "error" ? "BuddyTG: Error" : "BuddyTG: Inactive")
  }
  const refresh = command("refresh", ctx)
  await handlers.get("session_shutdown")?.({}, ctx)
  expect(pending.at(-1)?.signal.aborted).toBe(true)
  expect(component?.render(100)[0]).not.toContain("BuddyTG")
  pending.at(-1)?.resolve({ kind: "signed-in", account: "STALE" })
  await refresh
  expect(component?.render(100)[0]).not.toContain("BuddyTG")
  await ownerEvent("session_shutdown")
  expect(component).toBeUndefined()
  // Restart in the same harness catches stale listeners and cached authenticated state.
  await ownerEvent("session_start"); await accountStart()
  expect(component?.render(100)[0]).toContain("BuddyTG: Checking...")
  await handlers.get("session_shutdown")?.({}, ctx)
  pending.at(-1)?.resolve({ kind: "signed-out" })
  await ownerEvent("session_shutdown")
})
