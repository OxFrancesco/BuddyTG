#!/usr/bin/env bun
import { SentCode } from "@mtcute/core"
import { Config, Console, Effect, Option, Redacted, Schema } from "effect"
import qrcode from "qrcode-terminal"
import { askViaTelegram, parseAskArgs } from "./ask"
import { exportBookmarks } from "./bookmarks"
import {
  botApi,
  BotMessage,
  BotUser,
  decodeChatId,
  ensureBotChatId,
  KC_BOT_TOKEN,
  KC_CHAT_ID,
  loadBotChatId,
  loadBotToken,
} from "./bot"
import { collectChatRows, parseChatsArgs, type ChatsOptions } from "./chats"
import { downloadFileCommand, sendFileCommand } from "./file-commands"
import { escapeTerminalText, parseFileCommand } from "./file-transfer"
import { history, parseHistoryArgs, parseReplyArgs, parseSearchArgs, parseUnreadArgs, reply, search, unread } from "./messages"
import { Keychain } from "./keychain"
import { holdSessionLock } from "./lock"
import { KC_LOGIN_CLIENT_ID, KC_LOGIN_CLIENT_SECRET, KC_MCP_SECRET, runHttp, runStdio } from "./mcp/serve"
import { resolveSendTarget } from "./peer-target"
import {
  decodePermissionHookInput,
  formatPermissionQuestion,
  formatTooLongNotice,
  MAX_PERMISSION_QUESTION_LENGTH,
  permissionDecisionFor,
} from "./permission-hook"
import { prompt, promptSecret } from "./prompt"
import { runMain } from "./run-main"
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

class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String,
}) {}

const usage = `BuddyTG — local Telegram automation and safe transfers

Usage:
  buddytg login                  Log in by scanning a QR code from the Telegram app (default)
  buddytg login --phone          Log in with phone number + code instead
  buddytg send <peer> <message>  Send a message ("me", @username, phone number,
                                 chat/group ID from \`buddytg chats\`, or t.me link)
  buddytg reply <peer> <message-id> <message>
                                 Reply to one message (fails if it no longer exists)
  buddytg history <peer>         Print recent messages as JSON lines, oldest first
     --limit <n>            Messages to read (default: 20; max: 100)
     --before <message-id>  Only messages older than this one, for paging
  buddytg search <query>         Search messages in all chats, as JSON lines
     --chat <peer>          Search one chat only
     --limit <n>            Max results (default: 20; max: 50)
  buddytg unread                 List chats with unread messages among the 500 most recent, as JSON lines
     --limit <n>            Max chats (default: 20; max: 100)
     --skip-archived        Leave out archived chats
  buddytg file send <peer> <path>  Send one local file after exact recipient confirmation
     --caption <text>        Add a caption
     --as <document|photo>   Preserve exact bytes (default), or send a validated native photo
     --confirm-to <id>       Non-interactive confirmation; must match the resolved recipient ID
     --confirm-telegram      Ask for approval in Telegram (via your bot) instead of the terminal
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
  buddytg mcp                    Run a stateless MCP server on stdio (protocol 2026-07-28)
  buddytg mcp http               Run it over Streamable HTTP with Log in with Telegram
     --port <n>               Listen port (default: 8790)
     --host <addr>            Listen address (default: 127.0.0.1)
     --allow-read             Also expose history, search and unread (off by default over HTTP)
     --url <origin>           Public origin behind a tunnel, e.g. https://buddytg.example.com
  buddytg mcp setup              Store the Login Widget client secret from @BotFather
  buddytg mcp revoke             Rotate the MCP signing secret, revoking every client and token
  buddytg whoami                 Show the currently logged-in account
  buddytg logout                 Log out and remove all stored secrets

Setup:
  Get your api_id/api_hash from https://my.telegram.org/apps
  (asked once during login and stored in the local secret store, or set TG_API_ID / TG_API_HASH)
  Linux uses WebSocket MTProto by default (set BUDDYTG_TRANSPORT=tcp to force TCP)`

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Pure argv parsers throw; their messages become the CLI error. */
const parseArgs = <A>(parse: () => A) =>
  Effect.try({ try: parse, catch: (error) => new UsageError({ message: messageOf(error) }) })

