import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { link, lstat, open, realpath, stat, unlink, type FileHandle } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { Readable } from "node:stream"

export type FileSendCommand = {
  readonly action: "send"
  readonly peer: string
  readonly path: string
  readonly caption?: string
  readonly mediaType: "document" | "photo"
  readonly confirmTo?: number
}

export type FileDownloadCommand = {
  readonly action: "download"
  readonly peer: string
  readonly messageId: number
  readonly destinationDirectory: string
  readonly fileName?: string
  readonly maxBytes: number
  readonly confirmFrom?: number
}

export type FileCommand = FileSendCommand | FileDownloadCommand

export const DEFAULT_DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_DOWNLOAD_BYTES = 4_000 * 1024 * 1024
export const REGULAR_UPLOAD_MAX_BYTES = 4_000 * 512 * 1024
export const PREMIUM_UPLOAD_MAX_BYTES = 8_000 * 512 * 1024

export type LocalUploadSource = {
  readonly handle: FileHandle
  readonly path: string
  readonly fileName: string
  readonly size: number
  readonly photoMime?: "image/jpeg" | "image/png" | "image/webp"
  readonly fingerprint: {
    readonly device: number
    readonly inode: number
    readonly size: number
    readonly modifiedAt: number
    readonly changedAt: number
  }
}

const detectPhotoMime = (bytes: Uint8Array): LocalUploadSource["photoMime"] => {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg"
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png"
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp"
  }
  return undefined
}

