import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
export const OUTPUT_LIMIT = 24 * 1024

/** No shell, no stdin prompts, no raw diagnostics or persisted output. */
export async function runProcess(argv: string[], signal?: AbortSignal, timeoutMs = 60_000): Promise<string> {
  signal?.throwIfAborted()
  const executable = argv[0]
  if (!executable) throw new Error("Missing executable")
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], shell: false })
    const chunks: Buffer[] = []
    let bytes = 0
    let truncated = false
    let stopped = false
    const stop = () => { stopped = true; child.kill("SIGKILL") }
    const timer = setTimeout(stop, timeoutMs)
    signal?.addEventListener("abort", stop, { once: true })
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = OUTPUT_LIMIT - bytes
      if (chunk.length > remaining) truncated = true
      if (remaining > 0) { chunks.push(chunk.subarray(0, remaining)); bytes += Math.min(chunk.length, remaining) }
    })
    // Drain diagnostics but never expose possible authentication/transport secrets.
    child.stderr.resume()
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop) }
    child.on("error", () => { cleanup(); reject(new Error("Unable to start BuddyTG. Install Bun and run bun install in the package directory.")) })
    child.on("close", (code) => {
      cleanup()
      if (stopped) return reject(new Error("BuddyTG cancelled or timed out. If sending, delivery is unknown; do not retry automatically."))
      if (code !== 0) return reject(new Error("BuddyTG failed. Check authentication with the standalone CLI. If sending, delivery may be unknown; do not retry automatically. Diagnostics withheld to protect credentials."))
      const output = Buffer.concat(chunks).toString("utf8")
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
      resolve(output + (truncated ? "\n[Output truncated at 24 KiB; full output discarded for privacy.]" : ""))
    })
    if (signal?.aborted) stop()
  })
}

export type RunCLI = (args: string[], signal?: AbortSignal) => Promise<string>
export const runCLI: RunCLI = (args, signal) => runProcess(["bun", cli, ...args], signal)