/**
 * The stored bot chat ID is the approval recipient and the MCP sign-in allowlist.
 * It belongs to one account, so a login as someone else must not inherit it.
 */
const forgetPreviousAccount = Effect.fn("forgetPreviousAccount")(function* (userId: number) {
  const keychain = yield* Keychain
  const stored = yield* keychain.get(KC_CHAT_ID)
  if (stored && Redacted.value(stored).trim() !== String(userId)) {
    yield* keychain.delete(KC_CHAT_ID)
    yield* keychain.delete(KC_MCP_SECRET)
    yield* Console.log(
      [
        "This is a different account than before: the stored bot chat ID and MCP secret were removed.",
        "Run `buddytg notify \"Ready\"` to link the bot to this account, and restart `buddytg mcp http` if it is running.",
        "The stored bot token was kept. If that bot belongs to the previous account, run `buddytg bot login` with your own.",
      ].join("\n"),
    )
  }
  const chatEnv = yield* Config.option(Config.String("TG_BOT_CHAT_ID"))
  if (Option.isSome(chatEnv) && chatEnv.value.trim() && chatEnv.value.trim() !== String(userId)) {
    yield* Console.error("Warning: TG_BOT_CHAT_ID in the environment belongs to another account.")
  }
  const allowedEnv = yield* Config.option(Config.String("BUDDYTG_MCP_ALLOWED_IDS"))
  if (Option.isSome(allowedEnv) && !allowedEnv.value.split(",").map((id) => id.trim()).includes(String(userId))) {
    yield* Console.error("Warning: BUDDYTG_MCP_ALLOWED_IDS in the environment does not include this account.")
  }
})

const loginWithQr = (client: import("@mtcute/bun").TelegramClient) =>
  tg((signal) =>
    client.signInQr({
      abortSignal: signal,
      onUrlUpdated: (url) => {
        // re-render in place whenever Telegram rotates the login token
        console.clear()
        console.log("Scan with Telegram: Settings -> Devices -> Link Desktop Device\n")
        qrcode.generate(url, { small: true })
      },
      onQrScanned: () => console.log("QR scanned, finishing up..."),
      password: () =>
        Effect.runPromise(promptSecret("2FA password: ").pipe(Effect.map(Redacted.value)), { signal }),
      invalidPasswordCallback: () => {
        console.log("Invalid password, try again.")
      },
    }),
  )

const loginWithPhone = Effect.fn("loginWithPhone")(function* (client: import("@mtcute/bun").TelegramClient) {
  const phone = (yield* prompt("Phone (international format, e.g. +39...): ")).trim()
  const sent = yield* tg(() => client.sendCode({ phone }))
  if (!(sent instanceof SentCode)) return sent // already logged in

  const code = (yield* prompt("Code from Telegram: ")).trim()
  return yield* tg(() =>
    client.signIn({ phone, phoneCodeHash: sent.phoneCodeHash, phoneCode: code }),
  ).pipe(
    Effect.catchIf(
      (error) => error.rpcText === "SESSION_PASSWORD_NEEDED",
      () =>
        Effect.gen(function* () {
          const hint = yield* tg(() => client.getPasswordHint())
          const pw = yield* promptSecret(`2FA password${hint ? ` (hint: ${hint})` : ""}: `)
          return yield* tg(() => client.checkPassword(Redacted.value(pw)))
        }),
    ),
  )
})

