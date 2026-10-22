import { Clock, Console, Effect, Option, Schema } from "effect"
import { botApi, BotMessage, BotUpdate, decodeChatId, loadBotChatId, loadBotToken, WebhookInfo } from "./bot"

const MAX_QUESTION_LENGTH = 4_000
const MAX_CHOICES = 8
const MAX_TIMEOUT_SECONDS = 86_400
const DEFAULT_TIMEOUT_SECONDS = 540
const CALLBACK_PREFIX = "btg"

export interface AskChoice {
  readonly value: string
  readonly label: string
}

export interface AskOptions {
  readonly question: string
  readonly choices: ReadonlyArray<AskChoice>
  readonly timeoutSeconds: number
  readonly silent: boolean
}

export class AskError extends Schema.TaggedError<AskError>()("AskError", {
  message: Schema.String,
}) {}

const askError = (message: string) => new AskError({ message })

const parsePositiveInteger = (raw: string, option: string) => {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw askError(`${option} must be a positive safe integer`)
  }
  return value
}

const parseChoice = (raw: string): AskChoice => {
  const separator = raw.indexOf("=")
  if (separator <= 0 || separator === raw.length - 1) {
    throw askError("--option must use <value>=<label>")
  }
  const value = raw.slice(0, separator).trim()
  const label = raw.slice(separator + 1).trim()
  if (!value || !label) throw askError("--option value and label cannot be empty")
  if (value.length > 128) throw askError("--option value cannot exceed 128 characters")
  if (label.length > 64) throw askError("--option label cannot exceed 64 characters")
  return { value, label }
}

export const parseAskArgs = (args: ReadonlyArray<string>): AskOptions => {
  const question: string[] = []
  const choices: AskChoice[] = []
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS
  let silent = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "--option") {
      const raw = args[index + 1]
      if (raw === undefined) throw askError("--option requires <value>=<label>")
      choices.push(parseChoice(raw))
      index += 1
      continue
    }
    if (arg === "--timeout") {
      const raw = args[index + 1]
      if (raw === undefined) throw askError("--timeout requires a number of seconds")
      timeoutSeconds = parsePositiveInteger(raw, "--timeout")
      index += 1
      continue
    }
    if (arg === "--silent") {
      silent = true
      continue
    }
    if (arg.startsWith("--")) throw askError(`Unknown ask option: ${arg}`)
    question.push(arg)
  }

  const text = question.join(" ").trim()
  if (!text) throw askError("ask requires a question")
  if (text.length > MAX_QUESTION_LENGTH) {
    throw askError(`question cannot exceed ${MAX_QUESTION_LENGTH} characters`)
  }
  if (choices.length > MAX_CHOICES) {
    throw askError(`ask supports at most ${MAX_CHOICES} options`)
  }
  if (timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw askError(`--timeout cannot exceed ${MAX_TIMEOUT_SECONDS} seconds`)
  }
  const duplicate = choices.find(
    (choice, index) => choices.findIndex((other) => other.value === choice.value) !== index,
  )
  if (duplicate) throw askError(`duplicate --option value: ${duplicate.value}`)

  return { question: text, choices, timeoutSeconds, silent }
}

const UpdateId = Schema.Struct({ update_id: Schema.Int })
const decodeUpdateId = Schema.decodeUnknownOption(UpdateId)
const decodeUpdate = Schema.decodeUnknownOption(BotUpdate)
const Updates = Schema.Array(Schema.Unknown)

const maxUpdateId = (updates: ReadonlyArray<unknown>) =>
  updates.reduce<number | undefined>((highest, raw) => {
    const id = decodeUpdateId(raw)
    if (Option.isNone(id)) return highest
    return highest === undefined || id.value.update_id > highest ? id.value.update_id : highest
  }, undefined)

const callbackData = (nonce: string, index: number) =>
  `${CALLBACK_PREFIX}:${nonce}:${index}`

const makeInlineKeyboard = (nonce: string, choices: ReadonlyArray<AskChoice>) => {
  const buttons = choices.map((choice, index) => ({
    text: choice.label,
    callback_data: callbackData(nonce, index),
  }))
  const rows: Array<typeof buttons> = []
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(buttons.slice(index, index + 2))
  }
  return { inline_keyboard: rows }
}

export const matchAskUpdate = (
  update: BotUpdate,
  expected: {
    readonly chatId: number
    readonly promptMessageId: number
    readonly nonce: string
    readonly choices: ReadonlyArray<AskChoice>
  },
): { readonly answer: string; readonly callbackQueryId?: string } | undefined => {
  const message = update.message
  if (
    message?.chat.id === expected.chatId
    && message.from?.id === expected.chatId
    && message.reply_to_message?.message_id === expected.promptMessageId
  ) {
    const answer = message.text?.trim()
    if (answer) return { answer }
  }

  const callback = update.callback_query
  if (
    callback?.from.id !== expected.chatId
    || callback.message?.chat.id !== expected.chatId
    || callback.message.message_id !== expected.promptMessageId
  ) {
    return undefined
  }
  const prefix = `${CALLBACK_PREFIX}:${expected.nonce}:`
  if (!callback.data?.startsWith(prefix)) return undefined
  const suffix = callback.data.slice(prefix.length)
  if (!/^[0-9]$/.test(suffix)) return undefined
  const index = Number(suffix)
  const choice = expected.choices[index]
  if (!choice) return undefined
  return { answer: choice.value, callbackQueryId: callback.id }
}

