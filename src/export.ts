import type { Dialog, ITelegramClient, RpcCallOptions, TakeoutSession, tl } from "@mtcute/core"
import { getHistory, iterDialogs } from "@mtcute/core/methods.js"
import { Console, Effect, Exit } from "effect"
import { constants } from "node:fs"
import { lstat, open, rename, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { ensurePrivateDirectory, escapeTerminalText } from "./file-transfer"
import { messageRecord, parsePositive, parseTokens, peerKind, safeJson, UNTRUSTED_HEADER } from "./messages"
import { boundedCleanup } from "./settled"
import { makeAuthedClient, saveSession, tg, TelegramError } from "./telegram"

export interface ExportOptions {
  readonly directory: string
  readonly limit: number | undefined
  readonly channels: boolean
}

export const parseExportArgs = (tokens: readonly string[]): ExportOptions => {
  const { values, positional } = parseTokens(tokens, new Set(["--limit"]), new Set(["--channels"]))
  if (positional.length !== 1) throw new Error("Usage: buddytg export <directory> [--limit n] [--channels]")
  return {
    directory: positional[0]!,
    limit: values.has("--limit") ? parsePositive("--limit", values.get("--limit"), 1_000_000) : undefined,
    channels: values.has("--channels"),
  }
}

/** Telegram's takeout docs: these three must also carry the split range. */
const RANGED_METHODS = new Set(["messages.getDialogs", "messages.getHistory", "messages.getMessages"])

/**
 * Sleep through every flood wait, however long, instead of failing. Retrying
 * early is what turns a short wait into a long one.
 */
const PATIENT: RpcCallOptions = { floodSleepThreshold: Number.POSITIVE_INFINITY, maxRetryCount: 20 }

/**
 * A client whose every call goes through the takeout session, with the split
 * range on the history methods. mtcute's high-level methods accept it as-is.
 */
const takeoutClient = (takeout: TakeoutSession, range: tl.TypeMessageRange, signal: AbortSignal): ITelegramClient =>
  new Proxy(takeout.client, {
    get(target, property, receiver) {
      if (property !== "call") return Reflect.get(target, property, receiver)
      return (message: tl.RpcMethod, params?: RpcCallOptions) =>
        takeout.call(message as never, {
          ...params,
          ...PATIENT,
          abortSignal: signal,
          ...(RANGED_METHODS.has(message._) ? { withMessageRange: range } : {}),
        })
    },
  })

interface ExportChat {
  readonly dialog: Dialog
  /** Indexes into the ascending range list where this chat has messages. */
  readonly ranges: number[]
}

const chatFileName = (dialog: Dialog) => `${dialog.peer.id}.jsonl`

/** Telegram's export returns no history for these, and saving them is what protection forbids. */
const isContentProtected = (dialog: Dialog) => dialog.peer.type === "chat" && dialog.peer.hasContentProtection

/**
 * Lists dialogs once per split range. Newest range first, so the chat order
 * follows recent activity and an interrupted export has the active chats done.
 */
const collectChats = async (
  takeout: TakeoutSession,
  ranges: readonly tl.TypeMessageRange[],
  options: ExportOptions,
  signal: AbortSignal,
) => {
  const chats = new Map<number, ExportChat>()
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    for await (const dialog of iterDialogs(takeoutClient(takeout, ranges[index]!, signal), { archived: "keep" })) {
      if (!options.channels && peerKind(dialog.peer) === "channel") continue
      const known = chats.get(dialog.peer.id)
      if (known) known.ranges.unshift(index)
      else chats.set(dialog.peer.id, { dialog, ranges: [index] })
    }
  }
  const all = [...chats.values()]
  return options.limit === undefined ? all : all.slice(0, options.limit)
}

/**
 * Writes one chat oldest first, the way Telegram Desktop's export pages:
 * offset 1 and a negative add_offset, moving up. The file only gets its final
 * name once complete, so a rerun skips finished chats and redoes the rest.
 */
