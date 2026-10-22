import type { TelegramClient } from "@mtcute/bun"
import { FileLocation, InputMedia, type Peer } from "@mtcute/core"
import { Console, Effect, Predicate, Schema } from "effect"
import {
  assertUploadSourceUnchanged,
  createUploadStream,
  escapeTerminalText,
  formatBytes,
  openLocalUpload,
  prepareDownloadTarget,
  sanitizeDownloadFileName,
  validateUploadLimits,
  writePrivateDownload,
  type FileDownloadCommand,
  type FileSendCommand,
} from "./file-transfer"
import { resolveSendTarget } from "./peer-target"
import { askViaTelegram } from "./ask"
import { revealLine } from "./permission-hook"
import { prompt } from "./prompt"
import { tryPromiseSettled } from "./settled"
import { makeAuthedClient, saveSession, tg } from "./telegram"

export class FileTransferError extends Schema.TaggedError<FileTransferError>()("FileTransferError", {
  message: Schema.String,
}) {}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const transferError = (error: unknown) =>
  error instanceof FileTransferError ? error : new FileTransferError({ message: messageOf(error) })

/** Interruption waits for the operation, so partial temporary files are removed first. */
const fileIo = <A>(operation: (signal: AbortSignal) => Promise<A>) =>
  tryPromiseSettled({ try: operation, catch: transferError })

const describePeer = (peer: Peer, escape: (text: string) => string = escapeTerminalText) => {
  const username = peer.username ? ` (@${escape(peer.username)})` : ""
  const kind =
    peer.type === "chat" ? peer.chatType
    : peer.isSelf ? "Saved Messages"
    : peer.isBot ? "bot"
    : "user"
  return `${escape(peer.displayName)}${username} [${kind}, id ${peer.id}]`
}

const MAX_TELEGRAM_CONFIRMATION_LENGTH = 4_000

/**
 * The owner approves in Telegram, after BuddyTG has resolved the recipient and
 * opened the file, so the message names exactly what will be sent.
 */
const confirmInTelegram = Effect.fn("confirmInTelegram")(function* (manifest: {
  readonly recipient: Peer
  readonly path: string
  readonly telegramName: string
  readonly size: number
  readonly caption: string | undefined
}) {
  const question = [
    "📎 Upload a file from this computer?",
    "",
    `To: ${describePeer(manifest.recipient, revealLine)}`,
    `File: ${revealLine(manifest.path)}`,
    `Telegram name: ${revealLine(manifest.telegramName)}`,
    `Size: ${formatBytes(manifest.size)} (${manifest.size} bytes)`,
    `Caption: ${manifest.caption === undefined ? "(none)" : revealLine(JSON.stringify(manifest.caption))}`,
  ].join("\n")
  if (question.length > MAX_TELEGRAM_CONFIRMATION_LENGTH) {
    return yield* new FileTransferError({ message: "The upload details are too long to confirm in Telegram. No file bytes were uploaded." })
  }
  const answer = yield* askViaTelegram({
    question,
    choices: [
      { value: "send", label: "Send file" },
      { value: "cancel", label: "Don't send" },
    ],
    timeoutSeconds: 300,
    silent: false,
  })
  if (answer !== "send") {
    return yield* new FileTransferError({ message: "Not sent: declined in Telegram. No file bytes were uploaded." })
  }
})

const confirmPeer = Effect.fn("confirmPeer")(function* (options: {
  readonly provided: number | undefined
  readonly actual: number
  readonly flag: "--confirm-to" | "--confirm-from"
  readonly label: "recipient" | "source"
  readonly cancellation: string
}) {
  if (options.provided !== undefined) {
    if (options.provided !== options.actual) {
      return yield* new FileTransferError({
        message: `${options.flag} ${options.provided} does not match the resolved ${options.label} id ${options.actual}. ${options.cancellation}`,
      })
    }
    return
  }

  if (process.stdin.isTTY !== true) {
    return yield* new FileTransferError({
      message: `Explicit confirmation required. Re-run with ${options.flag} ${options.actual}. ${options.cancellation}`,
    })
  }

  const answer = (yield* prompt(
    `Type the exact ${options.label} id ${options.actual} to confirm: `,
  )).trim()
  if (answer !== String(options.actual)) {
    return yield* new FileTransferError({ message: `Confirmation did not match. ${options.cancellation}` })
  }
})

