import { describe, expect, test } from "bun:test"
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertUploadSourceUnchanged,
  createUploadStream,
  escapeTerminalText,
  openLocalUpload,
  parseFileCommand,
  prepareDownloadTarget,
  sanitizeDownloadFileName,
  validateUploadLimits,
  writePrivateDownload,
} from "./file-transfer"

const withTempDirectory = async (run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "buddytg-file-test-"))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe("parseFileCommand", () => {
  test("parses an explicitly confirmed file send", () => {
    expect(
      parseFileCommand([
        "send",
        "@alice",
        "/private/report.pdf",
        "--caption",
        "Quarterly -- draft",
        "--as",
        "document",
        "--confirm-to",
        "12345",
      ]),
    ).toEqual({
      action: "send",
      peer: "@alice",
      path: "/private/report.pdf",
      caption: "Quarterly -- draft",
      mediaType: "document",
      confirmTo: 12345,
    })
  })

  test("parses a bounded download to an explicit directory", () => {
    expect(
      parseFileCommand([
        "download",
        "-1001234567890",
        "42",
        "--to",
        "/private/downloads",
        "--name",
        "invoice.pdf",
        "--max-size",
        "512MiB",
        "--confirm-from",
        "-1001234567890",
      ]),
    ).toEqual({
      action: "download",
      peer: "-1001234567890",
      messageId: 42,
      destinationDirectory: "/private/downloads",
      fileName: "invoice.pdf",
      maxBytes: 512 * 1024 * 1024,
      confirmFrom: -1001234567890,
    })
  })

  test("accepts a copied Telegram message link as the download source", () => {
    expect(
      parseFileCommand([
        "download",
        "https://t.me/c/1234567890/42?single",
        "--to",
        "/private/downloads",
      ]),
    ).toEqual({
      action: "download",
      peer: "https://t.me/c/1234567890/42?single",
      messageId: 42,
      destinationDirectory: "/private/downloads",
      maxBytes: 2 * 1024 * 1024 * 1024,
    })
  })

  test("rejects unsafe or ambiguous options", () => {
    expect(() => parseFileCommand(["send", "me", "file", "--yes"])).toThrow(
      "Unknown file send option",
    )
    expect(() => parseFileCommand(["download", "me", "0", "--to", "/tmp"])).toThrow(
      "message id must be a positive safe integer",
    )
    expect(() =>
      parseFileCommand(["download", "me", "1", "--to", "/tmp", "--name", "../secret"]),
    ).toThrow("--name must be a plain file name")
    expect(() =>
      parseFileCommand(["download", "me", "1", "--to", "/tmp", "--to", "/private"]),
    ).toThrow("may only be provided once")
    expect(() =>
      parseFileCommand(["download", "me", "1", "--to", "/tmp", "--name", "safe\u202Etxt"]),
    ).toThrow("--name must be a plain file name")
  })
})

describe("openLocalUpload", () => {
  test("opens a regular file and validates native photo bytes", () =>
    withTempDirectory(async (directory) => {
      const path = join(directory, "photo.jpg")
      await writeFile(path, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]))

      const source = await openLocalUpload(path, "photo")
      try {
        expect({ name: source.fileName, size: source.size, mime: source.photoMime }).toEqual({
          name: "photo.jpg",
          size: 8,
          mime: "image/jpeg",
        })
      } finally {
        await source.handle.close()
      }
    }))

  test("rejects a symbolic link without following it", () =>
    withTempDirectory(async (directory) => {
      const target = join(directory, "private.txt")
      const link = join(directory, "upload.txt")
      await writeFile(target, "private")
      await symlink(target, link)

      expect(openLocalUpload(link, "document")).rejects.toThrow("symbolic links are not allowed")
    }))

  test("rejects directories, empty files, and invalid photo content", () =>
    withTempDirectory(async (directory) => {
      const nested = join(directory, "nested")
      const empty = join(directory, "empty")
      const fakePhoto = join(directory, "fake.jpg")
      await mkdir(nested)
      await writeFile(empty, "")
      await writeFile(fakePhoto, "not a photo")

      expect(openLocalUpload(nested, "document")).rejects.toThrow("regular file")
      expect(openLocalUpload(empty, "document")).rejects.toThrow("empty files")
      expect(openLocalUpload(fakePhoto, "photo")).rejects.toThrow("JPEG, PNG, or WebP")
    }))

  test("streams the opened file even if its path is replaced later", () =>
    withTempDirectory(async (directory) => {
      const path = join(directory, "report.bin")
      await writeFile(path, new Uint8Array([1, 2, 3]))
      const source = await openLocalUpload(path, "document")
      try {
        await rename(path, join(directory, "original.bin"))
        await writeFile(path, new Uint8Array([9, 9, 9]))

        const bytes = new Uint8Array(await new Response(createUploadStream(source)).arrayBuffer())
        expect(Array.from(bytes)).toEqual([1, 2, 3])
      } finally {
        await source.handle.close()
      }
    }))

  test("detects in-place changes made after the confirmation manifest", () =>
    withTempDirectory(async (directory) => {
      const path = join(directory, "mutable.bin")
      await writeFile(path, new Uint8Array([1, 2, 3]))
      const source = await openLocalUpload(path, "document")
      try {
        await writeFile(path, new Uint8Array([4, 5, 6, 7]))
        expect(assertUploadSourceUnchanged(source)).rejects.toThrow("changed after preflight")
      } finally {
        await source.handle.close()
      }
    }))
})

