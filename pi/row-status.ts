import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { AccountState } from "./account"

const UPDATE = "nostop:row-status:v1"
const REQUEST = "nostop:row-status-request:v1"

export function accountBadge(state: AccountState): { text: string; tone: "success" | "muted" | "error" } {
  switch (state.kind) {
    case "signed-in": return { text: "BuddyTG: Active", tone: "success" }
    case "signed-out": return { text: "BuddyTG: Inactive", tone: "muted" }
    case "checking": return { text: "BuddyTG: Checking...", tone: "muted" }
    case "error": return { text: "BuddyTG: Error", tone: "error" }
  }
}

/** Publish display data only. No-Stop owns the widget, placement and rendering. */
export function createAccountPublisher(events: ExtensionAPI["events"], getState: () => AccountState) {
  let removeListener: (() => void) | undefined
  let active = false
  const publish = () => {
    if (active) events.emit(UPDATE, { id: "buddytg", status: accountBadge(getState()) })
  }
  return {
    start() {
      removeListener?.()
      active = true
      removeListener = events.on(REQUEST, publish)
      publish()
    },
    publish,
    stop() {
      active = false
      removeListener?.()
      removeListener = undefined
      events.emit(UPDATE, { id: "buddytg", status: null })
    },
  }
}