const makeProgressReporter = (label: string, expectedBytes: number) => {
  let currentBytes = 0
  let lastMilestone = -1
  let rendered = false
  let closed = false

  const update = (current: number, reportedTotal: number) => {
    currentBytes = Math.max(currentBytes, current)
    const total = Number.isFinite(reportedTotal) && reportedTotal > 0 ? reportedTotal : expectedBytes
    const percent = total > 0 ? Math.min(100, Math.floor((currentBytes / total) * 100)) : 0

    if (process.stderr.isTTY) {
      process.stderr.write(`\r${label}: ${formatBytes(currentBytes)} / ${formatBytes(total)} (${percent}%)`)
      rendered = true
      return
    }

    const milestone = Math.floor(percent / 25) * 25
    if (milestone > lastMilestone) {
      process.stderr.write(`${label}: ${formatBytes(currentBytes)} / ${formatBytes(total)} (${percent}%)\n`)
      lastMilestone = milestone
    }
  }

  return {
    update,
    get currentBytes() {
      return currentBytes
    },
    finish(finalBytes: number) {
      update(finalBytes, expectedBytes)
      if (rendered) process.stderr.write("\n")
      closed = true
    },
    stop() {
      if (!closed && rendered) process.stderr.write("\n")
      closed = true
    },
  }
}

const persistSessionAfterTransfer = (client: TelegramClient) =>
  saveSession(client).pipe(
    Effect.catch((error) =>
      Console.error(
        `Warning: the transfer completed, but the updated Telegram session could not be saved: ${escapeTerminalText(error.message)}`,
      ),
    ),
  )

const uploadFileName = (fileName: string) =>
  sanitizeDownloadFileName(fileName, "upload.bin")

export const sendFileCommand = Effect.fn("sendFileCommand")(function* (options: FileSendCommand) {
  const source = yield* Effect.acquireRelease(
    fileIo(() => openLocalUpload(options.path, options.mediaType)),
    (opened) => Effect.promise(() => opened.handle.close().catch(() => {})),
  )
  const client = yield* makeAuthedClient
  const resolved = yield* tg(() => resolveSendTarget(client, options.peer))
  const recipient = yield* tg(() => client.getPeer(resolved))
  const account = yield* tg(() => client.getMe())

  yield* Effect.try({
    try: () =>
      validateUploadLimits({
        size: source.size,
        caption: options.caption,
        isPremium: account.isPremium,
      }),
    catch: transferError,
  })

  const telegramName = uploadFileName(source.fileName)
  const mode =
    options.mediaType === "document" ? "document (exact bytes)"
    : `native photo (${source.photoMime}; Telegram may process it)`
  yield* Console.log(
    [
      "File upload preflight",
      `  Recipient: ${describePeer(recipient)}`,
      `  Local file: ${escapeTerminalText(source.path)}`,
      `  Telegram name: ${escapeTerminalText(telegramName)}`,
      `  Size: ${formatBytes(source.size)} (${source.size} bytes)`,
      `  Mode: ${mode}`,
      `  Caption: ${options.caption === undefined ? "(none)" : escapeTerminalText(JSON.stringify(options.caption))}`,
    ].join("\n"),
  )

  if (options.confirmTelegram) {
    yield* confirmInTelegram({ recipient, path: source.path, telegramName, size: source.size, caption: options.caption })
  } else {
    yield* confirmPeer({
      provided: options.confirmTo,
      actual: recipient.id,
      flag: "--confirm-to",
      label: "recipient",
      cancellation: "No file bytes were uploaded.",
    })
  }
  yield* fileIo(() => assertUploadSourceUnchanged(source))

  const progress = makeProgressReporter("Uploading", source.size)
  progress.update(0, source.size)
  const mediaOptions = {
    fileName: telegramName,
    fileSize: source.size,
    ...(options.caption === undefined ? {} : { caption: options.caption }),
  }
  const media =
    options.mediaType === "photo" ?
      InputMedia.photo(createUploadStream(source), {
        ...mediaOptions,
        fileMime: source.photoMime,
      })
    : InputMedia.document(createUploadStream(source), mediaOptions)

  // The signal aborts the upload when Ctrl+C interrupts the program.
  const message = yield* fileIo(async (signal) => {
    try {
      const sent = await client.sendMedia(resolved, media, {
        abortSignal: signal,
        progressCallback: progress.update,
      })
      progress.finish(source.size)
      return sent
    } catch (error) {
      const detail = escapeTerminalText(messageOf(error))
      if (progress.currentBytes === 0) {
        throw new Error(`Upload failed before any file bytes were accepted: ${detail}`)
      }
      throw new Error(
        `Telegram did not return a sent message id after upload started; delivery is unknown: ${detail}`,
      )
    }
  }).pipe(
    Effect.ensuring(Effect.sync(progress.stop)),
    Effect.onInterrupt(() =>
      progress.currentBytes === 0
        ? Console.error("Interrupted before any file bytes were uploaded.")
        : Console.error("Interrupted after the upload started; delivery is unknown."),
    ),
  )

  yield* Console.log(`Sent ${telegramName} to ${describePeer(recipient)} (message id ${message.id}).`)
  yield* persistSessionAfterTransfer(client)
}, Effect.scoped)