describe("validateUploadLimits", () => {
  test("uses Telegram's account-tier upload and caption ceilings", () => {
    expect(() =>
      validateUploadLimits({ size: 2_097_152_001, caption: undefined, isPremium: false }),
    ).toThrow("regular-account limit")
    expect(() =>
      validateUploadLimits({ size: 4_194_304_000, caption: "caption", isPremium: true }),
    ).not.toThrow()
    expect(() =>
      validateUploadLimits({ size: 1, caption: "x".repeat(1025), isPremium: false }),
    ).toThrow("caption limit")
  })
})

describe("private downloads", () => {
  test("sanitizes a remote file name without retaining path traversal", () => {
    expect(sanitizeDownloadFileName("../../secret\n\u202E.pdf", "42-document.pdf")).toBe(
      "secret__.pdf",
    )
  })

  test("escapes terminal control and bidirectional formatting characters", () => {
    expect(escapeTerminalText("Alice\u001b[2J\u202Etxt")).toBe("Alice\\u{1b}[2J\\u{202e}txt")
  })

  test("publishes a complete file privately and never overwrites it", () =>
    withTempDirectory(async (directory) => {
      const target = await prepareDownloadTarget(directory, "download.bin")
      await writePrivateDownload({
        chunks: (async function* () {
          yield new Uint8Array([1, 2])
          yield new Uint8Array([3, 4])
        })(),
        target,
        expectedBytes: 4,
        maxBytes: 8,
      })

      expect({
        content: Array.from(await readFile(target)),
        mode: (await stat(target)).mode & 0o777,
      }).toEqual({ content: [1, 2, 3, 4], mode: 0o600 })

      expect(
        writePrivateDownload({
          chunks: (async function* () {
            yield new Uint8Array([9])
          })(),
          target,
          expectedBytes: 1,
          maxBytes: 8,
        }),
      ).rejects.toThrow("destination already exists")
      expect(Array.from(await readFile(target))).toEqual([1, 2, 3, 4])
    }))

  test("supports a maximum-length destination name without an oversized temporary name", () =>
    withTempDirectory(async (directory) => {
      const target = await prepareDownloadTarget(directory, `${"a".repeat(236)}.bin`)
      await writePrivateDownload({
        chunks: (async function* () {
          yield new Uint8Array([1])
        })(),
        target,
        expectedBytes: 1,
        maxBytes: 1,
      })
      expect(Array.from(await readFile(target))).toEqual([1])
    }))

  test("removes partial data when the streaming size limit is exceeded", () =>
    withTempDirectory(async (directory) => {
      const target = await prepareDownloadTarget(directory, "limited.bin")
      expect(
        writePrivateDownload({
          chunks: (async function* () {
            yield new Uint8Array([1, 2, 3, 4, 5])
          })(),
          target,
          maxBytes: 4,
        }),
      ).rejects.toThrow("exceeded the configured limit")
      expect(await readdir(directory)).toEqual([])
    }))
})
