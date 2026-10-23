import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
/** The BuddyTG package root, a directory only the owner controls. */
export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url))
export const OUTPUT_LIMIT = 24 * 1024

/** Used only by the MCP HTTP server; a CLI child never needs them. */
const SERVER_ONLY_ENV = ["BUDDYTG_MCP_SECRET", "TG_LOGIN_CLIENT_ID", "TG_LOGIN_CLIENT_SECRET", "BUDDYTG_MCP_ALLOWED_IDS", "BUDDYTG_MCP_URL"]

export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env }
  for (const name of SERVER_ONLY_ENV) delete next[name]
  // mtcute logs to stdout, which is returned to the model; keep it silent.
  next.MTCUTE_LOG_LEVEL = "0"
  return next
}

/**
 * Bun reads bunfig.toml (including `preload` scripts) and .env from its working
 * directory. The host's directory is usually a project the agent is working on,
 * so BuddyTG children always start in the package root with --no-env-file.
 */
export const bunArgv = (script: string, ...args: string[]) => ["bun", "--no-env-file", script, ...args]

/** No shell, no stdin prompts, no raw diagnostics or persisted output. */
export async function runProcess(argv: string[], signal?: AbortSignal, timeoutMs = 60_000, cwd = PACKAGE_ROOT): Promise<string> {
  signal?.throwIfAborted()
  const executable = argv[0]
  if (!executable) throw new Error("Missing executable")
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv.slice(1), { cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"], shell: false })
    const chunks: Buffer[] = []
    let bytes = 0
    let truncated = false
    let stopped = false
    // SIGTERM first so the CLI can run its finalizers (Telegram client shutdown, temp-file cleanup).
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      if (stopped) return
      stopped = true
      child.kill("SIGTERM")
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000)
    }
    const timer = setTimeout(stop, timeoutMs)
    signal?.addEventListener("abort", stop, { once: true })
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = OUTPUT_LIMIT - bytes
      if (chunk.length > remaining) truncated = true
      if (remaining > 0) { chunks.push(chunk.subarray(0, remaining)); bytes += Math.min(chunk.length, remaining) }
    })
    // Drain diagnostics but never expose possible authentication/transport secrets.
    child.stderr.resume()
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", stop) }
    child.on("error", () => { cleanup(); reject(new Error("Unable to start BuddyTG. Install Bun and run bun install in the package directory.")) })
    child.on("close", (code) => {
      cleanup()
      if (stopped) return reject(new Error("BuddyTG cancelled or timed out. If sending, delivery is unknown; do not retry automatically."))
      if (code !== 0) return reject(new Error("BuddyTG failed. Check authentication with the standalone CLI. If sending, delivery may be unknown; do not retry automatically. Diagnostics withheld to protect credentials."))
      const output = Buffer.concat(chunks).toString("utf8")
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
      resolve(output + (truncated ? "\n[Output truncated at 24 KiB; full output discarded for privacy.]" : ""))
    })
    if (signal?.aborted) stop()
  })
}

export type RunCLI = (args: string[], signal?: AbortSignal, timeoutMs?: number) => Promise<string>
export const runCLI: RunCLI = (args, signal, timeoutMs = 60_000) => runProcess(bunArgv(cli, ...args), signal, timeoutMs)
