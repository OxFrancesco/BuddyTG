import { expect, test } from "bun:test"
import { createEventBus } from "@earendil-works/pi-coding-agent"
import { accountLabel, parseAccount, registerAccount } from "./account"
import { accountBadge } from "./row-status"
import { keychainValue } from "./account-probe"

test("only missing Keychain item is signed out, not permission failures", () => {
  expect(keychainValue(44, "")).toBeNull()
  expect(keychainValue(0, "value\n")).toBe("value")
  for (const code of [1, 36, 128]) expect(() => keychainValue(code, "secret")).toThrow("Keychain unavailable")
  expect(() => keychainValue(0, "")).toThrow()
})
test("parse validates and sanitizes untrusted account names", () => {
  expect(parseAccount('{"kind":"signed-out"}')).toEqual({ kind: "signed-out" })
  expect(parseAccount('{"kind":"error"}')).toEqual({ kind: "error" })
  expect(parseAccount(JSON.stringify({ kind: "signed-in", account: "Francesco\n\u202e" }))).toEqual({ kind: "signed-in", account: "Francesco" })
  for (const value of [null, {}, { kind: "signed-in", account: 3 }]) expect(() => parseAccount(JSON.stringify(value))).toThrow()
})
test("badges are truthful and never publish account identity", () => {
  expect(accountBadge({ kind: "signed-in", account: "Private 你好" })).toEqual({ text: "BuddyTG: Active", tone: "success" })
  expect(accountBadge({ kind: "signed-out" }).text).toBe("BuddyTG: Inactive")
  expect(accountBadge({ kind: "checking" }).text).toBe("BuddyTG: Checking...")
  expect(accountBadge({ kind: "error" })).toEqual({ text: "BuddyTG: Error", tone: "error" })
})
test("account commands never mutate on registration, status, RPC, or declined confirmation", async () => {
  let checks = 0; let mutations = 0
  const notifications: string[] = []
  const command = registerAccount({ on() {}, events: createEventBus() }, {
    check: async () => { checks++; return { kind: "signed-out" } },
    interactive: () => { mutations++; return 0 },
  })
  const ui = { notify: (message: string) => { notifications.push(message) }, confirm: async () => false, custom: async () => { throw new Error("must not open terminal") } }
  expect(checks).toBe(0)
  for (const action of ["login", "logout", "refresh"]) await command(action, { mode: "rpc", ui })
  for (const action of ["login", "logout", "status"]) await command(action, { mode: "tui", ui })
  expect(mutations).toBe(0); expect(checks).toBe(0)
  await command("refresh", { mode: "tui", ui })
  await command("status", { mode: "tui", ui })
  expect(checks).toBe(1)
  expect(notifications.at(-1)).toBe(accountLabel({ kind: "signed-out" }))
})
test("probe errors remain error and raw secrets never reach notifications", async () => {
  const notifications: string[] = []
  const command = registerAccount({ on() {}, events: createEventBus() }, { check: async () => { throw new Error("SECRET") }, interactive: () => { throw new Error("must not run") } })
  const ui = { notify: (message: string) => { notifications.push(message) }, confirm: async () => false, custom: async () => { throw new Error("must not run") } }
  await command("refresh", { mode: "tui", ui }); await command("status", { mode: "tui", ui })
  expect(notifications).toEqual(["BuddyTG: account check error"])
})
