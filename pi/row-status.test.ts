import { expect, test } from "bun:test"
import { createEventBus } from "@earendil-works/pi-coding-agent"
import { createAccountPublisher } from "./row-status"
import type { AccountState } from "./account"

test("publisher is inert until started, replays on request and clears on shutdown", () => {
  const events = createEventBus()
  const updates: unknown[] = []
  events.on("nostop:row-status:v1", value => { updates.push(value) })
  let state: AccountState = { kind: "checking" }
  const publisher = createAccountPublisher(events, () => state)
  publisher.publish()
  expect(updates).toEqual([])
  publisher.start()
  expect(updates.at(-1)).toEqual({ id: "buddytg", status: { text: "BuddyTG: Checking...", tone: "muted" } })
  state = { kind: "signed-in", account: "PRIVATE" }
  events.emit("nostop:row-status-request:v1", undefined)
  expect(updates.at(-1)).toEqual({ id: "buddytg", status: { text: "BuddyTG: Active", tone: "success" } })
  publisher.start() // repeat startup must not duplicate subscriptions
  const count = updates.length
  events.emit("nostop:row-status-request:v1", undefined)
  expect(updates).toHaveLength(count + 1)
  publisher.stop()
  expect(updates.at(-1)).toEqual({ id: "buddytg", status: null })
  const stoppedCount = updates.length
  publisher.publish()
  events.emit("nostop:row-status-request:v1", undefined)
  expect(updates).toHaveLength(stoppedCount)
  expect(JSON.stringify(updates)).not.toContain("PRIVATE")
})