const login = Effect.fn("login")(function* (usePhone: boolean) {
  const keychain = yield* Keychain

  // 1. API credentials (the "app" identity)
  let creds = yield* loadApiCredentials
  if (!creds) {
    yield* Console.log("Get your credentials from https://my.telegram.org/apps")
    const apiId = Number((yield* prompt("api_id: ")).trim())
    const apiHash = Redacted.value(yield* promptSecret("api_hash: ")).trim()
    if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash) {
      return yield* new UsageError({ message: "invalid api_id / api_hash" })
    }
    creds = { apiId, apiHash: Redacted.make(apiHash) }
    yield* keychain.set(KC_API_ID, Redacted.make(String(apiId)))
    yield* keychain.set(KC_API_HASH, creds.apiHash)
  }

  const client = yield* makeClient(creds)

  // 2. Login primitives: signInQr (default) or sendCode -> signIn -> checkPassword
  const user = usePhone ? yield* loginWithPhone(client) : yield* loginWithQr(client)

  // 3. Persist the session securely
  yield* saveSession(client)
  yield* forgetPreviousAccount(user.id)
  yield* Console.log(
    `Logged in as ${escapeTerminalText(user.displayName)} (@${escapeTerminalText(user.username ?? "—")}). Session saved to the local secret store.`,
  )
}, Effect.scoped)

const send = Effect.fn("send")(function* (peer: string, message: string) {
  const client = yield* makeAuthedClient
  const resolved = yield* tg(() => resolveSendTarget(client, peer))
  const msg = yield* tg(() => client.sendText(resolved, message))
  yield* saveSession(client)
  yield* Console.log(`Sent (message id ${msg.id}).`)
}, Effect.scoped)

const chats = Effect.fn("chats")(function* (opts: ChatsOptions) {
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
    yield* Console.log(opts.query ? `No chats matching "${escapeTerminalText(opts.query)}".` : "No chats found.")
  } else {
    const idWidth = Math.max(...rows.map((row) => String(row.id).length))
    const typeWidth = Math.max(...rows.map((row) => row.type.length))
    for (const row of rows) {
      // Names and usernames are chosen by other Telegram users.
      const handle = row.username ? ` (@${escapeTerminalText(row.username)})` : ""
      yield* Console.log(
        `${String(row.id).padStart(idWidth)}  ${row.type.padEnd(typeWidth)}  ${escapeTerminalText(row.name)}${handle}`,
      )
    }
    yield* Console.log(`\n${rows.length} chat(s). Send with: buddytg send <id> "message"`)
  }
  yield* saveSession(client)
}, Effect.scoped)

const botLogin = Effect.gen(function* () {
  const keychain = yield* Keychain
  yield* Console.log(
    "Create a bot with @BotFather (https://t.me/BotFather):\n" +
      "  1. Send /newbot and follow the steps\n" +
      "  2. Copy the token BotFather gives you\n" +
      "  3. IMPORTANT: open your new bot's chat and send it /start\n",
  )
  const token = Redacted.make(Redacted.value(yield* promptSecret("Bot token: ")).trim())
  const me = yield* botApi(token, "getMe", {}, BotUser) // validate before saving
  yield* keychain.set(KC_BOT_TOKEN, token)
  yield* ensureBotChatId
  yield* Console.log(`Bot @${escapeTerminalText(me.username ?? String(me.id))} saved to the local secret store.`)
  return token
})

const notify = Effect.fn("notify")(function* (
  message: string,
  opts: { parseMode?: "HTML" | "MarkdownV2"; silent?: boolean },
) {
  // 1. Bot token (one-time setup via `buddytg bot login`)
  let token = yield* loadBotToken
  if (!token) token = yield* botLogin

  // 2. Your chat id — reuse the logged-in user session if we don't have it yet
  const chatId = yield* decodeChatId(yield* ensureBotChatId)

  // 3. Send — rich text via Bot API parse modes (HTML / MarkdownV2)
  yield* botApi(token, "sendMessage", {
    chat_id: chatId,
    text: message,
    ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
    ...(opts.silent ? { disable_notification: true } : {}),
  }, BotMessage)
  yield* Console.log("Notification sent.")
})

