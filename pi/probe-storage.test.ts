import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readSecret, probeAccount } from "./account-probe"

test("account probe uses the CLI file store without contacting Telegram when signed out", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buddytg-probe-"))
  const previous = process.env.BUDDYTG_SECRETS_DIR
  process.env.BUDDYTG_SECRETS_DIR = directory
  try {
    expect(await readSecret("session")).toBeNull()
    expect(await probeAccount()).toEqual({ kind: "signed-out" })
    await writeFile(join(directory, "api-id"), "12345", { mode: 0o600 })
    expect(await readSecret("api-id")).toBe("12345")
    await writeFile(join(directory, "session"), "", { mode: 0o600 })
    await expect(readSecret("session")).rejects.toThrow("Empty secret item")
  } finally {
    if (previous === undefined) delete process.env.BUDDYTG_SECRETS_DIR
    else process.env.BUDDYTG_SECRETS_DIR = previous
    await rm(directory, { recursive: true, force: true })
  }
})
