#!/usr/bin/env bun
import { SentCode } from "@mtcute/core"
import { md } from "@mtcute/markdown-parser"
import { Console, Effect, Redacted } from "effect"
import qrcode from "qrcode-terminal"
import { askViaTelegram, parseAskArgs } from "./ask"
import {
  botApi,
  ensureBotChatId,
  KC_BOT_TOKEN,
  KC_CHAT_ID,
  loadBotToken,
} from "./bot"
import { collectChatRows, parseChatsArgs, type ChatsOptions } from "./chats"
import { downloadFileCommand, sendFileCommand } from "./file-commands"
import { parseFileCommand } from "./file-transfer"
import { Keychain, KeychainLive } from "./keychain"
import { resolveSendTarget } from "./peer-target"
import {
  formatPermissionQuestion,
  parsePermissionHookInput,
  permissionDecisionFor,
} from "./permission-hook"
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

const usage = `BuddyTG — local Telegram automation and safe transfers

Usage:
  buddytg login                  Log in by scanning a QR code from the Telegram app (default)
  buddytg login --phone          Log in with phone number + code instead
  buddytg send <peer> <message>  Send a message ("me", @username, phone number,
                                 chat/group ID from \`buddytg chats\`, or t.me link)
  buddytg file send <peer> <path>  Send one local file after exact recipient confirmation
     --caption <text>        Add a caption
     --as <document|photo>   Preserve exact bytes (default), or send a validated native photo
     --confirm-to <id>       Non-interactive confirmation; must match the resolved recipient ID
  buddytg file download <peer> <message-id> --to <directory>
                                 Download one message attachment without overwriting
  buddytg file download <t.me-message-link> --to <directory>
                                 Download directly from a copied Telegram message link
     --name <filename>       Choose a plain destination filename
     --max-size <size>       Download ceiling (default: 2GiB; max: 4000MiB)
     --confirm-from <id>     Non-interactive confirmation; must match the resolved source ID
  buddytg chats [query]          List your chats/groups/channels with their IDs
     --limit <n>            Max matching dialogs to list (default: 50)
     --archived             Include archived chats
  buddytg bookmarks [file]       Export all Saved Messages to a markdown file (default: saved-messages.md)
     --download-media       Also download media files next to the export
  buddytg bot login              Set up your notification bot (token from @BotFather)
  buddytg notify <message>       Notify yourself via your own bot (real push notification)
     --html                 Parse message as HTML (<b>, <i>, <code>, <a href>, <tg-spoiler>...)
     --markdown             Parse message as MarkdownV2 (*bold*, _italic_, \`code\`, [link](url)...)
     --silent               Deliver without sound
  buddytg ask <question>         Ask in Telegram and print the correlated reply to stdout
     --option <value>=<label>  Add an inline response button (repeatable, max 8)
     --timeout <seconds>      Wait up to this many seconds (default: 540; max: 86400)
     --silent                 Deliver the question without sound
  buddytg hook permission        Handle a Codex/Claude PermissionRequest via Telegram
  buddytg whoami                 Show the currently logged-in account
  buddytg logout                 Log out and remove all secrets from the Keychain

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
    const resolved = yield* tg(() => resolveSendTarget(client, peer))
    const msg = yield* tg(() => client.sendText(resolved, message))
    yield* saveSession(client)
    yield* Console.log(`Sent (message id ${msg.id}).`)
  }).pipe(Effect.scoped)

const chats = (opts: ChatsOptions) =>
  Effect.gen(function* () {
    const client = yield* makeAuthedClient
    const rows = yield* tg(() =>
      collectChatRows(
        client.iterDialogs({
          ...(opts.query === undefined ? { limit: opts.limit } : {}),
          archived: opts.archived ? "keep" : "exclude",
        }),
        opts,
      ),
    )

    if (rows.length === 0) {
      yield* Console.log(opts.query ? `No chats matching "${opts.query}".` : "No chats found.")
    } else {
      const idWidth = Math.max(...rows.map((row) => String(row.id).length))
      const typeWidth = Math.max(...rows.map((row) => row.type.length))
      for (const row of rows) {
        const handle = row.username ? ` (@${row.username})` : ""
        yield* Console.log(
          `${String(row.id).padStart(idWidth)}  ${row.type.padEnd(typeWidth)}  ${row.name}${handle}`,
        )
      }
      yield* Console.log(`\n${rows.length} chat(s). Send with: buddytg send <id> "message"`)
    }
    yield* saveSession(client)
  }).pipe(Effect.scoped)

const bookmarks = (file = "saved-messages.md", downloadMedia = false) =>
  Effect.gen(function* () {
    const client = yield* makeAuthedClient
    const messages = yield* tg(async () => {
      const all = []
      for await (const msg of client.iterHistory("me")) all.push(msg)
      return all.reverse() // oldest first
    })

    const mediaDir = file.replace(/\.md$/, "") + "-media"
    const lines = ["# Saved Messages", ""]
    for (const msg of messages) {
      const date = msg.date.toISOString().replace("T", " ").slice(0, 16)
      lines.push(`## ${date} (id ${msg.id}) <a id="id-${msg.id}"></a>`, "")

      // reply hierarchy: link back to the quoted message
      const replyId = msg.replyToMessage?.id
      if (replyId != null) lines.push(`> ↩️ replying to [message ${replyId}](#id-${replyId})`, "")

      if (msg.forward) {
        const sender = msg.forward.sender
        const from =
          (typeof sender === "string" ? sender : sender?.displayName) ??
          msg.forward.fromChat()?.displayName ??
          "unknown"
        lines.push(`> Forwarded from: ${from}`, "")
      }

      // tags (Saved Messages tags are reactions under the hood)
      const tags = (msg.reactions?.reactions ?? [])
        .map((r) => (typeof r.emoji === "string" ? r.emoji : "[custom]"))
        .filter((e) => e !== "[custom]")
      if (tags.length > 0) lines.push(`Tags: ${tags.join(" ")}`, "")

      if (msg.media) {
        let marker = `*[media: ${msg.media.type}]*`
        if (downloadMedia && "fileId" in msg.media) {
          const media = msg.media as { fileName?: string | null; mimeType?: string }
          const ext =
            media.fileName?.match(/\.\w+$/)?.[0] ?? `.${media.mimeType?.split("/")[1] ?? "bin"}`
          const path = `${mediaDir}/${msg.id}-${msg.media.type}${ext}`
          const ok = yield* tg(() => client.downloadToFile(path, msg.media as never)).pipe(
            Effect.as(true),
            Effect.catchAll(() => Effect.succeed(false)),
          )
          if (ok) marker = `![media: ${msg.media.type}](${path})`
        }
        lines.push(marker, "")
      }

      // rich text: convert Telegram entities back to markdown
      if (msg.text) lines.push(md.unparse(msg.textWithEntities), "")
    }

    yield* saveSession(client)
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
  yield* ensureBotChatId
  yield* Console.log(`Bot @${(me as { username?: string }).username} saved to Keychain.`)
  return token
})

