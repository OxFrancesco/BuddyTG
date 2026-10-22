import { Config, Effect, Option, Redacted, Schema, SchemaGetter as Getter } from "effect"
import { Keychain } from "./keychain"
import { makeAuthedClient, tg } from "./telegram"

export const KC_BOT_TOKEN = "bot-token"
export const KC_CHAT_ID = "chat-id"

const DEFAULT_BOT_API_ORIGIN = "https://api.telegram.org"

export class BotError extends Schema.TaggedError<BotError>()("BotError", {
  method: Schema.String,
  message: Schema.String,
  errorCode: Schema.optional(Schema.Number),
}) {}

export const BotUser = Schema.Struct({ id: Schema.Int, username: Schema.optional(Schema.String) })

export const BotMessage = Schema.Struct({
  message_id: Schema.Int,
  chat: Schema.Struct({ id: Schema.Int }),
  from: Schema.optional(Schema.Struct({ id: Schema.Int })),
  text: Schema.optional(Schema.String),
  reply_to_message: Schema.optional(Schema.Struct({ message_id: Schema.Int })),
})
export type BotMessage = typeof BotMessage.Type

export const BotCallbackQuery = Schema.Struct({
  id: Schema.String,
  from: Schema.Struct({ id: Schema.Int }),
  data: Schema.optional(Schema.String),
  message: Schema.optional(BotMessage),
})

export const BotUpdate = Schema.Struct({
  update_id: Schema.Int,
  message: Schema.optional(BotMessage),
  callback_query: Schema.optional(BotCallbackQuery),
})
export type BotUpdate = typeof BotUpdate.Type

export const WebhookInfo = Schema.Struct({ url: Schema.String })

const Envelope = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.String),
  error_code: Schema.optional(Schema.Number),
})
const decodeEnvelope = Schema.decodeUnknownEffect(Envelope)

/**
 * Bot API origin. Only loopback may replace api.telegram.org (local e2e tests),
 * so the environment can never send the bot token to another host.
 */
export const botApiOrigin = (raw = process.env.BUDDYTG_BOT_API_ORIGIN) => {
  if (!raw?.trim()) return DEFAULT_BOT_API_ORIGIN
  const url = URL.canParse(raw) ? new URL(raw) : undefined
  if (url?.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.pathname === "/") {
    return url.origin
  }
  throw new Error("BUDDYTG_BOT_API_ORIGIN must be a loopback http:// origin")
}

/**
 * Call a Bot API method over HTTPS (no MTProto session needed for the bot).
 * The token is part of the URL, so transport errors are replaced with a generic
 * message: Bun's fetch errors carry the full URL.
 */
export const botApi = <S extends Schema.Decoder<unknown>>(
  token: Redacted.Redacted<string>,
  method: string,
  body: object,
  result: S,
  options?: { readonly timeoutMs?: number },
): Effect.Effect<S["Type"], BotError> =>
  Effect.gen(function* () {
    const origin = yield* Effect.try({
      try: () => botApiOrigin(),
      catch: (error) => new BotError({ method, message: error instanceof Error ? error.message : String(error) }),
    })
    const raw = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(`${origin}/bot${Redacted.value(token)}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: options?.timeoutMs ? AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]) : signal,
        })
        return (await response.json()) as unknown
      },
      catch: () => new BotError({ method, message: `Bot API ${method} request failed` }),
    })
    const envelope = yield* decodeEnvelope(raw)
    if (!envelope.ok) {
      return yield* new BotError({
        method,
        message: envelope.description ?? `Bot API ${method} failed`,
        ...(envelope.error_code === undefined ? {} : { errorCode: envelope.error_code }),
      })
    }
    return yield* Schema.decodeUnknownEffect(result)(envelope.result)
  }).pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.fail(new BotError({ method, message: `Invalid Bot API ${method} response` })),
    ),
  )

const ChatId = Schema.String.check(Schema.isPattern(/^-?[1-9][0-9]{0,15}$/)).pipe(
  Schema.decodeTo(Schema.Number, { decode: Getter.transform(Number), encode: Getter.transform(String) }),
)
export const decodeChatId = (value: Redacted.Redacted<string>) =>
  Schema.decodeUnknownEffect(ChatId)(Redacted.value(value).trim()).pipe(
    Effect.mapError(() => new BotError({ method: "config", message: "Configured Telegram bot chat ID is invalid" })),
  )

const fromEnvOrKeychain = Effect.fnUntraced(function* (name: string, account: string) {
  const env = yield* Config.option(Config.Redacted(name))
  if (Option.isSome(env)) return env.value
  return yield* (yield* Keychain).get(account)
})

export const loadBotToken = fromEnvOrKeychain("TG_BOT_TOKEN", KC_BOT_TOKEN)

export const loadBotChatId = fromEnvOrKeychain("TG_BOT_CHAT_ID", KC_CHAT_ID)

const fetchOwnUserId = Effect.gen(function* () {
  const client = yield* makeAuthedClient
  const me = yield* tg(() => client.getMe())
  return String(me.id)
}).pipe(Effect.scoped)

export const ensureBotChatId = Effect.gen(function* () {
  const existing = yield* loadBotChatId
  if (existing) return existing
  const chatId = Redacted.make(yield* fetchOwnUserId)
  yield* (yield* Keychain).set(KC_CHAT_ID, chatId)
  return chatId
})
