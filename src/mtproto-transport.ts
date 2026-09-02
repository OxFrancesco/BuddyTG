/**
 * MTProto transport selection for BuddyTG.
 *
 * @mtcute/bun defaults to unobfuscated TCP (`TcpTransport` + Intermediate codec).
 * That path is what dies on this Linux host during auth-key generation
 * (`pendingWaitForUnencrypted` / Connection closed), even though TCP 443 to DC2
 * IPv4 connects and Bot API HTTPS works.
 *
 * Linux therefore uses the official mtcute WebSocket transport:
 * `connectWs` from `@fuman/net` to `wss://<dc>.web.telegram.org/apiws` with
 * `ObfuscatedPacketCodec(IntermediatePacketCodec)` — same as `@mtcute/web` 0.30.3.
 * `connectWs` constructs `new WebSocket(url, protocols)` where `protocols` must be
 * a string or string[] ("a sequence"). Bun rejects a Node-style options object.
 *
 * When IPv4 is preferred, we only call `dns.setDefaultResultOrder("ipv4first")`
 * and still connect to the hostname (no IP-literal URL / fake Host+SNI).
 *
 * macOS keeps TCP. Override with BUDDYTG_TRANSPORT=websocket|tcp.
 */
import { connectWs } from "@fuman/net"
import {
  IntermediatePacketCodec,
  ObfuscatedPacketCodec,
  TcpTransport,
  type TelegramTransport,
} from "@mtcute/bun"
import type { BasicDcOption } from "@mtcute/core/utils.js"
import { setDefaultResultOrder } from "node:dns"

export type MtprotoTransportKind = "tcp" | "websocket"

export type MtprotoTransportSelection = {
  readonly kind: MtprotoTransportKind
  readonly useIpv6: boolean
  readonly ipv4Only: boolean
}

export type MtprotoTransportEnv = {
  readonly platform?: string
  readonly BUDDYTG_TRANSPORT?: string
  readonly BUDDYTG_USE_IPV6?: string
}

/** Official web.telegram.org DC subdomains from @mtcute/web 0.30.3. */
const WEBSOCKET_SUBDOMAINS: Record<number, string> = {
  1: "pluto",
  2: "venus",
  3: "aurora",
  4: "vesta",
  5: "flora",
}

const WEBSOCKET_BASE_DOMAIN = "web.telegram.org"

/** Same protocol string `@mtcute/web` / `@fuman/net` `connectWs` pass as WebSocket arg 2. */
export const MTPROTO_WEBSOCKET_PROTOCOLS = "binary" as const

export const mtprotoWebsocketUrl = (dc: Pick<BasicDcOption, "id" | "testMode">): string => {
  const subdomain = WEBSOCKET_SUBDOMAINS[dc.id]
  if (!subdomain) {
    throw new Error(`unknown Telegram DC id ${dc.id}`)
  }
  return `wss://${subdomain}.${WEBSOCKET_BASE_DOMAIN}/apiws${dc.testMode ? "_test" : ""}`
}

/**
 * Arguments for `@fuman/net` `connectWs`, matching
 * `new WebSocketImpl(url, protocols)` in websocket.js.
 */
export const mtprotoConnectWsOptions = (url: string) => ({
  url,
  implementation: WebSocket,
  protocols: MTPROTO_WEBSOCKET_PROTOCOLS,
})

export const selectMtprotoTransport = (
  env: MtprotoTransportEnv = {
    platform: process.platform,
    BUDDYTG_TRANSPORT: process.env.BUDDYTG_TRANSPORT,
    BUDDYTG_USE_IPV6: process.env.BUDDYTG_USE_IPV6,
  },
): MtprotoTransportSelection => {
  const override = env.BUDDYTG_TRANSPORT?.trim().toLowerCase()
  const kind: MtprotoTransportKind =
    override === "tcp" || override === "websocket"
      ? override
      : env.platform === "linux"
        ? "websocket"
        : "tcp"
  const useIpv6 = env.BUDDYTG_USE_IPV6?.trim() === "1"
  return {
    kind,
    useIpv6,
    ipv4Only: !useIpv6,
  }
}

/**
 * WebSocket MTProto transport matching `@mtcute/web` 0.30.3 `WebSocketTransport`.
 * Prefers IPv4 via DNS result order; does not rewrite the WSS hostname to an IP.
 */
export class WebSocketTransport implements TelegramTransport {
  constructor(private readonly ipv4Only = true) {}

  async connect(dc: BasicDcOption) {
    if (this.ipv4Only) setDefaultResultOrder("ipv4first")
    return connectWs(mtprotoConnectWsOptions(mtprotoWebsocketUrl(dc)))
  }

  packetCodec(_dc?: BasicDcOption) {
    return new ObfuscatedPacketCodec(new IntermediatePacketCodec())
  }
}

export const createMtprotoTransport = (
  selection: MtprotoTransportSelection = selectMtprotoTransport(),
): TelegramTransport =>
  selection.kind === "websocket" ? new WebSocketTransport(selection.ipv4Only) : new TcpTransport()
