import { Console, Effect, Redacted } from "effect"
import { botApi, loadBotChatId, loadBotToken } from "./bot"

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

interface BotMessage {
  readonly message_id: number
  readonly chat: { readonly id: number }
  readonly from?: { readonly id: number }
  readonly text?: string
  readonly reply_to_message?: { readonly message_id: number }
}

interface BotCallbackQuery {
  readonly id: string
  readonly from: { readonly id: number }
  readonly data?: string
  readonly message?: BotMessage
}

interface BotUpdate {
  readonly update_id: number
  readonly message?: BotMessage
  readonly callback_query?: BotCallbackQuery
}

interface BotWebhookInfo {
  readonly url: string
}

export class AskError extends Error {
  readonly _tag = "AskError"
}

const parsePositiveInteger = (raw: string, option: string) => {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AskError(`${option} must be a positive safe integer`)
  }
  return value
}

const parseChoice = (raw: string): AskChoice => {
  const separator = raw.indexOf("=")
  if (separator <= 0 || separator === raw.length - 1) {
    throw new AskError("--option must use <value>=<label>")
  }
  const value = raw.slice(0, separator).trim()
  const label = raw.slice(separator + 1).trim()
  if (!value || !label) throw new AskError("--option value and label cannot be empty")
  if (value.length > 128) throw new AskError("--option value cannot exceed 128 characters")
  if (label.length > 64) throw new AskError("--option label cannot exceed 64 characters")
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
      if (raw === undefined) throw new AskError("--option requires <value>=<label>")
      choices.push(parseChoice(raw))
      index += 1
      continue
    }
    if (arg === "--timeout") {
      const raw = args[index + 1]
      if (raw === undefined) throw new AskError("--timeout requires a number of seconds")
      timeoutSeconds = parsePositiveInteger(raw, "--timeout")
      index += 1
      continue
    }
    if (arg === "--silent") {
      silent = true
      continue
    }
    if (arg.startsWith("--")) throw new AskError(`Unknown ask option: ${arg}`)
    question.push(arg)
  }

  const text = question.join(" ").trim()
  if (!text) throw new AskError("ask requires a question")
  if (text.length > MAX_QUESTION_LENGTH) {
    throw new AskError(`question cannot exceed ${MAX_QUESTION_LENGTH} characters`)
  }
  if (choices.length > MAX_CHOICES) {
    throw new AskError(`ask supports at most ${MAX_CHOICES} options`)
  }
  if (timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new AskError(`--timeout cannot exceed ${MAX_TIMEOUT_SECONDS} seconds`)
  }
  const duplicate = choices.find(
    (choice, index) => choices.findIndex((other) => other.value === choice.value) !== index,
  )
  if (duplicate) throw new AskError(`duplicate --option value: ${duplicate.value}`)

  return { question: text, choices, timeoutSeconds, silent }
}

const parseChatId = (value: Redacted.Redacted<string>) => {
  const chatId = Number(Redacted.value(value))
  if (!Number.isSafeInteger(chatId) || chatId === 0) {
    throw new AskError("Configured Telegram bot chat ID is invalid")
  }
  return chatId
}

const maxUpdateId = (updates: ReadonlyArray<BotUpdate>) =>
  updates.reduce<number | undefined>(
    (highest, update) => highest === undefined || update.update_id > highest
      ? update.update_id
      : highest,
    undefined,
  )

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
  const index = Number(callback.data.slice(prefix.length))
  if (!Number.isSafeInteger(index)) return undefined
  const choice = expected.choices[index]
  if (!choice) return undefined
  return { answer: choice.value, callbackQueryId: callback.id }
}

const ignoreBotFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catchAll(() => Effect.void))