const extensionForMedia = (type: string, mimeType: string | undefined) => {
  const knownMimeExtensions: Record<string, string> = {
    "application/pdf": "pdf",
    "application/x-tgsticker": "tgs",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
  }
  return (
    (mimeType === undefined ? undefined : knownMimeExtensions[mimeType.toLowerCase()]) ??
    ({ photo: "jpg", sticker: "webp", voice: "ogg", video: "mp4", audio: "mp3" }[type]) ??
    "bin"
  )
}

export const downloadFileCommand = Effect.fn("downloadFileCommand")(function* (options: FileDownloadCommand) {
  const client = yield* makeAuthedClient
  const resolved = yield* tg(() => resolveSendTarget(client, options.peer))
  const sourcePeer = yield* tg(() => client.getPeer(resolved))
  const [message] = yield* tg(() => client.getMessages(resolved, options.messageId))
  if (!message) {
    return yield* new FileTransferError({
      message: `Message ${options.messageId} was not found in ${describePeer(sourcePeer)}`,
    })
  }
  if (message.isContentProtected) {
    return yield* new FileTransferError({ message: "Refusing to download content-protected Telegram media" })
  }

  const media = message.media
  if (!(media instanceof FileLocation)) {
    return yield* new FileTransferError({
      message: `Message ${options.messageId} does not contain downloadable file media`,
    })
  }

  const mimeType =
    Predicate.hasProperty(media, "mimeType") && Predicate.isString(media.mimeType) ? media.mimeType : undefined
  const remoteName =
    Predicate.hasProperty(media, "fileName") && Predicate.isString(media.fileName) ? media.fileName : null
  const fallbackName = `${message.id}-${media.type}.${extensionForMedia(media.type, mimeType)}`
  const fileName = options.fileName ?? sanitizeDownloadFileName(remoteName, fallbackName)
  const target = yield* fileIo(() =>
    prepareDownloadTarget(options.destinationDirectory, fileName),
  )
  const expectedBytes =
    media.fileSize !== undefined && Number.isSafeInteger(media.fileSize) && media.fileSize >= 0 ?
      media.fileSize
    : undefined
  if (expectedBytes !== undefined && expectedBytes > options.maxBytes) {
    return yield* new FileTransferError({
      message: `Remote file is ${formatBytes(expectedBytes)}, above the configured ${formatBytes(options.maxBytes)} limit. Raise --max-size explicitly (maximum 4000MiB).`,
    })
  }

  yield* Console.log(
    [
      "File download preflight",
      `  Source: ${describePeer(sourcePeer)}`,
      `  Message id: ${message.id}`,
      `  Media: ${media.type}${mimeType ? ` (${escapeTerminalText(mimeType)})` : ""}`,
      `  Remote name: ${remoteName === null ? "(not provided)" : escapeTerminalText(JSON.stringify(remoteName))}`,
      `  Destination: ${escapeTerminalText(target)}`,
      `  Expected size: ${expectedBytes === undefined ? "unknown" : `${formatBytes(expectedBytes)} (${expectedBytes} bytes)`}`,
      `  Safety limit: ${formatBytes(options.maxBytes)} (${options.maxBytes} bytes)`,
    ].join("\n"),
  )

  yield* confirmPeer({
    provided: options.confirmFrom,
    actual: sourcePeer.id,
    flag: "--confirm-from",
    label: "source",
    cancellation: "No local file was written.",
  })

  const progress = makeProgressReporter("Downloading", expectedBytes ?? options.maxBytes)
  progress.update(0, expectedBytes ?? options.maxBytes)
  let cleanupWarning: string | undefined
  const written = yield* fileIo(async (signal) => {
    try {
      const count = await writePrivateDownload({
        chunks: client.downloadAsIterable(media, {
          ...(expectedBytes === undefined ? {} : { fileSize: expectedBytes }),
          abortSignal: signal,
        }),
        target,
        ...(expectedBytes === undefined ? {} : { expectedBytes }),
        maxBytes: options.maxBytes,
        onProgress: progress.update,
        onCleanupWarning: (warning) => {
          cleanupWarning = warning
        },
      })
      progress.finish(count)
      return count
    } catch (error) {
      throw new Error(
        `Download failed; no destination file was published: ${escapeTerminalText(messageOf(error))}`,
      )
    }
  }).pipe(Effect.ensuring(Effect.sync(progress.stop)))

  if (cleanupWarning !== undefined) {
    yield* Console.error(`Warning: ${escapeTerminalText(cleanupWarning)}`)
  }

  yield* Console.log(
    `Downloaded message ${message.id} from ${describePeer(sourcePeer)} to ${escapeTerminalText(target)} (${formatBytes(written)}).`,
  )
  yield* persistSessionAfterTransfer(client)
}, Effect.scoped)
