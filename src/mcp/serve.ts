import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  oauthMetadataResponse,
  originValidationResponse,
  requireBearerAuth,
} from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { Config, Console, Effect, Option, Redacted, Schema } from "effect"
import { KC_BOT_TOKEN, KC_CHAT_ID } from "../bot"
import { Keychain } from "../keychain"
import { boundedCleanup } from "../settled"
import { createAuthServer, generateSecret, SCOPE } from "./oauth"
import { buildServer, type CliRunner } from "./tools"

export const KC_MCP_SECRET = "mcp-secret"
export const KC_LOGIN_CLIENT_ID = "login-client-id"
export const KC_LOGIN_CLIENT_SECRET = "login-client-secret"
export const TELEGRAM_OIDC_ISSUER = "https://oauth.telegram.org"

export class McpConfigError extends Schema.TaggedError<McpConfigError>()("McpConfigError", {
  message: Schema.String,
}) {}

/** stdio: the host spawns this process, so the OS user is the authorization boundary. */
export const runStdio = Effect.fn("runStdio")(function* (run?: CliRunner) {
  yield* Effect.acquireRelease(
    Effect.sync(() => serveStdio(() => buildServer(run, { localFiles: true }))),
    (handle) => boundedCleanup(() => handle.close()),
  )
  yield* Console.error("BuddyTG MCP server on stdio")
  // Runs until the host closes stdin; SIGINT/SIGTERM interrupt and close the handle.
  yield* Effect.callback<void>((resume) => {
    const end = () => resume(Effect.void)
    for (const event of ["end", "close", "error"]) process.stdin.once(event, end)
    return Effect.sync(() => {
      for (const event of ["end", "close", "error"]) process.stdin.off(event, end)
    })
  })
}, Effect.scoped)

export interface HttpOptions {
  readonly host: string
  readonly port: number
  /** Public base URL when behind a tunnel or proxy. */
  readonly url?: string
}

const MIN_SECRET_BYTES = 32

const configError = (message: string) => new McpConfigError({ message })

/** Environment first (e.g. `doppler run --`), then the local secret store. */
const secretOrEnv = Effect.fnUntraced(function* (name: string, account: string) {
  const env = yield* Config.option(Config.String(name))
  if (Option.isSome(env) && env.value.trim()) return env.value.trim()
  const stored = yield* (yield* Keychain).get(account)
  return stored ? Redacted.value(stored).trim() : undefined
})

/**
 * The root secret signs and encrypts every OAuth artifact. Base64url decoding
 * silently drops invalid characters, so check the text and the decoded length.
 */
export const decodeRootSecret = (secret: string) => {
  if (!/^[A-Za-z0-9_-]{43,}$/.test(secret)) return undefined
  const bytes = Buffer.from(secret, "base64url")
  return bytes.length >= MIN_SECRET_BYTES ? bytes : undefined
}

const isLoopbackHost = (host: string) => localhostAllowedHostnames().includes(host) || host === "::1"

const isLoopbackOrigin = (raw: string) => {
  const url = URL.canParse(raw) ? new URL(raw) : undefined
  return url?.protocol === "http:" && localhostAllowedHostnames().includes(url.hostname) && url.pathname === "/" && url.origin === raw.replace(/\/$/, "")
}

export const loadHttpConfig = Effect.fn("loadHttpConfig")(function* (options: HttpOptions) {
  const keychain = yield* Keychain
  const rawUrl = options.url ?? Option.getOrUndefined(yield* Config.option(Config.String("BUDDYTG_MCP_URL")))
  const baseUrl = rawUrl === undefined ? new URL(`http://${options.host}:${options.port}`) : URL.canParse(rawUrl) ? new URL(rawUrl) : undefined
  if (!baseUrl || baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) {
    return yield* configError("--url must be an origin such as https://buddytg.example.com")
  }
  const isLoopback = localhostAllowedHostnames().includes(baseUrl.hostname)
  if (baseUrl.protocol !== "https:" && !isLoopback) return yield* configError("--url must use https unless it is localhost")
  if (!isLoopbackHost(options.host)) {
    yield* Console.error(`Warning: listening on ${options.host} exposes plain HTTP beyond this machine. Prefer 127.0.0.1 behind a TLS tunnel.`)
  }

  let secret = yield* secretOrEnv("BUDDYTG_MCP_SECRET", KC_MCP_SECRET)
  if (!secret) {
    secret = generateSecret()
    yield* keychain.set(KC_MCP_SECRET, Redacted.make(secret))
  }
  const secretBytes = decodeRootSecret(secret)
  if (!secretBytes) {
    return yield* configError(
      "BUDDYTG_MCP_SECRET must be at least 32 random bytes in base64url (43+ characters of A-Z a-z 0-9 _ -). Generate one with: openssl rand -base64 32 | tr '+/' '-_' | tr -d '='",
    )
  }

  const botToken = yield* secretOrEnv("TG_BOT_TOKEN", KC_BOT_TOKEN)
  const clientId = (yield* secretOrEnv("TG_LOGIN_CLIENT_ID", KC_LOGIN_CLIENT_ID)) ?? botToken?.split(":")[0]
  const clientSecret = yield* secretOrEnv("TG_LOGIN_CLIENT_SECRET", KC_LOGIN_CLIENT_SECRET)
  // The issuer's discovery document names the token endpoint (which receives the
  // client secret) and the signing keys, so only Telegram or a loopback test issuer.
  const issuer = yield* Config.String("BUDDYTG_TELEGRAM_OIDC_ISSUER").pipe(Config.withDefault(TELEGRAM_OIDC_ISSUER))
  if (issuer !== TELEGRAM_OIDC_ISSUER && !isLoopbackOrigin(issuer)) {
    return yield* configError("BUDDYTG_TELEGRAM_OIDC_ISSUER must be https://oauth.telegram.org or a loopback http:// origin")
  }
  // Without it the server still starts, so tunnels and discovery can be checked first.
  const telegram = clientId && /^[1-9][0-9]*$/.test(clientId) && clientSecret
    ? { issuer, clientId, clientSecret }
    : undefined

  const allowedEnv = Option.getOrUndefined(yield* Config.option(Config.String("BUDDYTG_MCP_ALLOWED_IDS")))
  const allowed = (allowedEnv ?? (yield* secretOrEnv("TG_BOT_CHAT_ID", KC_CHAT_ID)) ?? "")
    .split(",").map((id) => id.trim()).filter((id) => /^[1-9][0-9]*$/.test(id))
  if (allowed.length === 0) {
    return yield* configError("No Telegram account is allowed to sign in. Run `buddytg notify Ready` once, or set BUDDYTG_MCP_ALLOWED_IDS.")
  }

  return {
    ...options,
    baseUrl,
    secret: secretBytes,
    telegram,
    allowedUserIds: new Set(allowed),
  } satisfies HttpConfig
})