export const askViaTelegram = (options: AskOptions) =>
  Effect.gen(function* () {
    const token = yield* loadBotToken
    if (!token) {
      return yield* Effect.fail(
        new AskError("Telegram bot is not configured. Run `bun run buddytg bot login` first."),
      )
    }
    const storedChatId = yield* loadBotChatId
    if (!storedChatId) {
      return yield* Effect.fail(
        new AskError(
          "Telegram bot chat is not configured. Run `bun run buddytg notify \"Ready\"` once.",
        ),
      )
    }
    const chatId = parseChatId(storedChatId)

    const webhook = yield* botApi<BotWebhookInfo>(token, "getWebhookInfo", {})
    if (typeof webhook?.url !== "string") {
      return yield* Effect.fail(new AskError("Telegram returned invalid webhook information"))
    }
    if (webhook.url) {
      return yield* Effect.fail(
        new AskError(
          "This bot has an outgoing Telegram webhook. `buddytg ask` uses getUpdates; "
          + "remove the webhook or configure a separate bot.",
        ),
      )
    }

    const pending = yield* botApi<ReadonlyArray<BotUpdate>>(token, "getUpdates", {
      offset: -1,
      limit: 1,
      timeout: 0,
      allowed_updates: ["message", "callback_query"],
    })
    if (!Array.isArray(pending)) {
      return yield* Effect.fail(new AskError("Telegram returned an invalid updates response"))
    }
    const highestPendingId = maxUpdateId(pending)
    let offset = highestPendingId === undefined ? undefined : highestPendingId + 1

    const nonce = crypto.randomUUID().replaceAll("-", "").slice(0, 16)
    const replyMarkup = options.choices.length > 0
      ? makeInlineKeyboard(nonce, options.choices)
      : { force_reply: true, selective: true, input_field_placeholder: "Reply to BuddyTG…" }

    const promptMessage = yield* botApi<BotMessage>(token, "sendMessage", {
      chat_id: chatId,
      text: options.question,
      reply_markup: replyMarkup,
      ...(options.silent ? { disable_notification: true } : {}),
    })
    if (!Number.isSafeInteger(promptMessage?.message_id)) {
      return yield* Effect.fail(new AskError("Telegram returned an invalid prompt message"))
    }

    yield* Console.error("Waiting for a Telegram response…")
    const deadline = Date.now() + options.timeoutSeconds * 1_000
    while (Date.now() < deadline) {
      const remainingSeconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1_000))
      const updates = yield* botApi<ReadonlyArray<BotUpdate>>(token, "getUpdates", {
        ...(offset === undefined ? {} : { offset }),
        limit: 100,
        timeout: Math.min(30, remainingSeconds),
        allowed_updates: ["message", "callback_query"],
      })
      if (!Array.isArray(updates)) {
        return yield* Effect.fail(new AskError("Telegram returned an invalid updates response"))
      }

      for (const update of updates) {
        if (!Number.isSafeInteger(update?.update_id)) continue
        offset = Math.max(offset ?? 0, update.update_id + 1)
        const match = matchAskUpdate(update, {
          chatId,
          promptMessageId: promptMessage.message_id,
          nonce,
          choices: options.choices,
        })
        if (!match) continue

        if (match.callbackQueryId) {
          yield* ignoreBotFailure(
            botApi(token, "answerCallbackQuery", {
              callback_query_id: match.callbackQueryId,
              text: "Response received",
            }),
          )
        }
        if (options.choices.length > 0) {
          yield* ignoreBotFailure(
            botApi(token, "editMessageReplyMarkup", {
              chat_id: chatId,
              message_id: promptMessage.message_id,
              reply_markup: { inline_keyboard: [] },
            }),
          )
        }
        return match.answer
      }
    }

    if (options.choices.length > 0) {
      yield* ignoreBotFailure(
        botApi(token, "editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: promptMessage.message_id,
          reply_markup: { inline_keyboard: [] },
        }),
      )
    }
    return yield* Effect.fail(
      new AskError(`Timed out after ${options.timeoutSeconds} seconds waiting for Telegram`),
    )
  })
