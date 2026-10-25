import { TelegramClient } from "@mtcute/bun"
import { MemoryStorage, tl } from "@mtcute/core"
import { Config, Effect, Option, Redacted, Schema, SchemaGetter as Getter } from "effect"
import { Keychain } from "./keychain"
import { createMtprotoTransport, selectMtprotoTransport } from "./mtproto-transport"

export const KC_SESSION = "session"
export const KC_API_ID = "api-id"
export const KC_API_HASH = "api-hash"

export class TelegramError extends Schema.TaggedError<TelegramError>()("TelegramError", {
  message: Schema.String,
  /** MTProto RPC error text such as SESSION_PASSWORD_NEEDED, when Telegram returned one. */
  rpcText: Schema.optional(Schema.String),
}) {}

export class NotLoggedInError extends Schema.TaggedError<NotLoggedInError>()("NotLoggedInError", {}) {
  override get message() {
    return "Not logged in. Run `buddytg login` first."
  }
}

export class InvalidCredentialsError extends Schema.TaggedError<InvalidCredentialsError>()(
  "InvalidCredentialsError",
  { message: Schema.String },
) {}

const toTelegramError = (error: unknown) =>
  new TelegramError({
    message: error instanceof Error ? error.message : String(error),
    ...(tl.RpcError.is(error) ? { rpcText: error.text } : {}),
  })

/** Wrap one mtcute call. The signal aborts when the fiber is interrupted (Ctrl+C). */
export const tg = <A>(f: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: toTelegramError })

export interface ApiCredentials {
  readonly apiId: number
  readonly apiHash: Redacted.Redacted<string>
}

const ApiId = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,15}$/)).pipe(
  Schema.decodeTo(Schema.Number, { decode: Getter.transform(Number), encode: Getter.transform(String) }),
)
const decodeApiId = Schema.decodeUnknownEffect(ApiId)

const EnvCredentials = Config.option(
  Config.all({ apiId: Config.String("TG_API_ID"), apiHash: Config.Redacted("TG_API_HASH") }),
)

/** Load API credentials (env vars take priority over the local secret store). */
export const loadApiCredentials = Effect.gen(function* () {
  const env = yield* EnvCredentials.pipe(
    Effect.mapError(() => new InvalidCredentialsError({ message: "TG_API_ID must be a positive integer" })),
  )
  if (Option.isSome(env)) {
    const apiId = yield* decodeApiId(env.value.apiId.trim()).pipe(
      Effect.mapError(() => new InvalidCredentialsError({ message: "TG_API_ID must be a positive integer" })),
    )
    return { apiId, apiHash: env.value.apiHash } satisfies ApiCredentials
  }
  const keychain = yield* Keychain
  const id = yield* keychain.get(KC_API_ID)
  const hash = yield* keychain.get(KC_API_HASH)
  if (!id || !hash) return null
  const apiId = yield* decodeApiId(Redacted.value(id).trim()).pipe(
    Effect.mapError(() => new InvalidCredentialsError({ message: "Stored api-id is invalid. Run `buddytg login` again." })),
  )
  return { apiId, apiHash: hash } satisfies ApiCredentials
})

/**
 * Acquire a TelegramClient as a scoped resource.
 * Uses in-memory storage; the session is persisted in the local secret store.
 * Linux defaults to WebSocket MTProto; macOS keeps TCP. See `selectMtprotoTransport`.
 * Release is bounded so a stuck connection cannot block exit.
 */
export const makeClient = (creds: ApiCredentials) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const selection = selectMtprotoTransport()
      return new TelegramClient({
        apiId: creds.apiId,
        apiHash: Redacted.value(creds.apiHash),
        storage: new MemoryStorage(),
        transport: createMtprotoTransport(selection),
        useIpv6: selection.useIpv6,
      })
    }),
    (client) =>
      Effect.promise(() => Promise.race([client.destroy().catch(() => {}), Bun.sleep(5_000)])),
  )

/** Client restored from the stored session — for authenticated commands. */
export const makeAuthedClient = Effect.gen(function* () {
  const keychain = yield* Keychain
  const creds = yield* loadApiCredentials
  const session = yield* keychain.get(KC_SESSION)
  if (!creds || !session) return yield* new NotLoggedInError()
  const client = yield* makeClient(creds)
  yield* tg(() => client.importSession(Redacted.value(session)))
  return client
})

export const saveSession = Effect.fn("saveSession")(function* (client: TelegramClient) {
  const keychain = yield* Keychain
  const session = yield* tg(() => client.exportSession())
  yield* keychain.set(KC_SESSION, Redacted.make(session))
})
