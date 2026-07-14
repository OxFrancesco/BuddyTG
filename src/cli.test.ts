import { expect, test } from "bun:test"

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

test("shows file transfer safety options in CLI help", async () => {
  const { exitCode, stdout } = await runCli()

  expect(exitCode).toBe(0)
  expect(stdout).toContain("file send <peer> <path>")
  expect(stdout).toContain("--confirm-to <id>")
  expect(stdout).toContain("file download <peer> <message-id>")
  expect(stdout).toContain("--confirm-from <id>")
})
