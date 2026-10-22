/**
 * OAuth 2.1 authorization server for the BuddyTG MCP endpoint, with
 * "Log in with Telegram" (Telegram's OpenID Connect provider) as the only way in.
 *
 * Nothing is stored server-side. Client registrations, the in-flight Telegram
 * login, authorization codes and tokens are all JWTs: signed (JWS, HS256) when the
 * holder may read them, encrypted (JWE, dir + A256GCM) when they carry a PKCE
 * verifier or must stay opaque. Both keys derive from one secret, so rotating it
 * revokes every client, code and token at once.
 *
 * The only process memory is a short replay cache for codes and refresh tokens.
 * Losing it on restart weakens replay protection, never authorization; grants also
 * have an absolute lifetime that rotation does not extend.
 *
 * The consent page is a same-origin form. Submitting it sets a short-lived cookie
 * whose hash is sealed into the Telegram login state, so the Telegram callback only
 * completes in the browser that saw (and approved) the consent page.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import {
  createRemoteJWKSet,
  EncryptJWT,
  jwtDecrypt,
  jwtVerify,
  SignJWT,
  type JWTPayload,
} from "jose"
import type { AuthInfo, OAuthMetadata } from "@modelcontextprotocol/server"
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server"

export const SCOPE = "telegram"
const ACCESS_TTL = 60 * 60
const REFRESH_TTL = 30 * 24 * 60 * 60
const CODE_TTL = 120
const LOGIN_TTL = 10 * 60
const MAX_METADATA_BYTES = 16_384
const MAX_REPLAY_ENTRIES = 50_000

export interface TelegramLoginConfig {
  /** Telegram OIDC issuer. Overridable for tests only. */
  readonly issuer: string
  /** Numeric bot ID shown as Client ID in @BotFather → Bot Settings → Login Widget. */
  readonly clientId: string
  readonly clientSecret: string
}

export interface AuthServerConfig {
  /** Public origin clients reach, e.g. https://buddytg.example.com */
  readonly baseUrl: URL
  /** The MCP endpoint; also the token audience (RFC 8707 resource). */
  readonly resource: URL
  readonly secret: Uint8Array
  /** Undefined until `buddytg mcp setup` has stored the Login Widget credentials. */
  readonly telegram: TelegramLoginConfig | undefined
  /** Telegram user IDs allowed to sign in. Everyone else is refused after login. */
  readonly allowedUserIds: ReadonlySet<string>
  readonly fetch?: typeof fetch
  /** Tests only: allow Client ID Metadata Documents on loopback/private addresses. */
  readonly allowPrivateClientMetadata?: boolean
}

interface ClientInfo {
  readonly clientId: string
  readonly clientName: string
  readonly redirectUris: ReadonlyArray<string>
}

interface PendingAuthorization {
  readonly clientId: string
  readonly clientName: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly state?: string
  readonly scope: string
}

const derive = (secret: Uint8Array, label: string) => new Uint8Array(createHmac("sha256", secret).update(label).digest())
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url")
const sha256 = (value: string) => b64url(createHash("sha256").update(value).digest())
const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export const generateSecret = () => b64url(randomBytes(32))

/** Loopback over http, or https, with no fragment and no userinfo. */
export const isAcceptableRedirectUri = (raw: string) => {
  if (!URL.canParse(raw)) return false
  const url = new URL(raw)
  if (url.hash || url.username || url.password) return false
  if (url.protocol === "https:") return true
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
}

/**
 * Remembers single-use JWT IDs until they would have expired anyway. Bounded:
 * when full of unexpired entries it refuses new claims (fails closed).
 */
class ReplayCache {
  readonly #seen = new Map<string, number>()
  #sweptAt = 0
  claim(jti: string | undefined, exp: number | undefined) {
    if (!jti || !exp) return false
    const now = Date.now() / 1000
    if (now - this.#sweptAt >= 1 || this.#seen.size >= MAX_REPLAY_ENTRIES) {
      this.#sweptAt = now
      for (const [key, expiry] of this.#seen) if (expiry < now) this.#seen.delete(key)
    }
    if (this.#seen.has(jti) || this.#seen.size >= MAX_REPLAY_ENTRIES) return false
    this.#seen.set(jti, exp)
    return true
  }
}

/** Loopback, private, link-local, CGNAT, multicast and reserved ranges are not client hosts. */
export const isPublicAddress = (address: string): boolean => {
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPublicAddress(mapped[1]!)
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number]
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
    )
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase()
    // Unique-local, link-local, multicast, and anything embedding an IPv4 address
    // (::/96 compatible, ::ffff: mapped, 64:ff9b:: NAT64, 2002:: 6to4) is refused.
    return !(lower.startsWith("::") || /^f[cd]/.test(lower) || /^fe[89a-f]/.test(lower) || /^ff/.test(lower)
      || /^64:ff9b:/.test(lower) || /^2002:/.test(lower))
  }
  return false
}

