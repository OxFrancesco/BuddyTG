#!/usr/bin/env bun
import { SentCode } from "@mtcute/core"
import { Console, Effect, Redacted } from "effect"
import qrcode from "qrcode-terminal"
import { botApi, KC_BOT_TOKEN, KC_CHAT_ID, loadBotToken } from "./bot"
import { Keychain, KeychainLive } from "./keychain"
import { prompt, promptSecret } from "./prompt"
import {
  KC_API_HASH,
  KC_API_ID,
  KC_SESSION,
  loadApiCredentials,
  makeAuthedClient,
  makeClient,
  saveSession,
  tg,
} from "./telegram"

const usage = `tg-ping-ping — send Telegram messages as yourself

Usage:
  tg login                  Log in by scanning a QR code from the Telegram app (default)
  tg login --phone          Log in with phone number + code instead
  tg send <peer> <message>  Send a message ("me", @username, or phone number)
  tg bookmarks [file]       Export all Saved Messages to a markdown file (default: saved-messages.md)
  tg bot login              Set up your notification bot (token from @BotFather)
  tg notify <message>       Notify yourself via your own bot (real push notification)
     --html                 Parse message as HTML (<b>, <i>, <code>, <a href>, <tg-spoiler>...)
     --markdown             Parse message as MarkdownV2 (*bold*, _italic_, \`code\`, [link](url)...)
     --silent               Deliver without sound
  tg whoami                 Show the currently logged-in account
  tg logout                 Log out and remove all secrets from the Keychain

Setup:
  Get your api_id/api_hash from https://my.telegram.org/apps
  (asked once during login and stored in the Keychain, or set TG_API_ID / TG_API_HASH)`

const login = (usePhone: boolean) =>
  Effect.gen(function* () {
    const keychain = yield* Keychain

    // 1. API credentials (the "app" identity)
    let creds = yield* loadApiCredentials
    if (!creds) {
      yield* Console.log("Get your credentials from https://my.telegram.org/apps")
      const apiId = yield* prompt("api_id: ")
      const apiHash = yield* promptSecret("api_hash: ")
      creds = { apiId: Number(apiId.trim()), apiHash: Redacted.value(apiHash).trim() }
      if (!Number.isInteger(creds.apiId) || creds.apiId <= 0 || !creds.apiHash) {
        return yield* Effect.fail(new Error("invalid api_id / api_hash"))
      }
      yield* keychain.set(KC_API_ID, Redacted.make(String(creds.apiId)))
      yield* keychain.set(KC_API_HASH, Redacted.make(creds.apiHash))
    }

    const client = yield* makeClient(creds)

    // 2. Login primitives: signInQr (default) or sendCode -> signIn -> checkPassword
    const user = usePhone ? yield* loginWithPhone(client) : yield* loginWithQr(client)

    // 3. Persist the session securely
    yield* saveSession(client)
    yield* Console.log(`Logged in as ${user.displayName} (@${user.username ?? "—"}). Session saved to Keychain.`)
  }).pipe(Effect.scoped)

const loginWithQr = (client: import("@mtcute/bun").TelegramClient) =>
  tg(() =>
    client.signInQr({
      onUrlUpdated: (url) => {
        // re-render in place whenever Telegram rotates the login token
        console.clear()
        console.log("Scan with Telegram: Settings -> Devices -> Link Desktop Device\n")
        qrcode.generate(url, { small: true })
      },
      onQrScanned: () => console.log("QR scanned, finishing up..."),
      password: () =>
        Effect.runPromise(promptSecret("2FA password: ").pipe(Effect.map(Redacted.value))),
      invalidPasswordCallback: () => {
        console.log("Invalid password, try again.")
      },
    }),
  )

const loginWithPhone = (client: import("@mtcute/bun").TelegramClient) =>
  Effect.gen(function* () {
    const phone = (yield* prompt("Phone (international format, e.g. +39...): ")).trim()
    const sent = yield* tg(() => client.sendCode({ phone }))
    if (!(sent instanceof SentCode)) return sent // already logged in

    const code = (yield* prompt("Code from Telegram: ")).trim()
    return yield* tg(() =>
      client.signIn({ phone, phoneCodeHash: sent.phoneCodeHash, phoneCode: code }),
    ).pipe(
      Effect.catchIf(
        (e) => e.message.includes("SESSION_PASSWORD_NEEDED"),
        () =>
          Effect.gen(function* () {
            const hint = yield* tg(() => client.getPasswordHint())
            const pw = yield* promptSecret(`2FA password${hint ? ` (hint: ${hint})` : ""}: `)
            return yield* tg(() => client.checkPassword(Redacted.value(pw)))
          }),
      ),
    )
  })

const send = (peer: string, message: string) =>
  Effect.gen(function* () {
    const client = yield* makeAuthedClient
    const resolved = yield* tg(() => client.resolvePeer(peer))
    const msg = yield* tg(() => client.sendText(resolved, message))
    yield* saveSession(client)
    yield* Console.log(`Sent (message id ${msg.id}).`)
  }).pipe(Effect.scoped)

