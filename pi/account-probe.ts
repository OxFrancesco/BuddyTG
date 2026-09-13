import { TelegramClient } from "@mtcute/bun"
import { MemoryStorage } from "@mtcute/core"

/** Only item-not-found means absent. Locked/denied/broken Keychain is an error. */
export function keychainValue(code: number, output: string): string | null {
  if (code === 44) return null
  if (code !== 0) throw new Error("Keychain unavailable")
  if (!output.trim()) throw new Error("Empty Keychain item")
  return output.trimEnd()
}

async function readSecret(account: string) {
  const child = Bun.spawn(["security", "find-generic-password", "-s", "buddytg", "-a", account, "-w"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  return keychainValue(code, output)
}

export async function probeAccount() {
  const session = await readSecret("session")
  if (session === null) return { kind: "signed-out" }
  const apiId = process.env.TG_API_ID ?? await readSecret("api-id")
  const apiHash = process.env.TG_API_HASH ?? await readSecret("api-hash")
  if (!apiId || !apiHash || !Number.isSafeInteger(Number(apiId)) || Number(apiId) <= 0) throw new Error("Invalid API configuration")
  const client = new TelegramClient({ apiId: Number(apiId), apiHash, storage: new MemoryStorage() })
  try {
    await client.importSession(session)
    const me = await client.getMe()
    return { kind: "signed-in", account: `${me.displayName}${me.username ? ` @${me.username}` : ""} (${me.id})` }
  } finally { await client.destroy() }
}

// Bun-only subprocess. Never import the Telegram client into Pi's Node runtime.
if (import.meta.main) {
  try { process.stdout.write(JSON.stringify(await probeAccount())) }
  catch { process.stdout.write(JSON.stringify({ kind: "error" })) }
}
