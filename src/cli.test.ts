import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const runCli = async (...args: string[]) => {
  const subprocess = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: `${import.meta.dir}/..`,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

const runCliWithEnv = async (env: Record<string, string>, ...args: string[]) => {
  const subprocess = Bun.spawn([process.execPath, "--no-env-file", "src/cli.ts", ...args], {
    cwd: `${import.meta.dir}/..`,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

test("rejects an invalid chats limit before authentication", async () => {
  const { exitCode, stderr } = await runCli("chats", "--limit", "nope")

  expect(exitCode).toBe(1)
  expect(stderr).toContain("--limit must be a positive safe integer")
  expect(stderr).not.toContain("Not logged in")
})

test("rejects an ambiguous file-send confirmation before authentication", async () => {
  const { exitCode, stderr } = await runCli("file", "send", "me", "report.pdf", "--yes")

  expect(exitCode).toBe(1)
  expect(stderr).toContain("Unknown file send option: --yes")
  expect(stderr).not.toContain("Not logged in")
})

test("rejects an invalid download message id before authentication", async () => {
  const { exitCode, stderr } = await runCli("file", "download", "me", "0", "--to", "/tmp")

  expect(exitCode).toBe(1)
  expect(stderr).toContain("message id must be a positive safe integer")
  expect(stderr).not.toContain("Not logged in")
})

test("rejects invalid ask arguments before reading bot configuration", async () => {
  const { exitCode, stderr } = await runCli("ask", "--option", "approve", "Continue?")

  expect(exitCode).toBe(1)
  expect(stderr).toContain("--option must use <value>=<label>")
  expect(stderr).not.toContain("Telegram bot is not configured")
})

test("refuses non-loopback HTTP without plaintext opt-in before storing a secret", async () => {
  const home = await mkdtemp(join(tmpdir(), "buddytg-cli-http-test-"))
  const secrets = join(home, "secrets")
  try {
    const { exitCode, stderr } = await runCliWithEnv(
      {
        PATH: process.env.PATH ?? "",
        HOME: home,
        TMPDIR: tmpdir(),
        BUDDYTG_SECRETS_DIR: secrets,
        BUDDYTG_MCP_URL: "http://localhost:8790",
      },
      "mcp",
      "http",
      "--host",
      "0.0.0.0",
    )

    expect(exitCode).toBe(1)
    expect(stderr).toContain("--allow-plaintext")
    expect(await Bun.file(join(secrets, "mcp-secret")).exists()).toBe(false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("accepts --allow-plaintext as a valueless HTTP option", async () => {
  const { exitCode, stderr } = await runCli("mcp", "http", "--allow-plaintext", "--port", "0")

  expect(exitCode).toBe(1)
  expect(stderr).toContain("--port must be 1-65535")
})

test("rejects malformed permission hook input before reading bot configuration", async () => {
  const subprocess = Bun.spawn([process.execPath, "src/cli.ts", "hook", "permission"], {
    cwd: `${import.meta.dir}/..`,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  subprocess.stdin.write("{}")
  subprocess.stdin.end()
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])

  expect(exitCode).toBe(1)
  expect(stdout).toBe("")
  expect(stderr).toContain("Permission hook input is missing hook_event_name")
  expect(stderr).not.toContain("Telegram bot is not configured")
})

test("shows transfer and response-bridge options in CLI help", async () => {
  const { exitCode, stdout } = await runCli()

  expect(exitCode).toBe(0)
  expect(stdout).toContain("file send <peer> <path>")
  expect(stdout).toContain("--confirm-to <id>")
  expect(stdout).toContain("file download <peer> <message-id>")
  expect(stdout).toContain("--confirm-from <id>")
  expect(stdout).toContain("ask <question>")
  expect(stdout).toContain("--option <value>=<label>")
  expect(stdout).toContain("hook permission")
  expect(stdout).toContain("stored in the local secret store")
  expect(stdout).toContain("Log out and remove all stored secrets")
  expect(stdout).toContain("--allow-plaintext        Allow a non-loopback --host without TLS")
  expect(stdout).toContain("Linux uses WebSocket MTProto by default")
  expect(stdout).not.toContain("stored in the Keychain")
})
