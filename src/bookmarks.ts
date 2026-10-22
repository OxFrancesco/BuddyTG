import type { TelegramClient } from "@mtcute/bun"
import { FileLocation, type Message } from "@mtcute/core"
import { md } from "@mtcute/markdown-parser"
import { Console, Effect, Predicate } from "effect"
import { lstat } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import {
  DEFAULT_DOWNLOAD_MAX_BYTES,
  ensurePrivateDirectory,
  escapeTerminalText,
  prepareDownloadTarget,
  sanitizeDownloadFileName,
  writePrivateDownload,
  writePrivateFile,
} from "./file-transfer"
import { FileTransferError } from "./file-commands"
import { tryPromiseSettled } from "./settled"
import { makeAuthedClient, saveSession, tg } from "./telegram"

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Download one Saved Messages attachment into the private media directory.
 * Same rules as `file download`: no symlinks, no overwrite, a size cap, and
 * content-protected media is refused. An existing regular file is reused.
 */
const downloadMedia = (client: TelegramClient, msg: Message, mediaDir: string) =>
  tryPromiseSettled({
    try: async (signal) => {
      const media = msg.media
      if (!(media instanceof FileLocation) || msg.isContentProtected) return undefined
      const mimeType =
        Predicate.hasProperty(media, "mimeType") && Predicate.isString(media.mimeType) ? media.mimeType : undefined
      const remoteName =
        Predicate.hasProperty(media, "fileName") && Predicate.isString(media.fileName) ? media.fileName : null
      const ext = remoteName?.match(/\.\w+$/)?.[0] ?? `.${mimeType?.split("/")[1]?.replace(/\W/g, "") || "bin"}`
      const fileName = sanitizeDownloadFileName(`${msg.id}-${media.type}${ext}`, `${msg.id}-media.bin`)
      const existing = await lstat(join(mediaDir, fileName)).catch(() => undefined)
      if (existing) return existing.isFile() ? fileName : undefined
      const target = await prepareDownloadTarget(mediaDir, fileName)
      const expectedBytes =
        media.fileSize !== undefined && Number.isSafeInteger(media.fileSize) && media.fileSize >= 0
          ? media.fileSize
          : undefined
      await writePrivateDownload({
        chunks: client.downloadAsIterable(media, {
          ...(expectedBytes === undefined ? {} : { fileSize: expectedBytes }),
          abortSignal: signal,
        }),
        target,
        ...(expectedBytes === undefined ? {} : { expectedBytes }),
        maxBytes: DEFAULT_DOWNLOAD_MAX_BYTES,
      })
      return fileName
    },
    catch: (error) => new FileTransferError({ message: messageOf(error) }),
  })

export const exportBookmarks = Effect.fn("exportBookmarks")(function* (
  file: string | undefined,
  withMedia: boolean,
) {
  const target = resolve(file ?? "saved-messages.md")
  const client = yield* makeAuthedClient
  const messages = yield* tg(async () => {
    const all = []
    for await (const msg of client.iterHistory("me")) all.push(msg)
    return all.reverse() // oldest first
  })

  const mediaDir = target.replace(/\.md$/, "") + "-media"
  const mediaLink = basename(mediaDir)
  if (withMedia) {
    yield* Effect.tryPromise({
      try: () => ensurePrivateDirectory(mediaDir),
      catch: (error) => new FileTransferError({ message: messageOf(error) }),
    })
  }

  let skipped = 0
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
      if (withMedia) {
        const saved = yield* downloadMedia(client, msg, mediaDir).pipe(
          Effect.catch((error) =>
            Console.error(`Skipped media of message ${msg.id}: ${escapeTerminalText(error.message)}`).pipe(
              Effect.as(undefined),
            ),
          ),
        )
        if (saved) marker = `![media: ${msg.media.type}](${encodeURI(`${mediaLink}/${saved}`)})`
        else skipped += 1
      }
      lines.push(marker, "")
    }

    // rich text: convert Telegram entities back to markdown
    if (msg.text) lines.push(md.unparse(msg.textWithEntities), "")
  }

  yield* saveSession(client)
  yield* tryPromiseSettled({
    try: () => writePrivateFile(target, lines.join("\n")),
    catch: (error) =>
      new FileTransferError({ message: `Could not write ${escapeTerminalText(target)}: ${messageOf(error)}` }),
  })
  yield* Console.log(`Exported ${messages.length} saved message(s) to ${escapeTerminalText(target)}`)
  if (withMedia && skipped > 0) {
    yield* Console.log(`${skipped} attachment(s) were not downloaded (protected, not a file, or failed).`)
  }
}, Effect.scoped)