const notify = (message: string, opts: { parseMode?: "HTML" | "MarkdownV2"; silent?: boolean }) =>
  Effect.gen(function* () {
    // 1. Bot token (one-time setup via `buddytg bot login`)
    let token = yield* loadBotToken
    if (!token) token = yield* botLogin

    // 2. Your chat id — reuse the logged-in user session if we don't have it yet
    const chatId = yield* ensureBotChatId

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

const permissionHook = Effect.gen(function* () {
  const rawInput = yield* Effect.promise(() => Bun.stdin.text())
  const input = yield* Effect.try({
    try: () => parsePermissionHookInput(JSON.parse(rawInput)),
    catch: (error) => error instanceof Error ? error : new Error(String(error)),
  })
  const answer = yield* askViaTelegram({
    question: formatPermissionQuestion(input),
    choices: [
      { value: "allow", label: "Allow once" },
      { value: "deny", label: "Deny" },
    ],
    timeoutSeconds: 540,
    silent: false,
  })
  const decision = permissionDecisionFor(answer)
  if (!decision) return yield* Effect.fail(new Error("Unknown Telegram approval response"))
  yield* Console.log(JSON.stringify(decision))
})

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

const program = (() => {
  switch (cmd) {
    case "login":
      return login(flags.includes("--phone"))
    case "send":
      if (rest.length >= 2) return send(rest[0]!, rest.slice(1).join(" "))
      break
    case "file":
      return Effect.try({
        try: () => parseFileCommand(rest),
        catch: (error) => error instanceof Error ? error : new Error(String(error)),
      }).pipe(
        Effect.flatMap((fileCommand) =>
          fileCommand.action === "send" ? sendFileCommand(fileCommand) : downloadFileCommand(fileCommand),
        ),
      )
    case "bot":
      if (args[0] === "login") return botLogin
      break
    case "notify":
      if (args.length >= 1) {
        return notify(args.join(" "), {
          parseMode:
            flags.includes("--html") ? "HTML"
            : flags.includes("--markdown") ? "MarkdownV2"
            : undefined,
          silent: flags.includes("--silent"),
        })
      }
      break
    case "ask":
      return Effect.try({
        try: () => parseAskArgs(rest),
        catch: (error) => error instanceof Error ? error : new Error(String(error)),
      }).pipe(
        Effect.flatMap(askViaTelegram),
        Effect.flatMap((answer) => Console.log(answer)),
      )
    case "hook":
      if (args[0] === "permission") return permissionHook
      break
    case "chats":
      return Effect.try({
        try: () => parseChatsArgs(rest),
        catch: (error) => error instanceof Error ? error : new Error(String(error)),
      }).pipe(Effect.flatMap(chats))
    case "bookmarks":
      return bookmarks(args[0], flags.includes("--download-media"))
    case "whoami":
      return whoami
    case "logout":
      return logout
  }

  return Console.log(usage).pipe(Effect.andThen(Effect.sync(() => process.exit(cmd ? 1 : 0))))
})()

Effect.runPromise(program.pipe(Effect.provide(KeychainLive))).then(
  () => process.exit(0),
  (err) => {
    console.error(`Error: ${err?.message ?? err}`)
    process.exit(1)
  },
)
