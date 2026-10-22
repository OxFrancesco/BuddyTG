/**
 * End to end over real sockets: the official v2 MCP client (pinned to 2026-07-28)
 * discovers the authorization server, registers, goes through the consent page and
 * "Log in with Telegram", and calls tools. Telegram's OIDC provider is replaced by a
 * local one that signs id_tokens the way oauth.telegram.org does; the CLI runner is
 * replaced so nothing reaches a real Telegram account.
 */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/client"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { createHttpApp, type HttpConfig } from "./serve"

const OWNER = "4242"
const TG_CLIENT_ID = "777000111"
const TG_SECRET = "botfather-login-secret"

let telegramUser = OWNER
const cliCalls: string[][] = []
const telegram = await (async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256")
  const jwk = { ...(await exportJWK(publicKey)), kid: "oidc-1", alg: "RS256", use: "sig" }
  const codes = new Map<string, { challenge: string; nonce: string; redirectUri: string }>()
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url)
      const issuer: string = `http://localhost:${server.port}`
      if (url.pathname === "/.well-known/openid-configuration") {
        return Response.json({ issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/.well-known/jwks.json` })
      }
      if (url.pathname === "/.well-known/jwks.json") return Response.json({ keys: [jwk] })
      if (url.pathname === "/auth") {
        // Stands in for the user confirming the login inside Telegram.
        const p = url.searchParams
        if (p.get("client_id") !== TG_CLIENT_ID || p.get("code_challenge_method") !== "S256" || p.get("scope") !== "openid profile") {
          return new Response("bad request", { status: 400 })
        }
        const code = randomUUID()
        codes.set(code, { challenge: p.get("code_challenge")!, nonce: p.get("nonce")!, redirectUri: p.get("redirect_uri")! })
        const back = new URL(p.get("redirect_uri")!)
        back.searchParams.set("code", code)
        back.searchParams.set("state", p.get("state")!)
        return Response.redirect(back.href, 302)
      }
      if (url.pathname === "/token" && request.method === "POST") {
        if (request.headers.get("authorization") !== `Basic ${btoa(`${TG_CLIENT_ID}:${TG_SECRET}`)}`) return Response.json({ error: "invalid_client" }, { status: 401 })
        const form = new URLSearchParams(await request.text())
        const entry = codes.get(form.get("code") ?? "")
        codes.delete(form.get("code") ?? "")
        const verifier = form.get("code_verifier") ?? ""
        if (!entry || entry.redirectUri !== form.get("redirect_uri") || createHash("sha256").update(verifier).digest("base64url") !== entry.challenge) {
          return Response.json({ error: "invalid_grant" }, { status: 400 })
        }
        const idToken = await new SignJWT({ id: Number(telegramUser), name: "Francesco Oddo", preferred_username: "Francesco_Oddo", nonce: entry.nonce })
          .setProtectedHeader({ alg: "RS256", kid: "oidc-1" })
          .setIssuer(issuer).setAudience(TG_CLIENT_ID).setSubject("1234123412341234123").setIssuedAt().setExpirationTime("1h")
          .sign(privateKey)
        return Response.json({ access_token: "tg-at", token_type: "Bearer", expires_in: 3600, id_token: idToken })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return server
})()

let app: ReturnType<typeof createHttpApp>
let config: HttpConfig
const fakeCli = async (argv: string[]) => {
  cliCalls.push(argv)
  return argv[0] === "whoami" ? `Francesco Oddo (@Francesco_Oddo, id ${OWNER})` : "Sent (message id 1)."
}
let buddy: ReturnType<typeof Bun.serve>
let mcpUrl: URL

beforeAll(() => {
  buddy = Bun.serve({ port: 0, fetch: (r) => app.fetch(r), idleTimeout: 0 })
  const baseUrl = new URL(`http://localhost:${buddy.port}`)
  config = {
    host: "127.0.0.1",
    port: buddy.port!,
    baseUrl,
    secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
    telegram: { issuer: `http://localhost:${telegram.port}`, clientId: TG_CLIENT_ID, clientSecret: TG_SECRET },
    allowedUserIds: new Set([OWNER]),
  }
  app = createHttpApp(config, fakeCli)
  mcpUrl = new URL("/mcp", baseUrl)
})

afterAll(async () => {
  await app.close()
  buddy.stop(true)
  telegram.stop(true)
})

const REDIRECT = "http://127.0.0.1:53682/callback"

const memoryProvider = () => {
  const store: { client?: any; tokens?: any; verifier?: string; authUrl?: URL; discovery?: any } = {}
  const provider: OAuthClientProvider = {
    redirectUrl: REDIRECT,
    clientMetadata: { client_name: "E2E Client", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
    clientInformation: () => store.client,
    saveClientInformation: (info) => { store.client = info },
    tokens: () => store.tokens,
    saveTokens: (tokens) => { store.tokens = tokens },
    redirectToAuthorization: (url) => { store.authUrl = url },
    saveCodeVerifier: (v) => { store.verifier = v },
    codeVerifier: () => store.verifier!,
    saveDiscoveryState: (state) => { store.discovery = state },
    discoveryState: () => store.discovery,
  }
  return { provider, store }
}

/** A browser profile: one cookie jar for the BuddyTG origin. */
const browser = () => {
  const jar = new Map<string, string>()
  const request = async (url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (url.port === String(buddy.port) && jar.size > 0) {
      headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "))
    }
    const res = await fetch(url, { ...init, headers, redirect: "manual" })
    if (url.port === String(buddy.port)) {
      for (const cookie of res.headers.getSetCookie()) {
        const [pair, ...attributes] = cookie.split(";")
        const [name, ...value] = pair!.trim().split("=")
        if (attributes.some((a) => a.trim().toLowerCase() === "max-age=0")) jar.delete(name!)
        else jar.set(name!, value.join("="))
      }
    }
    return res
  }
  /** Follows redirects by hand until the client's redirect URI (which is not served). */
  const follow = async (first: Response, from: URL) => {
    const hops: Response[] = [first]
    let location = first.headers.get("location")
    let next = location ? new URL(location, from) : undefined
    while (next && !next.href.startsWith(REDIRECT)) {
      const res = await request(next)
      hops.push(res)
      location = res.headers.get("location")
      next = location ? new URL(location, next) : undefined
    }
    return { callback: next, hops }
  }
  /** Consent page, then a click on "Log in with Telegram" (a same-origin form POST). */
  const consent = async (authUrl: URL) => {
    const page = await request(authUrl)
    const html = await page.text()
    const value = html.match(/name="request" value="([^"]+)"/)?.[1]
    return { page, html, value }
  }
  const approve = (value: string, origin = `http://localhost:${buddy.port}`) => {
    const url = new URL("/authorize", mcpUrl)
    return request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin },
      body: new URLSearchParams({ request: value }),
    })
  }
  return { request, follow, consent, approve, jar }
}