const whoami = Effect.gen(function* () {
  const client = yield* makeAuthedClient
  const me = yield* tg(() => client.getMe())
  yield* Console.log(`${escapeTerminalText(me.displayName)} (@${escapeTerminalText(me.username ?? "—")}, id ${me.id})`)
}).pipe(Effect.scoped)

/** Plain notice with no buttons, for requests that cannot be answered from Telegram. */
const sendNotice = Effect.fn("sendNotice")(function* (text: string) {
  const token = yield* loadBotToken
  const stored = yield* loadBotChatId
  if (!token || !stored) return
  yield* botApi(token, "sendMessage", { chat_id: yield* decodeChatId(stored), text }, BotMessage, { timeoutMs: 15_000 })
})

/**
 * stdout carries only the decision JSON. No output and exit 0 means "no decision",
 * so the agent falls back to its local permission dialog.
 */
const permissionHook = Effect.gen(function* () {
  const rawInput = yield* Effect.promise(() => Bun.stdin.text())
  const input = yield* decodePermissionHookInput(rawInput).pipe(
    Effect.mapError((error) => new UsageError({ message: error.message })),
  )
  const question = formatPermissionQuestion(input)
  if (question.length > MAX_PERMISSION_QUESTION_LENGTH) {
    yield* sendNotice(formatTooLongNotice(input, question.length)).pipe(Effect.ignore)
    yield* Console.error("Permission request is too long to review in Telegram; answer it locally.")
    return
  }
  const answer = yield* askViaTelegram({
    question,
    choices: [
      { value: "allow", label: "Allow once" },
      { value: "deny", label: "Deny" },
    ],
    timeoutSeconds: 540,
    silent: false,
  })
  const decision = permissionDecisionFor(answer)
  if (!decision) return yield* new UsageError({ message: "Unknown Telegram approval response" })
  yield* Console.log(JSON.stringify(decision))
})

const mcpSetup = Effect.gen(function* () {
  const keychain = yield* Keychain
  yield* Console.log(
    "In @BotFather open your bot, then Bot Settings → Login Widget:\n" +
      "  1. Add the two Allowed URLs printed by `buddytg mcp http`\n" +
      "  2. Copy the Client ID and Client Secret shown there\n",
  )
  const stored = yield* keychain.get(KC_LOGIN_CLIENT_ID)
  const current = stored ? Redacted.value(stored) : undefined
  const clientId = (yield* prompt(current ? `Client ID [${current}]: ` : "Client ID: ")).trim() || current || ""
  if (!/^[1-9][0-9]*$/.test(clientId)) return yield* new UsageError({ message: "Client ID is the bot's numeric ID" })
  const clientSecret = Redacted.value(yield* promptSecret("Client Secret: ")).trim()
  if (!clientSecret) return yield* new UsageError({ message: "Client Secret cannot be empty" })
  yield* keychain.set(KC_LOGIN_CLIENT_ID, Redacted.make(clientId))
  yield* keychain.set(KC_LOGIN_CLIENT_SECRET, Redacted.make(clientSecret))
  yield* Console.log("Log in with Telegram saved to the local secret store.")
})

const mcpRevoke = Effect.gen(function* () {
  // The server prefers the environment, so deleting the stored copy would revoke nothing.
  const env = yield* Config.option(Config.Redacted("BUDDYTG_MCP_SECRET"))
  if (Option.isSome(env) && Redacted.value(env.value).trim()) {
    return yield* new UsageError({
      message: "BUDDYTG_MCP_SECRET is set in the environment and takes priority. Rotate it where it is defined (for example in Doppler), then restart `buddytg mcp http`.",
    })
  }
  yield* (yield* Keychain).delete(KC_MCP_SECRET)
  yield* Console.log("MCP secret removed. Restart `buddytg mcp http`; every client must sign in again.")
})