export const openLocalUpload = async (
  inputPath: string,
  mediaType: FileSendCommand["mediaType"],
): Promise<LocalUploadSource> => {
  const initial = await lstat(inputPath).catch((error: unknown) => {
    throw new Error(
      `Cannot inspect local file: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
  if (initial.isSymbolicLink()) {
    throw new Error("Refusing local file: symbolic links are not allowed")
  }

  let handle: FileHandle | undefined
  try {
    handle = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error("Refusing local path: expected one regular file")
    if (stats.size === 0) throw new Error("Refusing local file: empty files are not supported")

    const header = new Uint8Array(Math.min(stats.size, 16))
    await handle.read(header, 0, header.length, 0)
    const photoMime = detectPhotoMime(header)
    if (mediaType === "photo" && photoMime === undefined) {
      throw new Error("Native photo mode accepts only JPEG, PNG, or WebP file content")
    }

    const resolvedPath = await realpath(inputPath)
    const pathStats = await stat(resolvedPath)
    if (pathStats.dev !== stats.dev || pathStats.ino !== stats.ino) {
      throw new Error("Local file path changed during preflight; refusing to upload")
    }
    return {
      handle,
      path: resolvedPath,
      fileName: basename(resolvedPath),
      size: stats.size,
      ...(photoMime === undefined ? {} : { photoMime }),
      fingerprint: {
        device: stats.dev,
        inode: stats.ino,
        size: stats.size,
        modifiedAt: stats.mtimeMs,
        changedAt: stats.ctimeMs,
      },
    }
  } catch (error) {
    await handle?.close().catch(() => {})
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Refusing local file: symbolic links are not allowed")
    }
    throw error
  }
}

export const assertUploadSourceUnchanged = async (source: LocalUploadSource) => {
  const stats = await source.handle.stat()
  const current = {
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    modifiedAt: stats.mtimeMs,
    changedAt: stats.ctimeMs,
  }
  if (
    current.device !== source.fingerprint.device ||
    current.inode !== source.fingerprint.inode ||
    current.size !== source.fingerprint.size ||
    current.modifiedAt !== source.fingerprint.modifiedAt ||
    current.changedAt !== source.fingerprint.changedAt
  ) {
    throw new Error("Local file changed after preflight; refusing to upload any bytes")
  }
}

export const createUploadStream = (source: LocalUploadSource) =>
  Readable.toWeb(
    source.handle.createReadStream({ autoClose: false, start: 0, end: source.size - 1 }),
  ) as ReadableStream<Uint8Array>

export const validateUploadLimits = (options: {
  readonly size: number
  readonly caption: string | undefined
  readonly isPremium: boolean
}) => {
  const maxBytes = options.isPremium ? PREMIUM_UPLOAD_MAX_BYTES : REGULAR_UPLOAD_MAX_BYTES
  if (options.size > maxBytes) {
    throw new Error(
      `File exceeds the ${options.isPremium ? "Premium" : "regular-account"} limit of ${maxBytes} bytes`,
    )
  }

  const captionLimit = options.isPremium ? 4096 : 1024
  if (options.caption !== undefined && Array.from(options.caption).length > captionLimit) {
    throw new Error(
      `Caption exceeds the ${options.isPremium ? "Premium" : "regular-account"} caption limit of ${captionLimit} characters`,
    )
  }
}

export const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KiB", "MiB", "GiB"] as const
  let value = bytes
  let unit = "B"
  for (const next of units) {
    value /= 1024
    unit = next
    if (value < 1024 || next === "GiB") break
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`
}

const parsePeerId = (value: string, option: string) => {
  if (!/^-?\d+$/.test(value)) throw new Error(`${option} must be a non-zero safe integer`)
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id === 0) {
    throw new Error(`${option} must be a non-zero safe integer`)
  }
  return id
}

const parsePositiveInteger = (value: string, label: string) => {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a positive safe integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return parsed
}

const messageIdFromTelegramLink = (value: string) => {
  if (!/^(?:https?:\/\/)?(?:www\.)?t\.me\//i.test(value)) return null

  const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
  const segments = url.pathname.split("/").filter(Boolean)
  const messageId = segments.at(-1)
  if (messageId === undefined || !/^\d+$/.test(messageId)) return null

  const route = segments[0]?.toLowerCase()
  const hasMessageShape =
    route === "c" ? segments.length >= 3
    : route === "s" ? segments.length >= 3
    : segments.length >= 2
  return hasMessageShape ? parsePositiveInteger(messageId, "message id") : null
}

export const parseByteSize = (value: string) => {
  const match = value.match(/^(\d+(?:\.\d+)?)(B|KiB|MiB|GiB)$/i)
  if (!match) throw new Error("--max-size must use B, KiB, MiB, or GiB (for example 512MiB)")

  const multipliers: Record<string, number> = {
    b: 1,
    kib: 1024,
    mib: 1024 * 1024,
    gib: 1024 * 1024 * 1024,
  }
  const bytes = Number(match[1]) * multipliers[match[2]!.toLowerCase()]!
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_DOWNLOAD_BYTES) {
    throw new Error("--max-size must be between 1B and 4000MiB")
  }
  return bytes
}

const assertPlainFileName = (value: string) => {
  if (
    value === "." ||
    value === ".." ||
    value.length === 0 ||
    /[\/\\\0\u0001-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(value) ||
    new TextEncoder().encode(value).length > 240
  ) {
    throw new Error("--name must be a plain file name of at most 240 UTF-8 bytes")
  }
}

const truncateUtf8 = (value: string, maxBytes: number) => {
  const encoder = new TextEncoder()
  if (encoder.encode(value).length <= maxBytes) return value

  let result = ""
  for (const character of value) {
    if (encoder.encode(result + character).length > maxBytes) break
    result += character
  }
  return result
}

export const sanitizeDownloadFileName = (remoteName: string | null, fallback: string) => {
  const leaf = basename((remoteName ?? "").replaceAll("\\", "/"))
  const cleaned = leaf
    .replace(/[\0-\x1f\x7f-\x9f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff:]/g, "_")
    .replace(/^\.+/, "_")
    .replace(/[. ]+$/, "")
    .trim()
  const candidate = cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : fallback
  return truncateUtf8(candidate, 240)
}

export const escapeTerminalText = (value: string) => {
  let escaped = ""
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    const unsafe =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      codePoint === 0xfeff
    escaped += unsafe ? `\\u{${codePoint.toString(16)}}` : character
  }
  return escaped
}

export const prepareDownloadTarget = async (destinationDirectory: string, fileName: string) => {
  assertPlainFileName(fileName)
  const directoryStats = await lstat(destinationDirectory).catch((error: unknown) => {
    throw new Error(
      `Cannot inspect download directory: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
  if (directoryStats.isSymbolicLink()) {
    throw new Error("Refusing download directory: symbolic links are not allowed")
  }
  if (!directoryStats.isDirectory()) {
    throw new Error("Refusing download destination: --to must name an existing directory")
  }

  const target = join(await realpath(destinationDirectory), fileName)
  try {
    await lstat(target)
    throw new Error(`Refusing download: destination already exists: ${target}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return target
}

export const writePrivateDownload = async (options: {
  readonly chunks: AsyncIterable<Uint8Array>
  readonly target: string
  readonly expectedBytes?: number
  readonly maxBytes: number
  readonly onProgress?: (written: number, total: number) => void
  readonly onCleanupWarning?: (message: string) => void
}) => {
  if (options.expectedBytes !== undefined && options.expectedBytes > options.maxBytes) {
    throw new Error(
      `Download size ${options.expectedBytes} bytes exceeds the configured limit of ${options.maxBytes} bytes`,
    )
  }

  try {
    await lstat(options.target)
    throw new Error(`Refusing download: destination already exists: ${options.target}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  const temporary = join(
    dirname(options.target),
    `.buddytg-${randomUUID()}.part`,
  )
  let output: FileHandle | undefined
  let written = 0
  let published = false
  let failure: unknown

  try {
    output = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
    await output.chmod(0o600)

    for await (const chunk of options.chunks) {
      if (written + chunk.byteLength > options.maxBytes) {
        throw new Error(`Download exceeded the configured limit of ${options.maxBytes} bytes`)
      }

      let offset = 0
      while (offset < chunk.byteLength) {
        const result = await output.write(chunk, offset, chunk.byteLength - offset)
        if (result.bytesWritten === 0) throw new Error("Download write made no progress")
        offset += result.bytesWritten
      }
      written += chunk.byteLength
      options.onProgress?.(written, options.expectedBytes ?? options.maxBytes)
    }

    if (options.expectedBytes !== undefined && written !== options.expectedBytes) {
      throw new Error(
        `Download was incomplete: expected ${options.expectedBytes} bytes but received ${written}`,
      )
    }

    await output.sync()
    await output.close()
    output = undefined

    try {
      await link(temporary, options.target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Refusing download: destination already exists: ${options.target}`)
      }
      throw error
    }
    published = true
    return written
  } catch (error) {
    failure = error
    throw error
  } finally {
    await output?.close().catch(() => {})
    try {
      await unlink(temporary)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const cleanupMessage = error instanceof Error ? error.message : String(error)
        if (published) {
          options.onCleanupWarning?.(
            `Download was published, but its private temporary hard link could not be removed: ${cleanupMessage}`,
          )
        } else {
          const original =
            failure === undefined ? "unknown"
            : failure instanceof Error ? failure.message
            : String(failure)
          throw new Error(
            `Download failed (${original}) and private temporary file cleanup also failed: ${cleanupMessage}`,
          )
        }
      }
    }
  }
}

const optionValue = (args: readonly string[], index: number, option: string) => {
  const value = args[index + 1]
  if (value === undefined) throw new Error(`${option} requires a value`)
  return value
}

const parseSendCommand = (args: readonly string[]): FileSendCommand => {
  const positionals: string[] = []
  const seenOptions = new Set<string>()
  let caption: string | undefined
  let mediaType: "document" | "photo" = "document"
  let confirmTo: number | undefined

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!
    if (!arg.startsWith("--")) {
      positionals.push(arg)
      continue
    }

    switch (arg) {
      case "--caption": {
        if (seenOptions.has(arg)) throw new Error(`${arg} may only be provided once`)
        seenOptions.add(arg)
        const value = optionValue(args, index, arg)
        caption = value
        index += 1
        break
      }
      case "--as": {
        if (seenOptions.has(arg)) throw new Error(`${arg} may only be provided once`)
        seenOptions.add(arg)
        const value = optionValue(args, index, arg)
        if (value !== "document" && value !== "photo") {
          throw new Error("--as must be `document` or `photo`")
        }
        mediaType = value
        index += 1
        break
      }
      case "--confirm-to": {
        if (seenOptions.has(arg)) throw new Error(`${arg} may only be provided once`)
        seenOptions.add(arg)
        const value = optionValue(args, index, arg)
        confirmTo = parsePeerId(value, arg)
        index += 1
        break
      }
      default:
        throw new Error(`Unknown file send option: ${arg}`)
    }
  }

  if (positionals.length !== 2) {
    throw new Error("Usage: buddytg file send <peer> <path> [options]")
  }

  return {
    action: "send",
    peer: positionals[0]!,
    path: positionals[1]!,
    ...(caption === undefined ? {} : { caption }),
    mediaType,
    ...(confirmTo === undefined ? {} : { confirmTo }),
  }
}

const parseDownloadCommand = (args: readonly string[]): FileDownloadCommand => {
  const positionals: string[] = []
  const seenOptions = new Set<string>()
  let destinationDirectory: string | undefined
  let fileName: string | undefined
  let maxBytes = DEFAULT_DOWNLOAD_MAX_BYTES
  let confirmFrom: number | undefined

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!
    if (!arg.startsWith("--")) {
      positionals.push(arg)
      continue
    }

    switch (arg) {
      case "--to": {
        if (seenOptions.has(arg)) throw new Error(`${arg} may only be provided once`)
        seenOptions.add(arg)
        destinationDirectory = optionValue(args, index, arg)
        index += 1
        break
      }
      case "--name": {
        if (seenOptions.has(arg)) throw new Error(`${arg} may only be provided once`)
        seenOptions.add(arg)
        fileName = optionValue(args, index, arg)
        assertPlainFileName(fileName)
        index += 1
        break
      }
      case "--max-size": {
        if (seenOptions.has(arg)) throw new Error(`${arg} may only be provided once`)
        seenOptions.add(arg)
        maxBytes = parseByteSize(optionValue(args, index, arg))
        index += 1
        break
      }
      case "--confirm-from": {
        if (seenOptions.has(arg)) throw new Error(`${arg} may only be provided once`)
        seenOptions.add(arg)
        confirmFrom = parsePeerId(optionValue(args, index, arg), arg)
        index += 1
        break
      }
      default:
        throw new Error(`Unknown file download option: ${arg}`)
    }
  }

  if (
    (positionals.length !== 1 && positionals.length !== 2) ||
    destinationDirectory === undefined
  ) {
    throw new Error(
      "Usage: buddytg file download <peer> <message-id> --to <directory> [options] (or use one t.me message link)",
    )
  }

  const linkedMessageId =
    positionals.length === 1 ? messageIdFromTelegramLink(positionals[0]!) : null
  if (positionals.length === 1 && linkedMessageId === null) {
    throw new Error("A single download source must be a t.me message link containing a message id")
  }

  return {
    action: "download",
    peer: positionals[0]!,
    messageId:
      linkedMessageId ?? parsePositiveInteger(positionals[1]!, "message id"),
    destinationDirectory,
    ...(fileName === undefined ? {} : { fileName }),
    maxBytes,
    ...(confirmFrom === undefined ? {} : { confirmFrom }),
  }
}

export const parseFileCommand = (args: readonly string[]): FileCommand => {
  switch (args[0]) {
    case "send":
      return parseSendCommand(args)
    case "download":
      return parseDownloadCommand(args)
    default:
      throw new Error("file action must be `send` or `download`")
  }
}