const browse = async (authUrl: URL) => {
  const owner = browser()
  const { page: consent, html, value } = await owner.consent(authUrl)
  if (!value) return { consent, html, callback: undefined, hops: [] as Response[] }
  const approved = await owner.approve(value)
  const { callback, hops } = await owner.follow(approved, new URL("/authorize", mcpUrl))
  return { consent, html, callback, hops }
}

const connect = (provider: OAuthClientProvider) => {
  const client = new Client({ name: "e2e", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } })
  const transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider })
  return { client, transport, open: () => client.connect(transport) }
}

test("unauthenticated requests get a 401 that points at the protected resource metadata", async () => {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }),
  })
  expect(res.status).toBe(401)
  const challenge = res.headers.get("www-authenticate") ?? ""
  expect(challenge).toContain(`resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", mcpUrl).href}"`)

  const prm = await (await fetch(new URL("/.well-known/oauth-protected-resource/mcp", mcpUrl))).json() as { resource: string; authorization_servers: string[]; scopes_supported: string[] }
  expect(prm.resource).toBe(mcpUrl.href)
  expect(prm.scopes_supported).toEqual(["telegram"])
  const as = await (await fetch(new URL("/.well-known/oauth-authorization-server", prm.authorization_servers[0]))).json() as Record<string, unknown>
  expect(as.code_challenge_methods_supported).toEqual(["S256"])
  expect(as.client_id_metadata_document_supported).toBe(true)
})