const assertPublicHost = async (hostname: string) => {
  const host = hostname.replace(/^\[|\]$/g, "")
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address)
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) throw new Error("client metadata host is not public")
}

/** Read at most `limit` bytes of a response body. */
const readLimited = async (response: Response, limit: number) => {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      throw new Error("client metadata document is too large")
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

class AuthorizeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export const createAuthServer = (config: AuthServerConfig) => {
  const signKey = derive(config.secret, "buddytg-mcp/jws")
  const encKey = derive(config.secret, "buddytg-mcp/jwe")
  const issuer = config.baseUrl.origin
  const resource = config.resource.href
  // Separate caches: login traffic must never crowd out codes and refresh tokens.
  const loginReplay = new ReplayCache()
  const grantReplay = new ReplayCache()
  const http = config.fetch ?? fetch

  const url = (path: string) => new URL(path, config.baseUrl).href
  const endpoints = {
    authorize: url("/authorize"),
    token: url("/token"),
    register: url("/register"),
    telegramCallback: url("/oauth/telegram/callback"),
  }

  const sign = (typ: string, payload: JWTPayload, ttl?: number) => {
    const jwt = new SignJWT(payload).setProtectedHeader({ alg: "HS256", typ }).setIssuer(issuer).setIssuedAt()
    return (ttl ? jwt.setExpirationTime(`${ttl}s`) : jwt).sign(signKey)
  }
  const verify = async (typ: string, token: string, audience?: string) =>
    (await jwtVerify(token, signKey, { typ, issuer, audience, algorithms: ["HS256"] })).payload
  const seal = (typ: string, payload: JWTPayload, ttl: number) =>
    new EncryptJWT(payload)
      .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ })
      .setIssuer(issuer)
      .setIssuedAt()
      .setJti(b64url(randomBytes(16)))
      .setExpirationTime(`${Math.max(1, Math.floor(ttl))}s`)
      .encrypt(encKey)
  const unseal = async (typ: string, token: string) =>
    (await jwtDecrypt(token, encKey, { typ, issuer, keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"] })).payload

  // ---- Telegram OpenID Connect -------------------------------------------------

  let discovery: Promise<{ authorization_endpoint: string; token_endpoint: string; jwks_uri: string }> | undefined
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined
  const login = () => {
    if (!config.telegram) throw new Error("Log in with Telegram is not configured")
    return config.telegram
  }
  const telegram = () =>
    (discovery ??= http(new URL("/.well-known/openid-configuration", login().issuer)).then(async (res) => {
      if (!res.ok) throw new Error(`Telegram OIDC discovery failed (${res.status})`)
      const doc = await res.json() as { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
      if (doc.issuer !== login().issuer) throw new Error("Telegram OIDC issuer mismatch")
      jwks = createRemoteJWKSet(new URL(doc.jwks_uri))
      return doc
    }).catch((error) => {
      discovery = undefined
      throw error
    }))

  // ---- Client identification: Client ID Metadata Documents and stateless DCR ---

  const resolveClient = async (clientId: string): Promise<ClientInfo> => {
    if (clientId.startsWith("https://")) return fetchClientMetadata(clientId)
    const claims = await verify("buddytg-client+jwt", clientId).catch(() => {
      throw new AuthorizeError("invalid_client", "Unknown client. Register again.")
    })
    return {
      clientId,
      clientName: typeof claims.client_name === "string" ? claims.client_name : "MCP client",
      redirectUris: Array.isArray(claims.redirect_uris) ? claims.redirect_uris.filter((u): u is string => typeof u === "string") : [],
    }
  }

  /**
   * Fetching a client-chosen URL from an unauthenticated endpoint: public hosts
   * only, a hard size cap, and one generic error so the endpoint is no probe.
   */
  const fetchClientMetadata = async (clientId: string): Promise<ClientInfo> => {
    const target = URL.canParse(clientId) ? new URL(clientId) : undefined
    if (!target || target.pathname === "/" || target.hash || target.username || target.password) {
      throw new AuthorizeError("invalid_client", "client_id URL must have a path")
    }
    let doc: { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown }
    try {
      if (!config.allowPrivateClientMetadata) await assertPublicHost(target.hostname)
      const res = await http(target, { redirect: "error", signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } })
      if (!res.ok) throw new Error(`status ${res.status}`)
      doc = JSON.parse(await readLimited(res, MAX_METADATA_BYTES))
      if (doc?.client_id !== clientId) throw new Error("client_id mismatch")
    } catch {
      throw new AuthorizeError("invalid_client", "Could not load a valid client metadata document")
    }
    const redirectUris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((u): u is string => typeof u === "string" && isAcceptableRedirectUri(u)) : []
    // The name is chosen by the client; the verified part is the client_id host.
    const name = typeof doc.client_name === "string" ? `${doc.client_name.slice(0, 100)} (${target.hostname})` : target.hostname
    return { clientId, clientName: name, redirectUris }
  }

  const register = async (request: Request) => {
    const body = await request.json().catch(() => null) as { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown } | null
    const redirectUris = Array.isArray(body?.redirect_uris) ? body.redirect_uris : []
    if (redirectUris.length === 0 || redirectUris.length > 10 || !redirectUris.every((u) => typeof u === "string" && isAcceptableRedirectUri(u))) {
      return json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be https or loopback http URLs" }, 400)
    }
    if (body?.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
      return json({ error: "invalid_client_metadata", error_description: "Only public clients (token_endpoint_auth_method=none) are supported" }, 400)
    }
    const clientName = typeof body?.client_name === "string" ? body.client_name.slice(0, 100) : "MCP client"
    const clientId = await sign("buddytg-client+jwt", { client_name: clientName, redirect_uris: redirectUris })
    return json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, 201)
  }

  // ---- /authorize → consent page → Telegram → /oauth/telegram/callback ---------

  // One cookie per login flow, so a second consent in the same browser does not break the first.
  const loginCookiePrefix = config.baseUrl.protocol === "https:" ? "__Host-buddytg-login" : "buddytg-login"
  const loginCookie = (flow: string) => `${loginCookiePrefix}-${flow}`
  const cookieAttributes = `Path=/; HttpOnly; SameSite=Lax${config.baseUrl.protocol === "https:" ? "; Secure" : ""}`

  /** GET: validate the request and show the consent page. Nothing here reaches Telegram yet. */
  const authorize = async (request: Request) => {
    if (!config.telegram) return page("Not set up yet", "Log in with Telegram isn't configured on this server. Run buddytg mcp setup on the host.", 503)
    const params = new URL(request.url).searchParams
    const clientId = params.get("client_id") ?? ""
    const redirectUri = params.get("redirect_uri") ?? ""
    let client: ClientInfo
    try {
      client = await resolveClient(clientId)
    } catch (error) {
      return page("Can't continue", error instanceof Error ? error.message : "Unknown client.", 400)
    }
    // Never redirect to a URI the client did not register.
    if (!client.redirectUris.includes(redirectUri)) return page("Can't continue", "This redirect address is not registered for the client.", 400)

    // Anyone can register a client, so errors before consent are shown here, never redirected.
    if (params.get("response_type") !== "code") return page("Can't continue", "response_type must be code.", 400)
    const codeChallenge = params.get("code_challenge") ?? ""
    if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
      return page("Can't continue", "PKCE with S256 is required.", 400)
    }
    const requested = params.get("resource")
    if (requested !== null && !sameResource(requested, resource)) return page("Can't continue", "Unknown resource.", 400)
    const scope = params.get("scope") ?? SCOPE
    if (!scope.split(" ").every((s) => s === SCOPE)) return page("Can't continue", `Only the "${SCOPE}" scope exists.`, 400)

    const pending: PendingAuthorization = {
      clientId,
      clientName: client.clientName,
      redirectUri,
      codeChallenge,
      scope: SCOPE,
      ...(params.get("state") === null ? {} : { state: params.get("state")! }),
    }
    const oidc = await telegram().catch(() => null)
    if (!oidc) return page("Can't continue", "Telegram login is unreachable right now. Try again in a minute.", 502)
    const consent = await seal("buddytg-consent+jwt", { pending: { ...pending } }, LOGIN_TTL)
    return consentPage(client.clientName, new URL(redirectUri).host, consent, new URL(oidc.authorization_endpoint).origin)
  }

  /**
   * POST from the consent page: bind this browser with a cookie, then hand off to
   * Telegram. A cross-site form or a link opened elsewhere cannot get here.
   */
  const approve = async (request: Request) => {
    if (!config.telegram) return page("Not set up yet", "Log in with Telegram isn't configured on this server.", 503)
    const origin = request.headers.get("origin")
    const sameOrigin = origin === null ? request.headers.get("sec-fetch-site") === "same-origin" : origin === issuer
    if (!sameOrigin) return page("Can't continue", "Start again from your MCP client.", 403)
    let pending: PendingAuthorization
    try {
      const form = new URLSearchParams(await request.text())
      pending = (await unseal("buddytg-consent+jwt", form.get("request") ?? "")).pending as PendingAuthorization
    } catch {
      return page("Consent expired", "Start again from your MCP client.", 400)
    }
    const flow = b64url(randomBytes(9))
    const binding = b64url(randomBytes(32))
    const loginUrl = await telegramLoginUrl(pending, flow, sha256(binding)).catch(() => null)
    if (!loginUrl) return page("Can't continue", "Telegram login is unreachable right now. Try again in a minute.", 502)
    return new Response(null, {
      status: 303,
      headers: {
        location: loginUrl,
        "cache-control": "no-store",
        "set-cookie": `${loginCookie(flow)}=${binding}; ${cookieAttributes}; Max-Age=${LOGIN_TTL}`,
      },
    })
  }

  const telegramLoginUrl = async (pending: PendingAuthorization, flow: string, binding: string) => {
    const oidc = await telegram()
    const verifier = b64url(randomBytes(32))
    const nonce = b64url(randomBytes(16))
    const state = await seal("buddytg-login+jwt", { pending: { ...pending }, verifier, nonce, flow, binding }, LOGIN_TTL)
    const target = new URL(oidc.authorization_endpoint)
    target.search = new URLSearchParams({
      client_id: login().clientId,
      redirect_uri: endpoints.telegramCallback,
      response_type: "code",
      scope: "openid profile",
      state,
      nonce,
      code_challenge: sha256(verifier),
      code_challenge_method: "S256",
    }).toString()
    return target.href
  }

  const cookieValue = (request: Request, name: string) => {
    for (const part of (request.headers.get("cookie") ?? "").split(";")) {
      const [key, ...value] = part.trim().split("=")
      if (key === name) return value.join("=")
    }
    return undefined
  }

  const telegramCallback = async (request: Request) => {
    const params = new URL(request.url).searchParams
    let login: JWTPayload
    try {
      login = await unseal("buddytg-login+jwt", params.get("state") ?? "")
    } catch {
      return page("Login expired", "Start again from your MCP client.", 400)
    }
    const flow = typeof login.flow === "string" && /^[A-Za-z0-9_-]{12}$/.test(login.flow) ? login.flow : undefined
    const cookie = flow ? cookieValue(request, loginCookie(flow)) : undefined
    if (!flow || !cookie || typeof login.binding !== "string" || !safeEqual(sha256(cookie), login.binding)) {
      return page("Login expired", "Finish the login in the browser where you approved it. Start again from your MCP client.", 400)
    }
    // The cookie matched, so this browser owns the flow: clear its cookie now.
    const response = await completeTelegramLogin(params, login)
    const headers = new Headers(response.headers)
    headers.append("set-cookie", `${loginCookie(flow)}=; ${cookieAttributes}; Max-Age=0`)
    return new Response(response.body, { status: response.status, headers })
  }

  const completeTelegramLogin = async (params: URLSearchParams, login: JWTPayload) => {
    const pending = login.pending as PendingAuthorization
    const back = (query: Record<string, string | null | undefined>) => redirect(pending.redirectUri, { ...query, state: pending.state, iss: issuer })

    if (params.has("error")) return back({ error: "access_denied", error_description: "Telegram login was cancelled" })
    const code = params.get("code")
    if (!code) return back({ error: "server_error", error_description: "Telegram returned no code" })

    let user: { id: string; name: string }
    try {
      user = await exchangeTelegramCode(code, String(login.verifier), String(login.nonce))
    } catch {
      return back({ error: "server_error", error_description: "Telegram login could not be verified" })
    }
    if (!config.allowedUserIds.has(user.id)) {
      return page("Not allowed", "Only the Telegram account that owns this BuddyTG server can connect.", 403)
    }
    // Claimed only after a verified login by an allowed account, so nobody else can fill the cache.
    if (!loginReplay.claim(login.jti, login.exp)) return page("Login already used", "Start again from your MCP client.", 400)

    const authCode = await seal("buddytg-code+jwt", {
      client_id: pending.clientId,
      redirect_uri: pending.redirectUri,
      code_challenge: pending.codeChallenge,
      scope: pending.scope,
      sub: user.id,
      name: user.name,
      auth_time: Math.floor(Date.now() / 1000),
    }, CODE_TTL)
    return back({ code: authCode })
  }

  const exchangeTelegramCode = async (code: string, verifier: string, nonce: string) => {
    const oidc = await telegram()
    const { clientId, clientSecret, issuer: telegramIssuer } = login()
    const res = await http(oidc.token_endpoint, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: endpoints.telegramCallback,
        client_id: clientId,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    const body = await res.json().catch(() => ({})) as { id_token?: string }
    if (!res.ok || typeof body.id_token !== "string") throw new Error("Telegram token exchange failed")
    // RS256 and ES256 are the algorithms Telegram allows with the profile scope.
    const { payload } = await jwtVerify(body.id_token, jwks!, {
      issuer: telegramIssuer,
      audience: clientId,
      algorithms: ["RS256", "ES256"],
    })
    if (payload.nonce !== nonce) throw new Error("nonce mismatch")
    // `sub` is a pairwise identifier. The Telegram user ID is the `id` claim.
    const id = typeof payload.id === "number" || typeof payload.id === "string" ? String(payload.id) : ""
    if (!/^[1-9][0-9]{0,15}$/.test(id)) throw new Error("id_token has no Telegram user id")
    const name = typeof payload.name === "string" ? payload.name : typeof payload.preferred_username === "string" ? payload.preferred_username : id
    return { id, name }
  }

  // ---- /token -----------------------------------------------------------------

  const token = async (request: Request) => {
    const form = new URLSearchParams(await request.text())
    const grant = form.get("grant_type")
    const requested = form.get("resource")
    if (requested !== null && !sameResource(requested, resource)) return tokenError("invalid_target", "Unknown resource")
    try {
      if (grant === "authorization_code") return await redeemCode(form)
      if (grant === "refresh_token") return await redeemRefresh(form)
      return tokenError("unsupported_grant_type", "Use authorization_code or refresh_token")
    } catch (error) {
      if (error instanceof AuthorizeError) return tokenError(error.code, error.message)
      return tokenError("invalid_grant", "Invalid or expired grant")
    }
  }

  const redeemCode = async (form: URLSearchParams) => {
    const code = await unseal("buddytg-code+jwt", form.get("code") ?? "")
    // Check the bindings before claiming, so a wrong guess cannot burn the real client's code.
    if (code.client_id !== form.get("client_id")) throw new AuthorizeError("invalid_grant", "Code was issued to another client")
    if (code.redirect_uri !== form.get("redirect_uri")) throw new AuthorizeError("invalid_grant", "redirect_uri mismatch")
    const verifier = form.get("code_verifier") ?? ""
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(sha256(verifier), String(code.code_challenge))) {
      throw new AuthorizeError("invalid_grant", "PKCE verification failed")
    }
    if (!grantReplay.claim(code.jti, code.exp)) throw new AuthorizeError("invalid_grant", "Code already used")
    return issueTokens(String(code.client_id), String(code.sub), String(code.scope), Number(code.auth_time))
  }

  const redeemRefresh = async (form: URLSearchParams) => {
    const refresh = await unseal("buddytg-refresh+jwt", form.get("refresh_token") ?? "")
    if (refresh.client_id !== form.get("client_id")) throw new AuthorizeError("invalid_grant", "Refresh token was issued to another client")
    // Rotation: each refresh token works once.
    if (!grantReplay.claim(refresh.jti, refresh.exp)) throw new AuthorizeError("invalid_grant", "Refresh token already used")
    return issueTokens(String(refresh.client_id), String(refresh.sub), String(refresh.scope), Number(refresh.auth_time))
  }

  /** `authTime` is the Telegram login; rotation never extends a grant past REFRESH_TTL from it. */
  const issueTokens = async (clientId: string, sub: string, scope: string, authTime: number) => {
    if (!config.allowedUserIds.has(sub)) throw new AuthorizeError("invalid_grant", "Account no longer allowed")
    const remaining = authTime + REFRESH_TTL - Date.now() / 1000
    if (!Number.isFinite(remaining) || remaining <= 0) throw new AuthorizeError("invalid_grant", "Sign in again")
    const accessTtl = Math.min(ACCESS_TTL, Math.ceil(remaining))
    const access = await sign("at+jwt", { sub, client_id: clientId, scope, aud: resource, jti: b64url(randomBytes(16)) }, accessTtl)
    const refresh = await seal("buddytg-refresh+jwt", { sub, client_id: clientId, scope, auth_time: authTime }, remaining)
    return json({ access_token: access, token_type: "Bearer", expires_in: accessTtl, refresh_token: refresh, scope }, 200, { "cache-control": "no-store", pragma: "no-cache" })
  }

  // ---- Resource server side ----------------------------------------------------

  const verifyAccessToken = async (raw: string): Promise<AuthInfo> => {
    let claims: JWTPayload
    try {
      claims = await verify("at+jwt", raw, resource)
    } catch {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid or expired access token")
    }
    if (!claims.sub || !config.allowedUserIds.has(claims.sub)) throw new OAuthError(OAuthErrorCode.InvalidToken, "Account not allowed")
    return {
      token: raw,
      clientId: String(claims.client_id),
      scopes: String(claims.scope ?? "").split(" ").filter(Boolean),
      expiresAt: claims.exp,
      resource: new URL(resource),
      extra: { telegramUserId: claims.sub },
    }
  }

  const metadata: OAuthMetadata = {
    issuer,
    authorization_endpoint: endpoints.authorize,
    token_endpoint: endpoints.token,
    registration_endpoint: endpoints.register,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  } as OAuthMetadata

  /** Routes this module owns. Returns undefined for anything else. */
  const route = (request: Request): Promise<Response> | undefined => {
    const { pathname } = new URL(request.url)
    const method = request.method
    if (pathname === "/register") return method === "POST" ? register(request) : Promise.resolve(methodNotAllowed("POST"))
    if (pathname === "/authorize") {
      if (method === "GET") return authorize(request)
      if (method === "POST") return approve(request)
      return Promise.resolve(methodNotAllowed("GET, POST"))
    }
    if (pathname === "/oauth/telegram/callback") return method === "GET" ? telegramCallback(request) : Promise.resolve(methodNotAllowed("GET"))
    if (pathname === "/token") return method === "POST" ? token(request) : Promise.resolve(methodNotAllowed("POST"))
    return undefined
  }

  return { route, verifyAccessToken, metadata, endpoints }
}

