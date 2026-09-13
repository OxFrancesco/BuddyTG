import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"

test("native pi loader registers tools and command without Telegram access", async () => {
  const loaded = await loadExtensions([resolve(import.meta.dir, "index.ts")], process.cwd())
  expect(loaded.errors).toEqual([])
  expect(loaded.extensions).toHaveLength(1)
  const extension = loaded.extensions[0]
  expect([...extension!.tools.keys()].sort()).toEqual(["buddytg_chats", "buddytg_send", "buddytg_send_file", "buddytg_whoami"])
  expect(extension!.commands.has("buddytg")).toBe(true)
})