test("the owner logs in with Telegram, then lists and calls tools over 2026-07-28", async () => {
  const { provider, store } = memoryProvider()
  const first = connect(provider)
  await expect(first.open()).rejects.toBeInstanceOf(UnauthorizedError)
  expect(store.client?.client_id).toBeString()

  const { consent, html, callback } = await browse(store.authUrl!)
  expect(consent.status).toBe(200)
  expect(html).toContain("Connect E2E Client")
  expect(html).toContain("127.0.0.1:53682")
  // GET /authorize must not hand out a Telegram login URL.
  expect(html).not.toContain(`localhost:${telegram.port}`)
  expect(callback?.searchParams.get("iss")).toBe(new URL(mcpUrl).origin)
  await first.transport.finishAuth(callback!.searchParams)
  expect(store.tokens?.access_token).toBeString()
  expect(store.tokens?.refresh_token).toBeString()

  const second = connect(provider)
  await second.open()
  const { tools } = await second.client.listTools()
  expect(tools.map((t) => t.name)).toEqual(["buddytg_whoami", "buddytg_chats", "buddytg_send", "buddytg_notify", "buddytg_ask"])

  const whoami = await second.client.callTool({ name: "buddytg_whoami", arguments: {} })
  expect(whoami.content).toEqual([{ type: "text", text: `Francesco Oddo (@Francesco_Oddo, id ${OWNER})` }])
  const sent = await second.client.callTool({ name: "buddytg_send", arguments: { recipientId: OWNER, message: "--not a flag" } })
  expect(sent.isError).toBeFalsy()
  expect(cliCalls.at(-1)).toEqual(["send", OWNER, "--not a flag"])
  await second.client.close()
})

test("codes and refresh tokens work once; refresh rotates", async () => {
  const { provider, store } = memoryProvider()
  const first = connect(provider)
  await first.open().catch(() => {})
  const { callback } = await browse(store.authUrl!)
  const code = callback!.searchParams.get("code")!
  const token = (body: Record<string, string>) =>
    fetch(new URL("/token", mcpUrl), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) })

  const exchange = { grant_type: "authorization_code", code, client_id: store.client.client_id, redirect_uri: REDIRECT, code_verifier: store.verifier!, resource: mcpUrl.href }
  const ok = await token(exchange)
  expect(ok.status).toBe(200)
  const pair = await ok.json() as { refresh_token: string }
  expect((await token(exchange)).status).toBe(400)

  const refresh = { grant_type: "refresh_token", refresh_token: pair.refresh_token, client_id: store.client.client_id }
  const rotated = await token(refresh)
  expect(rotated.status).toBe(200)
  expect(((await rotated.json()) as { refresh_token: string }).refresh_token).not.toBe(pair.refresh_token)
  expect((await token(refresh)).status).toBe(400)
})

test("a Telegram account that is not the owner is refused after login", async () => {
  telegramUser = "9999"
  try {
    const { provider, store } = memoryProvider()
    await connect(provider).open().catch(() => {})
    const { hops, callback } = await browse(store.authUrl!)
    expect(callback).toBeUndefined()
    const last = hops.at(-1)!
    expect(last.status).toBe(403)
    expect(await last.text()).toContain("Only the Telegram account that owns this BuddyTG server can connect.")
  } finally {
    telegramUser = OWNER
  }
})