const sameResource = (a: string, b: string) => URL.canParse(a) && new URL(a).href.replace(/\/$/, "") === new URL(b).href.replace(/\/$/, "")

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
const tokenError = (error: string, description: string) =>
  json({ error, error_description: description }, error === "invalid_client" ? 401 : 400, { "cache-control": "no-store" })
const methodNotAllowed = (allow: string) => new Response("Method not allowed", { status: 405, headers: { allow } })

const redirect = (target: string, query: Record<string, string | null | undefined>) => {
  const url = new URL(target)
  for (const [key, value] of Object.entries(query)) if (value != null) url.searchParams.set(key, value)
  return new Response(null, { status: 302, headers: { location: url.href, "cache-control": "no-store" } })
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

const shell = (title: string, body: string, status: number, formAction = "'none'") =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><meta name="referrer" content="origin">
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}
main{width:min(360px,calc(100vw - 48px))}
h1{font-size:20px;font-weight:600;margin:0 0 8px}
p{margin:0 0 24px;line-height:1.5;opacity:.75}
.button{display:block;width:100%;box-sizing:border-box;border:0;text-align:center;padding:12px 16px;border-radius:10px;background:#2AABEE;color:#fff;text-decoration:none;font:inherit;font-weight:600;cursor:pointer}
.button:active{transform:scale(.98)}
</style></head><body><main>${body}</main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // form-action also governs the redirect that follows the consent form.
        "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action ${formAction}`,
        "x-frame-options": "DENY",
      },
    },
  )

const page = (title: string, message: string, status: number) =>
  shell(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`, status)

const consentPage = (clientName: string, redirectHost: string, consent: string, telegramOrigin: string) =>
  shell(
    "Connect BuddyTG",
    `<h1>Connect ${escapeHtml(clientName)}</h1>
<p>It will read your chats and send messages as your Telegram account. You'll return to <strong>${escapeHtml(redirectHost)}</strong>.</p>
<form method="post" action="/authorize"><input type="hidden" name="request" value="${escapeHtml(consent)}"><button class="button" type="submit">Log in with Telegram</button></form>`,
    200,
    `'self' ${telegramOrigin}`,
  )
