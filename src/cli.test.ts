import { expect, test } from "bun:test"

test("rejects an invalid chats limit before authentication", async () => {
  const subprocess = Bun.spawn(
    [process.execPath, "src/cli.ts", "chats", "--limit", "nope"],
    {
      cwd: `${import.meta.dir}/..`,
      stdout: "ignore",
      stderr: "pipe",
    },
  )

  const [exitCode, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stderr).text(),
  ])

  expect(exitCode).toBe(1)
  expect(stderr).toContain("--limit must be a positive safe integer")
  expect(stderr).not.toContain("Not logged in")
})
