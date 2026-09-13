import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { resolve } from "node:path"
import { lstat } from "node:fs/promises"
import { runCLI, type RunCLI } from "./runner"
import { registerAccount } from "./account"

const id = Type.String({ pattern: "^-?[1-9][0-9]*$", maxLength: 16, description: "Exact Telegram ID verified with buddytg_chats or buddytg_whoami" })
const text = Type.String({ minLength: 1, maxLength: 4096 })
const result = (output: string) => ({ content: [{ type: "text" as const, text: output }], details: {} })

export async function confirmSend(ctx: { hasUI: boolean; ui: Pick<ExtensionContext["ui"], "confirm"> }, manifest: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  if (!ctx.hasUI) throw new Error("Sending requires a live pi UI confirmation. Print/JSON sends are disabled.")
  const approved = await ctx.ui.confirm("Send via BuddyTG?", manifest, { timeout: 60_000, signal })
  signal?.throwIfAborted()
  if (!approved) throw new Error("Send cancelled. Nothing sent.")
}

/** Injectable CLI boundary lets tests exercise tools without contacting Telegram. */
export function registerBuddyTG(pi: ExtensionAPI, run: RunCLI = runCLI) {
  const accountCommand = registerAccount(pi)
  pi.registerTool({
    name: "buddytg_whoami", label: "BuddyTG account", description: "Show the logged-in Telegram account. Output capped at 24 KiB.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) { return result(await run(["whoami"], signal)) },
  })
  pi.registerTool({
    name: "buddytg_chats", label: "BuddyTG chats", description: "List/search Telegram dialogs and stable recipient IDs. Private account data; output capped at 24 KiB.",
    parameters: Type.Object({ query: Type.Optional(Type.String({ maxLength: 200 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), archived: Type.Optional(Type.Boolean()) }),
    async execute(_id, p, signal) {
      if (p.query?.startsWith("-")) throw new Error("Query cannot start with a CLI option prefix.")
      return result(await run(["chats", ...(p.query ? [p.query] : []), "--limit", String(p.limit ?? 50), ...(p.archived ? ["--archived"] : [])], signal))
    },
  })
  pi.registerTool({
    name: "buddytg_send", label: "BuddyTG send", description: "Send exact plain text to a verified numeric Telegram recipient ID. Requires live UI confirmation, including Saved Messages. Never retry unknown delivery. Output capped at 24 KiB.",
    parameters: Type.Object({ recipientId: id, message: text }),
    async execute(_id, p, signal, _update, ctx) {
      await confirmSend(ctx, JSON.stringify({ recipientId: p.recipientId, message: p.message }, null, 2), signal)
      return result(await run(["send", p.recipientId, p.message], signal))
    },
  })
  pi.registerTool({
    name: "buddytg_send_file", label: "BuddyTG send file", description: "Upload one local regular file as an exact-byte document to a verified numeric Telegram ID. Requires live UI confirmation of path, size, recipient and caption. CLI verifies recipient before upload. Output capped at 24 KiB.",
    parameters: Type.Object({ recipientId: id, path: Type.String({ minLength: 1, maxLength: 4096 }), caption: Type.Optional(Type.String({ maxLength: 1024 })) }),
    async execute(_id, p, signal, _update, ctx) {
      if (!ctx.hasUI) throw new Error("File sending requires a live pi UI confirmation.")
      const path = resolve(ctx.cwd, p.path.replace(/^@/, ""))
      const before = await lstat(path)
      if (!before.isFile() || before.size === 0) throw new Error("Choose a nonempty regular file, not a symlink.")
      await confirmSend(ctx, JSON.stringify({ recipientId: p.recipientId, path, bytes: before.size, mode: "document", caption: p.caption ?? "" }, null, 2), signal)
      const after = await lstat(path)
      if (!after.isFile() || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("File changed during confirmation; nothing uploaded.")
      return result(await run(["file", "send", p.recipientId, path, "--confirm-to", p.recipientId, ...(p.caption === undefined ? [] : ["--caption", p.caption])], signal))
    },
  })
  pi.registerCommand("buddytg", {
    description: "BuddyTG login, logout, refresh, status, whoami or help",
    getArgumentCompletions: prefix => ["help", "whoami", "login", "logout", "refresh", "status"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    async handler(args, ctx) {
      if (await accountCommand(args.trim(), ctx)) return
      if (args.trim() === "whoami") {
        try { ctx.ui.notify(await run(["whoami"], ctx.signal), "info") }
        catch { ctx.ui.notify("BuddyTG account check failed. Run bun run buddytg whoami in the BuddyTG directory.", "error") }
        return
      }
      ctx.ui.notify("BuddyTG tools: buddytg_whoami, buddytg_chats, buddytg_send, buddytg_send_file. Sends require UI confirmation. /buddytg login opens private QR login; logout requires confirmation; refresh checks the account; status shows the last check. Exports, downloads and bot setup remain in the standalone CLI.", "info")
    },
  })
}

export default function (pi: ExtensionAPI) { registerBuddyTG(pi) }