const bookmarks = (file = "saved-messages.md") =>
  Effect.gen(function* () {
    const client = yield* makeAuthedClient
    const messages = yield* tg(async () => {
      const all = []
      for await (const msg of client.iterHistory("me")) all.push(msg)
      return all.reverse() // oldest first
    })
    yield* saveSession(client)

    const lines = ["# Saved Messages", ""]
    for (const msg of messages) {
      const date = msg.date.toISOString().replace("T", " ").slice(0, 16)
      lines.push(`## ${date} (id ${msg.id})`, "")
      if (msg.forward) {
        const sender = msg.forward.sender
        const from =
          (typeof sender === "string" ? sender : sender?.displayName) ??
          msg.forward.fromChat()?.displayName ??
          "unknown"
        lines.push(`> Forwarded from: ${from}`, "")
      }
      if (msg.media) lines.push(`*[media: ${msg.media.type}]*`, "")
      if (msg.text) lines.push(msg.text, "")
    }

    yield* Effect.promise(() => Bun.write(file, lines.join("\n")))
    yield* Console.log(`Exported ${messages.length} saved message(s) to ${file}`)
  }).pipe(Effect.scoped)

const botLogin = Effect.gen(function* () {
  const keychain = yield* Keychain
  yield* Console.log(
    "Create a bot with @BotFather (https://t.me/BotFather):\n" +
      "  1. Send /newbot and follow the steps\n" +
      "  2. Copy the token BotFather gives you\n" +
      "  3. IMPORTANT: open your new bot's chat and send it /start\n",
  )
  const token = Redacted.make(Redacted.value(yield* promptSecret("Bot token: ")).trim())
  const me = yield* botApi(token, "getMe", {}) // validate before saving
  yield* keychain.set(KC_BOT_TOKEN, token)
  yield* Console.log(`Bot @${(me as { username?: string }).username} saved to Keychain.`)
  return token
})

const notify = (message: string, opts: { parseMode?: "HTML" | "MarkdownV2"; silent?: boolean }) =>
  Effect.gen(function* () {
    const keychain = yield* Keychain

    // 1. Bot token (one-time setup via `tg bot login`)
    let token = yield* loadBotToken
    if (!token) token = yield* botLogin

    // 2. Your chat id — reuse the logged-in user session if we don't have it yet
    let chatId = yield* keychain.get(KC_CHAT_ID)
    if (!chatId) {
      const id = yield* Effect.gen(function* () {
        const client = yield* makeAuthedClient
        const me = yield* tg(() => client.getMe())
        return String(me.id)
      }).pipe(Effect.scoped)
      chatId = Redacted.make(id)
      yield* keychain.set(KC_CHAT_ID, chatId)
    }

    // 3. Send — rich text via Bot API parse modes (HTML / MarkdownV2)
    yield* botApi(token, "sendMessage", {
      chat_id: Number(Redacted.value(chatId)),
      text: message,
      ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
      ...(opts.silent ? { disable_notification: true } : {}),
    })
    yield* Console.log("Notification sent.")
  })

const whoami = Effect.gen(function* () {
  const client = yield* makeAuthedClient
  const me = yield* tg(() => client.getMe())
  yield* Console.log(`${me.displayName} (@${me.username ?? "—"}, id ${me.id})`)
}).pipe(Effect.scoped)

const logout = Effect.gen(function* () {
  const keychain = yield* Keychain
  yield* Effect.gen(function* () {
    const client = yield* makeAuthedClient
    yield* tg(() => client.logOut())
  }).pipe(Effect.scoped, Effect.ignore)
  yield* Effect.all([
    keychain.delete(KC_SESSION),
    keychain.delete(KC_API_ID),
    keychain.delete(KC_API_HASH),
    keychain.delete(KC_BOT_TOKEN),
    keychain.delete(KC_CHAT_ID),
  ])
  yield* Console.log("Logged out. Keychain entries removed.")
})

const [cmd, ...rest] = process.argv.slice(2)
const flags = rest.filter((a) => a.startsWith("--"))
const args = rest.filter((a) => !a.startsWith("--"))

const program =
  cmd === "login" ? login(flags.includes("--phone"))
  : cmd === "send" && rest.length >= 2 ? send(rest[0]!, rest.slice(1).join(" "))
  : cmd === "bot" && args[0] === "login" ? botLogin
  : cmd === "notify" && args.length >= 1 ?
    notify(args.join(" "), {
      parseMode:
        flags.includes("--html") ? "HTML"
        : flags.includes("--markdown") ? "MarkdownV2"
        : undefined,
      silent: flags.includes("--silent"),
    })
  : cmd === "bookmarks" ? bookmarks(rest[0])
  : cmd === "whoami" ? whoami
  : cmd === "logout" ? logout
  : Console.log(usage).pipe(Effect.andThen(Effect.sync(() => process.exit(cmd ? 1 : 0))))

Effect.runPromise(program.pipe(Effect.provide(KeychainLive))).then(
  () => process.exit(0),
  (err) => {
    console.error(`Error: ${err?.message ?? err}`)
    process.exit(1)
  },
)