export interface HttpConfig extends HttpOptions {
  readonly baseUrl: URL
  readonly secret: Uint8Array
  readonly telegram: { readonly issuer: string; readonly clientId: string; readonly clientSecret: string } | undefined
  readonly allowedUserIds: ReadonlySet<string>
}

/**
 * Streamable HTTP, 2026-07-28 stateless: every POST builds a fresh server from the
 * factory and nothing survives the request. 2025-era clients are served the same
 * way, per request, without sessions.
 */
export const createHttpApp = (config: HttpConfig, run?: CliRunner) => {
  const resource = new URL("/mcp", config.baseUrl)
  const auth = createAuthServer({ ...config, resource })
  const mcp = createMcpHandler(() => buildServer(run, { localFiles: false }), { responseMode: "sse" })
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource)
  const gate = requireBearerAuth({
    verifier: { verifyAccessToken: auth.verifyAccessToken },
    requiredScopes: [SCOPE],
    resourceMetadataUrl,
    expectedResource: resource,
  })
  const hostnames = [...new Set([config.baseUrl.hostname, ...localhostAllowedHostnames()])]

  const fetch = async (request: Request): Promise<Response> => {
    const rejected = hostHeaderValidationResponse(request, hostnames)
    if (rejected) return rejected
    const metadata = oauthMetadataResponse(request, { oauthMetadata: auth.metadata, resourceServerUrl: resource, scopesSupported: [SCOPE], resourceName: "BuddyTG" })
    if (metadata) return metadata
    const owned = auth.route(request)
    if (owned) return owned
    if (new URL(request.url).pathname !== resource.pathname) return new Response("Not found", { status: 404 })

    const badOrigin = originValidationResponse(request, hostnames)
    if (badOrigin) return badOrigin
    const authInfo = await gate(request)
    if (authInfo instanceof Response) return authInfo
    return mcp.fetch(request, { authInfo })
  }

  return { fetch, close: () => mcp.close(), resource, endpoints: auth.endpoints }
}

export const runHttp = Effect.fn("runHttp")(function* (options: HttpOptions, run?: CliRunner) {
  const config = yield* loadHttpConfig(options)
  // One resource so the close order stays: MCP handler first, then the listener.
  const { app, server } = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const app = createHttpApp(config, run)
        const server = Bun.serve({
          hostname: config.host,
          port: config.port,
          fetch: app.fetch,
          // Long `ask` calls keep an SSE response open for up to an hour.
          idleTimeout: 0,
          maxRequestBodySize: 4 * 1024 * 1024,
          // Never serve Bun's development error page with stack traces.
          development: false,
        })
        return { app, server }
      },
      catch: (error) =>
        configError(`Cannot listen on ${config.host}:${config.port}: ${error instanceof Error ? error.message : String(error)}`),
    }),
    ({ app, server }) => boundedCleanup(async () => {
      await app.close().catch(() => {})
      await server.stop(true)
    }),
  )
  yield* Console.error(`BuddyTG MCP server: ${app.resource.href} (listening on ${server.hostname}:${server.port})`)
  yield* Console.error(`Login Widget Allowed URLs in @BotFather: ${config.baseUrl.origin} and ${app.endpoints.telegramCallback}`)
  if (!config.telegram) {
    yield* Console.error("Log in with Telegram is not set up yet: run `buddytg mcp setup`, then restart. Sign-ins are refused until then.")
  }
  return yield* Effect.never
}, Effect.scoped)
