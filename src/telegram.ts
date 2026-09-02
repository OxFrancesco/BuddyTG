import { TelegramClient } from "@mtcute/bun"
import { MemoryStorage } from "@mtcute/core"
import { Effect, Redacted } from "effect"
import { Keychain } from "./keychain"
import { createMtprotoTransport, selectMtprotoTransport } from "./mtproto-transport"

export const KC_SESSION = "session"
export const KC_API_ID = "api-id"
export const KC_API_HASH = "api-hash"

export class TelegramError extends Error {
  readonly _tag = "TelegramError"
}

export class NotLoggedInError extends Error {
  readonly _tag = "NotLoggedInError"
  constructor() {
    super("Not logged in. Run `bun run src/cli.ts login` first.")
  }
}

export const tg = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (e) => new TelegramError(e instanceof Error ? e.message : String(e)),
  })

/** Load API credentials (env vars take priority over the local secret store). */
export const loadApiCredentials = Effect.gen(function* () {
  const keychain = yield* Keychain
  const envId = process.env.TG_API_ID
  const envHash = process.env.TG_API_HASH
  if (envId && envHash) return { apiId: Number(envId), apiHash: envHash }
  const id = yield* keychain.get(KC_API_ID)
  const hash = yield* keychain.get(KC_API_HASH)
  if (id && hash) return { apiId: Number(Redacted.value(id)), apiHash: Redacted.value(hash) }
  return null
})

/**
 * Acquire a TelegramClient as a scoped resource.
 * Uses in-memory storage; the session is persisted in the local secret store.
 * Linux defaults to WebSocket MTProto; macOS keeps TCP. See `selectMtprotoTransport`.
 */
export const makeClient = (creds: { apiId: number; apiHash: string }) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const selection = selectMtprotoTransport()
      return new TelegramClient({
        apiId: creds.apiId,
        apiHash: creds.apiHash,
        storage: new MemoryStorage(),
        transport: createMtprotoTransport(selection),
        useIpv6: selection.useIpv6,
      })
    }),
    (client) => Effect.promise(() => client.destroy().catch(() => {})),
  )

/** Client restored from the stored session — for authenticated commands. */
export const makeAuthedClient = Effect.gen(function* () {
  const keychain = yield* Keychain
  const creds = yield* loadApiCredentials
  const session = yield* keychain.get(KC_SESSION)
  if (!creds || !session) return yield* Effect.fail(new NotLoggedInError())
  const client = yield* makeClient(creds)
  yield* tg(() => client.importSession(Redacted.value(session)))
  return client
})

export const saveSession = (client: TelegramClient) =>
  Effect.gen(function* () {
    const keychain = yield* Keychain
    const session = yield* tg(() => client.exportSession())
    yield* keychain.set(KC_SESSION, Redacted.make(session))
  })