test("an unregistered redirect URI never leaves the server", async () => {
  const { provider, store } = memoryProvider()
  await connect(provider).open().catch(() => {})
  const hijacked = new URL(store.authUrl!)
  hijacked.searchParams.set("redirect_uri", "https://evil.example/cb")
  const res = await fetch(hijacked, { redirect: "manual" })
  expect(res.status).toBe(400)
  expect(res.headers.get("location")).toBeNull()
})

test("a Telegram login link opened without the consent cookie cannot complete", async () => {
  // The attacker registers a client, approves the consent page in their own browser
  // and sends only the resulting Telegram link to the owner.
  const { provider, store } = memoryProvider()
  await connect(provider).open().catch(() => {})
  const attacker = browser()
  const { value } = await attacker.consent(store.authUrl!)
  const approved = await attacker.approve(value!)
  expect(approved.status).toBe(303)
  const telegramLink = new URL(approved.headers.get("location")!)
  expect(telegramLink.port).toBe(String(telegram.port))

  // The owner opens it in their own browser, which never saw the consent page.
  const owner = browser()
  const atTelegram = await owner.request(telegramLink)
  const { callback, hops } = await owner.follow(atTelegram, telegramLink)
  expect(callback).toBeUndefined()
  const last = hops.at(-1)!
  expect(last.status).toBe(400)
  expect(last.headers.get("location")).toBeNull()
  expect(await last.text()).toContain("Finish the login in the browser where you approved it")
})

test("a cross-site form post to the consent endpoint is refused", async () => {
  const { provider, store } = memoryProvider()
  await connect(provider).open().catch(() => {})
  const visitor = browser()
  const { value } = await visitor.consent(store.authUrl!)
  const res = await visitor.approve(value!, "https://evil.example")
  expect(res.status).toBe(403)
  expect(res.headers.get("location")).toBeNull()
  expect(res.headers.get("set-cookie")).toBeNull()
})

test("errors before consent are shown, never redirected to a registered URI", async () => {
  const { provider, store } = memoryProvider()
  await connect(provider).open().catch(() => {})
  const bad = new URL(store.authUrl!)
  bad.searchParams.set("response_type", "token")
  const res = await fetch(bad, { redirect: "manual" })
  expect(res.status).toBe(400)
  expect(res.headers.get("location")).toBeNull()
})

test("a client metadata URL on a loopback or private address is not fetched", async () => {
  let hits = 0
  const internal = Bun.serve({ port: 0, fetch: () => { hits += 1; return Response.json({}) } })
  try {
    for (const host of [`127.0.0.1:${internal.port}`, `localhost:${internal.port}`, "10.0.0.1", "[::ffff:7f00:1]", "169.254.169.254"]) {
      const authUrl = new URL("/authorize", mcpUrl)
      authUrl.search = new URLSearchParams({ client_id: `https://${host}/client.json`, redirect_uri: REDIRECT, response_type: "code" }).toString()
      const res = await fetch(authUrl, { redirect: "manual" })
      expect(res.status).toBe(400)
      expect(await res.text()).toContain("Could not load a valid client metadata document")
    }
    expect(hits).toBe(0)
  } finally {
    internal.stop(true)
  }
})

test("a failed code redemption does not burn the code for the real client", async () => {
  const { provider, store } = memoryProvider()
  await connect(provider).open().catch(() => {})
  const { callback } = await browse(store.authUrl!)
  const code = callback!.searchParams.get("code")!
  const token = (body: Record<string, string>) =>
    fetch(new URL("/token", mcpUrl), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) })
  const exchange = { grant_type: "authorization_code", code, client_id: store.client.client_id, redirect_uri: REDIRECT, code_verifier: store.verifier!, resource: mcpUrl.href }
  expect((await token({ ...exchange, code_verifier: "x".repeat(43) })).status).toBe(400)
  expect((await token(exchange)).status).toBe(200)
})
