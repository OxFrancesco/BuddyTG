import { Effect, Redacted } from "effect"
import { Keychain } from "./keychain"

export const KC_BOT_TOKEN = "bot-token"
export const KC_CHAT_ID = "chat-id"

export class BotError extends Error {
  readonly _tag = "BotError"
}

/** Call a Bot API method over HTTPS (no MTProto session needed for the bot). */
export const botApi = (token: Redacted.Redacted<string>, method: string, body: object) =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(
        `https://api.telegram.org/bot${Redacted.value(token)}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      )
      const json = (await res.json()) as { ok: boolean; description?: string; result?: unknown }
      if (!json.ok) throw new Error(json.description ?? `Bot API ${method} failed`)
      return json.result
    },
    catch: (e) => new BotError(e instanceof Error ? e.message : String(e)),
  })

export const loadBotToken = Effect.gen(function* () {
  const keychain = yield* Keychain
  const env = process.env.TG_BOT_TOKEN
  if (env) return Redacted.make(env)
  return yield* keychain.get(KC_BOT_TOKEN)
})