const POLL_SECONDS = 30
const REQUEST_TIMEOUT_MS = 15_000

export const askViaTelegram = Effect.fn("askViaTelegram")(function* (options: AskOptions) {
  const token = yield* loadBotToken
  if (!token) {
    return yield* askError("Telegram bot is not configured. Run `buddytg bot login` first.")
  }
  const storedChatId = yield* loadBotChatId
  if (!storedChatId) {
    return yield* askError("Telegram bot chat is not configured. Run `buddytg notify \"Ready\"` once.")
  }
  const chatId = yield* decodeChatId(storedChatId)

  const webhook = yield* botApi(token, "getWebhookInfo", {}, WebhookInfo, { timeoutMs: REQUEST_TIMEOUT_MS })
  if (webhook.url) {
    return yield* askError(
      "This bot has an outgoing Telegram webhook. `buddytg ask` uses getUpdates; "
        + "remove the webhook or configure a separate bot.",
    )
  }

  const pending = yield* botApi(token, "getUpdates", {
    offset: -1,
    limit: 1,
    timeout: 0,
    allowed_updates: ["message", "callback_query"],
  }, Updates, { timeoutMs: REQUEST_TIMEOUT_MS })
  const highestPendingId = maxUpdateId(pending)
  let offset = highestPendingId === undefined ? undefined : highestPendingId + 1

  // Not Effect's Random: the nonce must come from a CSPRNG.
  const nonce = crypto.randomUUID().replaceAll("-", "").slice(0, 16)
  const replyMarkup = options.choices.length > 0
    ? makeInlineKeyboard(nonce, options.choices)
    : { force_reply: true, selective: true, input_field_placeholder: "Reply to BuddyTG…" }

  // The release clears the buttons on every exit: answer, timeout, error or Ctrl+C.
  // Acquire cannot be interrupted, so it needs its own timeout.
  const promptMessage = yield* Effect.acquireRelease(
    botApi(token, "sendMessage", {
      chat_id: chatId,
      text: options.question,
      reply_markup: replyMarkup,
      // A link in the question must not add a preview card chosen by that site.
      link_preview_options: { is_disabled: true },
      ...(options.silent ? { disable_notification: true } : {}),
    }, BotMessage, { timeoutMs: REQUEST_TIMEOUT_MS }),
    (message) =>
      options.choices.length === 0
        ? Effect.void
        : botApi(token, "editMessageReplyMarkup", {
            chat_id: chatId,
            message_id: message.message_id,
            reply_markup: { inline_keyboard: [] },
          }, Schema.Unknown, { timeoutMs: 5_000 }).pipe(Effect.ignore),
  )

  yield* Console.error("Waiting for a Telegram response…")
  const deadline = (yield* Clock.currentTimeMillis) + options.timeoutSeconds * 1_000
  while ((yield* Clock.currentTimeMillis) < deadline) {
    const remainingSeconds = Math.max(1, Math.ceil((deadline - (yield* Clock.currentTimeMillis)) / 1_000))
    const timeout = Math.min(POLL_SECONDS, remainingSeconds)
    const updates = yield* botApi(token, "getUpdates", {
      ...(offset === undefined ? {} : { offset }),
      limit: 100,
      timeout,
      allowed_updates: ["message", "callback_query"],
    }, Updates, { timeoutMs: (timeout + 15) * 1_000 })

    // Decode one update at a time: a malformed update is skipped, not fatal.
    for (const raw of updates) {
      const id = decodeUpdateId(raw)
      if (Option.isNone(id)) continue
      offset = Math.max(offset ?? 0, id.value.update_id + 1)
      const update = decodeUpdate(raw)
      if (Option.isNone(update)) continue
      const match = matchAskUpdate(update.value, {
        chatId,
        promptMessageId: promptMessage.message_id,
        nonce,
        choices: options.choices,
      })
      if (!match) continue

      if (match.callbackQueryId) {
        yield* botApi(token, "answerCallbackQuery", {
          callback_query_id: match.callbackQueryId,
          text: "Response received",
        }, Schema.Unknown, { timeoutMs: 5_000 }).pipe(Effect.ignore)
      }
      return match.answer
    }
  }

  return yield* askError(`Timed out after ${options.timeoutSeconds} seconds waiting for Telegram`)
}, Effect.scoped)
