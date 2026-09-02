/**
 * Tests for MTProto transport selection and the official WebSocket URL map.
 * Does not open a live Telegram connection.
 */
import { expect, test } from "bun:test"
import { IntermediatePacketCodec, ObfuscatedPacketCodec, TcpTransport } from "@mtcute/bun"
import {
  createMtprotoTransport,
  mtprotoConnectWsOptions,
  mtprotoWebsocketUrl,
  selectMtprotoTransport,
  WebSocketTransport,
} from "./mtproto-transport"

test("Linux defaults to IPv4-only WebSocket MTProto", () => {
  expect(
    selectMtprotoTransport({
      platform: "linux",
      BUDDYTG_TRANSPORT: "",
      BUDDYTG_USE_IPV6: "",
    }),
  ).toEqual({ kind: "websocket", useIpv6: false, ipv4Only: true })
})

test("macOS defaults to TCP so Keychain-era behavior stays intact", () => {
  expect(
    selectMtprotoTransport({
      platform: "darwin",
      BUDDYTG_TRANSPORT: "",
      BUDDYTG_USE_IPV6: "",
    }),
  ).toEqual({ kind: "tcp", useIpv6: false, ipv4Only: true })
})

test("BUDDYTG_TRANSPORT overrides the platform default", () => {
  expect(
    selectMtprotoTransport({
      platform: "darwin",
      BUDDYTG_TRANSPORT: "websocket",
    }),
  ).toEqual({ kind: "websocket", useIpv6: false, ipv4Only: true })
  expect(
    selectMtprotoTransport({
      platform: "linux",
      BUDDYTG_TRANSPORT: "tcp",
    }),
  ).toEqual({ kind: "tcp", useIpv6: false, ipv4Only: true })
})

test("unknown BUDDYTG_TRANSPORT falls back to the platform default", () => {
  expect(
    selectMtprotoTransport({
      platform: "linux",
      BUDDYTG_TRANSPORT: "mtproxy",
    }).kind,
  ).toBe("websocket")
  expect(
    selectMtprotoTransport({
      platform: "darwin",
      BUDDYTG_TRANSPORT: "mtproxy",
    }).kind,
  ).toBe("tcp")
})

test("BUDDYTG_USE_IPV6=1 opts into IPv6 DCs and disables A-only WSS", () => {
  expect(
    selectMtprotoTransport({
      platform: "linux",
      BUDDYTG_USE_IPV6: "1",
    }),
  ).toEqual({ kind: "websocket", useIpv6: true, ipv4Only: false })
})

test("maps DC ids to the official web.telegram.org WebSocket URLs", () => {
  expect(mtprotoWebsocketUrl({ id: 2 })).toBe("wss://venus.web.telegram.org/apiws")
  expect(mtprotoWebsocketUrl({ id: 2, testMode: true })).toBe("wss://venus.web.telegram.org/apiws_test")
  expect(mtprotoWebsocketUrl({ id: 1 })).toBe("wss://pluto.web.telegram.org/apiws")
  expect(mtprotoWebsocketUrl({ id: 3 })).toBe("wss://aurora.web.telegram.org/apiws")
  expect(mtprotoWebsocketUrl({ id: 4 })).toBe("wss://vesta.web.telegram.org/apiws")
  expect(mtprotoWebsocketUrl({ id: 5 })).toBe("wss://flora.web.telegram.org/apiws")
  expect(() => mtprotoWebsocketUrl({ id: 9 })).toThrow("unknown Telegram DC id 9")
})

test("createMtprotoTransport constructs the confirmed mtcute transport classes", () => {
  const dc = { id: 2, ipAddress: "149.154.167.50", port: 443 }
  const websocket = createMtprotoTransport({
    kind: "websocket",
    useIpv6: false,
    ipv4Only: true,
  })
  expect(websocket).toBeInstanceOf(WebSocketTransport)
  expect(websocket.packetCodec(dc)).toBeInstanceOf(ObfuscatedPacketCodec)

  const tcp = createMtprotoTransport({
    kind: "tcp",
    useIpv6: false,
    ipv4Only: true,
  })
  expect(tcp).toBeInstanceOf(TcpTransport)
  expect(tcp.packetCodec(dc)).toBeInstanceOf(IntermediatePacketCodec)
})

test("connectWs WebSocket constructor 2nd arg is a protocol sequence, not an options object", () => {
  const url = mtprotoWebsocketUrl({ id: 2 })
  const options = mtprotoConnectWsOptions(url)
  expect(options.url).toBe("wss://venus.web.telegram.org/apiws")
  expect(options.url).not.toMatch(/^wss:\/\/\d/)
  expect(options.implementation).toBe(WebSocket)
  expect(options.protocols).toBe("binary")
  expect(typeof options.protocols === "string" || Array.isArray(options.protocols)).toBe(true)

  const constructorUrl = "ws://127.0.0.1:1"
  const ws = new options.implementation(constructorUrl, options.protocols)
  expect(ws).toBeInstanceOf(WebSocket)
  ws.close()

  try {
    new options.implementation(constructorUrl, {
      protocols: options.protocols,
      headers: { Host: "venus.web.telegram.org" },
      tls: { serverName: "venus.web.telegram.org" },
    } as never)
    throw new Error("expected Bun WebSocket to reject a 2nd-arg options object")
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError)
    expect((error as NodeJS.ErrnoException).code).toBe("ERR_INVALID_ARG_TYPE")
  }
})