const exportChat = async (
  takeout: TakeoutSession,
  ranges: readonly tl.TypeMessageRange[],
  chat: ExportChat,
  directory: string,
  signal: AbortSignal,
) => {
  const target = join(directory, chatFileName(chat.dialog))
  const partial = `${target}.part`
  const output = await open(partial, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  let count = 0
  try {
    await output.write(`${safeJson({ notice: UNTRUSTED_HEADER })}\n`)
    for (const index of chat.ranges) {
      const client = takeoutClient(takeout, ranges[index]!, signal)
      let offset = { id: 1, date: 0 }
      for (;;) {
        const page = await getHistory(client, chat.dialog.peer.inputPeer, { reverse: true, limit: 100, offset })
        if (page.length === 0) break
        const records = page.map((message) =>
          messageRecord(message, { withChat: false, maxTextChars: Number.POSITIVE_INFINITY }),
        )
        await output.write(records.map((record) => `${safeJson(record)}\n`).join(""))
        count += page.length
        if (!page.next || page.next.id <= offset.id) break
        offset = page.next
      }
    }
    await output.sync()
  } finally {
    await output.close()
  }
  await rename(partial, target)
  return count
}

/**
 * `chats.jsonl` is rewritten on every run, so unlike `writePrivateFile` this
 * replaces it: a 0600 temporary file, then rename(), which never follows a symlink.
 */
const replacePrivateFile = async (target: string, data: string) => {
  const temporary = `${target}.part`
  const output = await open(temporary, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    await output.writeFile(data)
    await output.sync()
  } finally {
    await output.close()
  }
  await rename(temporary, target).catch(async (error: unknown) => {
    await unlink(temporary).catch(() => {})
    throw error
  })
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

const fileExists = (path: string) => lstat(path).then((stats) => stats.isFile(), () => false)

/** Telegram holds the first export from a session and notifies the account's other devices. */
const explainInitDelay = (error: TelegramError) => {
  const seconds = Number(error.rpcText?.match(/^TAKEOUT_INIT_DELAY_(\d+)$/)?.[1])
  if (!Number.isFinite(seconds)) return error
  const hours = Math.max(1, Math.round(seconds / 3600))
  return new TelegramError({
    message: `Telegram delays new data exports for security and has notified your other devices. Try again in about ${hours} hour${hours === 1 ? "" : "s"}.`,
    ...(error.rpcText ? { rpcText: error.rpcText } : {}),
  })
}

export const exportChats = Effect.fn("exportChats")(function* (options: ExportOptions) {
  const root = resolve(options.directory)
  const chatsDirectory = join(root, "chats")
  yield* tg(async () => {
    await ensurePrivateDirectory(root)
    await ensurePrivateDirectory(chatsDirectory)
  })

  const client = yield* makeAuthedClient
  const takeout = yield* Effect.acquireRelease(
    tg(() =>
      client.initTakeoutSession({
        messageUsers: true,
        messageChats: true,
        messageMegagroups: true,
        messageChannels: options.channels,
      }),
    ).pipe(Effect.mapError(explainInitDelay)),
    (session, exit) => boundedCleanup(() => session.finish(Exit.isSuccess(exit))),
  )

  const ranges = yield* tg(async () => {
    const split = await takeout.call({ _: "messages.getSplitRanges" }, PATIENT)
    return [...split].sort((a, b) => a.minId - b.minId)
  })
  yield* Console.error("Listing chats...")
  const chats = yield* tg((signal) => collectChats(takeout, ranges, options, signal))

  yield* tg(() =>
    replacePrivateFile(
      join(root, "chats.jsonl"),
      `${chats
        .map(({ dialog }) =>
          safeJson({
            chatId: dialog.peer.id,
            type: peerKind(dialog.peer),
            name: dialog.peer.displayName,
            ...(dialog.peer.username ? { username: dialog.peer.username } : {}),
            ...(dialog.isArchived ? { archived: true } : {}),
            ...(isContentProtected(dialog) ? { contentProtected: true } : { file: `chats/${chatFileName(dialog)}` }),
          }),
        )
        .join("\n")}\n`,
    ),
  )

  let exported = 0
  let skipped = 0
  let protectedChats = 0
  let messages = 0
  for (const [position, chat] of chats.entries()) {
    const label = `[${position + 1}/${chats.length}] ${escapeTerminalText(chat.dialog.peer.displayName)}`
    if (isContentProtected(chat.dialog)) {
      protectedChats += 1
      continue
    }
    if (yield* tg(() => fileExists(join(chatsDirectory, chatFileName(chat.dialog))))) {
      skipped += 1
      continue
    }
    const count = yield* tg((signal) => exportChat(takeout, ranges, chat, chatsDirectory, signal)).pipe(
      Effect.mapError(
        (error) =>
          new TelegramError({
            message: `${error.message}\nRun the same command again to continue. Finished chats are kept.`,
            ...(error.rpcText ? { rpcText: error.rpcText } : {}),
          }),
      ),
    )
    exported += 1
    messages += count
    yield* Console.error(`${label}: ${plural(count, "message")}`)
  }

  yield* saveSession(client)
  const already = skipped > 0 ? ` ${plural(skipped, "chat")} already done.` : ""
  const left = protectedChats > 0 ? ` Left out ${plural(protectedChats, "chat")} with content protection.` : ""
  yield* Console.log(
    `Exported ${plural(exported, "chat")} (${plural(messages, "message")}) to ${escapeTerminalText(root)}.${already}${left}`,
  )
}, Effect.scoped)