const parseHttpOptions = (tokens: ReadonlyArray<string>) => {
  const options: { host: string; port: number; url?: string; allowRead: boolean } = { host: "127.0.0.1", port: 8790, allowRead: false }
  for (let index = 0; index < tokens.length; index += 1) {
    const flag = tokens[index]
    if (flag === "--allow-read") {
      options.allowRead = true
      continue
    }
    const value = tokens[index + 1]
    index += 1
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`)
    if (flag === "--port") {
      options.port = Number(value)
      if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("--port must be 1-65535")
    } else if (flag === "--host") options.host = value
    else if (flag === "--url") options.url = value
    else throw new Error(`Unknown mcp http option: ${flag}`)
  }
  return options
}

const ENV_SECRETS = ["TG_API_ID", "TG_API_HASH", "TG_BOT_TOKEN", "TG_BOT_CHAT_ID", "BUDDYTG_MCP_SECRET", "TG_LOGIN_CLIENT_SECRET"]

const logout = Effect.gen(function* () {
  const keychain = yield* Keychain
  // Held across the deletes, so a concurrent command cannot write the session back.
  yield* holdSessionLock
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
    keychain.delete(KC_MCP_SECRET),
    keychain.delete(KC_LOGIN_CLIENT_ID),
    keychain.delete(KC_LOGIN_CLIENT_SECRET),
  ])
  yield* Console.log("Logged out. Stored secrets removed.")
  const fromEnv = ENV_SECRETS.filter((name) => process.env[name]?.trim())
  if (fromEnv.length > 0) {
    yield* Console.error(`Still set in the environment, and used before the secret store: ${fromEnv.join(", ")}`)
  }
}).pipe(Effect.scoped)

const [cmd, ...rest] = process.argv.slice(2)
const flags = rest.filter((a) => a.startsWith("--"))
const args = rest.filter((a) => !a.startsWith("--"))

// Help goes to stdout when asked for; after a bad command it goes to stderr, since stdout is data.
const showUsage = cmd
  ? Console.error(usage).pipe(Effect.andThen(Effect.fail(new UsageError({ message: `Unknown command: ${cmd}` }))))
  : Console.log(usage)

const command = (): Effect.Effect<unknown, unknown, Keychain> => {
  switch (cmd) {
    case "login":
      return login(flags.includes("--phone"))
    case "send":
      if (rest.length >= 2) return send(rest[0]!, rest.slice(1).join(" "))
      break
    case "reply":
      return parseArgs(() => parseReplyArgs(rest)).pipe(Effect.flatMap(reply))
    case "history":
      return parseArgs(() => parseHistoryArgs(rest)).pipe(Effect.flatMap(history))
    case "search":
      return parseArgs(() => parseSearchArgs(rest)).pipe(Effect.flatMap(search))
    case "unread":
      return parseArgs(() => parseUnreadArgs(rest)).pipe(Effect.flatMap(unread))
    case "file":
      return parseArgs(() => parseFileCommand(rest)).pipe(
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
      return parseArgs(() => parseAskArgs(rest)).pipe(
        Effect.flatMap(askViaTelegram),
        Effect.flatMap((answer) => Console.log(answer)),
      )
    case "hook":
      if (args[0] === "permission") return permissionHook
      break
    case "chats":
      return parseArgs(() => parseChatsArgs(rest)).pipe(Effect.flatMap(chats))
    case "bookmarks":
      return exportBookmarks(args[0], flags.includes("--download-media"))
    case "mcp":
      if (rest.length === 0) return runStdio()
      if (rest[0] === "http") {
        return parseArgs(() => parseHttpOptions(rest.slice(1))).pipe(Effect.flatMap((options) => runHttp(options)))
      }
      if (rest[0] === "setup" && rest.length === 1) return mcpSetup
      if (rest[0] === "revoke" && rest.length === 1) return mcpRevoke
      break
    case "whoami":
      return whoami
    case "logout":
      return logout
  }
  return showUsage
}

runMain(Effect.suspend(command).pipe(Effect.provide(Keychain.layer)))
