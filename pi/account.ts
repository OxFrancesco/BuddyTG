import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { runProcess } from "./runner"
import { createAccountPublisher } from "./row-status"

export type AccountState = { kind: "checking" } | { kind: "signed-in"; account: string } | { kind: "signed-out" } | { kind: "error" }
export function parseAccount(output: string): AccountState {
  const value: unknown = JSON.parse(output)
  if (typeof value !== "object" || value === null || !("kind" in value)) throw new Error("Invalid account result")
  if (value.kind === "signed-out" || value.kind === "error") return { kind: value.kind }
  if (value.kind === "signed-in" && "account" in value && typeof value.account === "string" && value.account.trim()) {
    return { kind: "signed-in", account: value.account.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").slice(0, 200) }
  }
  throw new Error("Invalid account result")
}
export function accountLabel(state: AccountState): string {
  switch (state.kind) {
    case "checking": return "BuddyTG: checking..."
    case "signed-in": return `BuddyTG: signed in as ${state.account}`
    case "signed-out": return "BuddyTG: not signed in"
    case "error": return "BuddyTG: account check error"
  }
}

export type AccountDependencies = {
  check: (signal: AbortSignal) => Promise<AccountState>
  interactive: (action: "login" | "logout") => number | null
}
const dependencies: AccountDependencies = {
  check: async signal => parseAccount(await runProcess(["bun", fileURLToPath(new URL("./account-probe.ts", import.meta.url))], signal, 20_000)),
  interactive: action => spawnSync("bun", [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), action], { stdio: "inherit", shell: false }).status,
}

export function registerAccount(pi: Pick<ExtensionAPI, "on" | "events">, deps: AccountDependencies = dependencies) {
  let state: AccountState = { kind: "checking" }
  let controller: AbortController | undefined
  const publisher = createAccountPublisher(pi.events, () => state)
  let busy = false
  let stopped = false
  const refresh = async () => {
    controller?.abort()
    const current = new AbortController()
    controller = current
    state = { kind: "checking" }; publisher.publish()
    let next: AccountState
    try { next = await deps.check(current.signal) } catch { next = { kind: "error" } }
    if (!stopped && controller === current) { state = next; publisher.publish() }
  }
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return
    stopped = false
    state = { kind: "checking" }
    publisher.start()
    void refresh()
  })
  pi.on("session_shutdown", () => {
    stopped = true; controller?.abort(); controller = undefined
    publisher.stop()
  })
  return async (action: string, ctx: Pick<ExtensionContext, "mode"> & { ui: Pick<ExtensionContext["ui"], "notify" | "confirm" | "custom"> }): Promise<boolean> => {
    if (!["login", "logout", "refresh", "status"].includes(action)) return false
    if (ctx.mode !== "tui") { ctx.ui.notify("BuddyTG account commands require the Pi terminal.", "warning"); return true }
    if (busy) { ctx.ui.notify("BuddyTG account operation already running.", "warning"); return true }
    if (action === "status") { ctx.ui.notify(accountLabel(state), "info"); return true }
    busy = true
    try {
      if (action === "refresh") { await refresh(); return true }
      if (action !== "login" && action !== "logout") return true
      const message = action === "login"
        ? "Open private terminal QR login? Scan using Francesco's Telegram account. Never paste credentials into Pi chat. Ctrl+C cancels."
        : "Log out of BuddyTG and delete its session, API credentials and bot secrets from Keychain? This affects the standalone CLI too."
      if (!await ctx.ui.confirm(`BuddyTG ${action}`, message)) return true
      controller?.abort(); controller = undefined
      state = { kind: "checking" }; publisher.publish()
      let code: number | null = null
      try {
        code = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
          tui.stop()
          try {
            process.stdout.write("\x1b[2J\x1b[H")
            done(deps.interactive(action))
          } finally {
            process.stdout.write("\x1b[2J\x1b[H")
            tui.start(); tui.requestRender(true)
          }
          return { render: () => [], invalidate() {} }
        })
      } catch { /* Raw diagnostics must never enter Pi's session. */ }
      await refresh()
      ctx.ui.notify(code === 0 ? accountLabel(state) : "BuddyTG operation cancelled or failed. Account status was checked again.", code === 0 ? "info" : "warning")
    } finally { busy = false }
    return true
  }
}
