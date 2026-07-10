import type { tl } from "@mtcute/bun"
import { getMarkedPeerId, links } from "@mtcute/bun/utils.js"

interface SendTargetClient {
  findDialogs(id: number): Promise<ReadonlyArray<{ peer: { inputPeer: tl.TypeInputPeer } }>>
  getChat(invite: string): Promise<{ inputPeer: tl.TypeInputPeer }>
  resolvePhoneNumber(phone: string): Promise<tl.TypeInputPeer>
  resolvePeer(peer: string): Promise<tl.TypeInputPeer>
}

type SendTarget =
  | { readonly type: "dialog"; readonly id: number }
  | { readonly type: "invite"; readonly hash: string }
  | { readonly type: "peer"; readonly peer: string }
  | { readonly type: "phone"; readonly phone: string }

const normalizeTmeUrl = (target: string) => {
  if (!/^(?:https?:\/\/)?(?:www\.)?t\.me\//i.test(target)) return null

  const url = new URL(/^https?:\/\//i.test(target) ? target : `https://${target}`)
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "")
  return url.toString()
}

// Keep this aligned with https://core.telegram.org/api/links#deep-links.
const RESERVED_TME_ROUTES = new Set([
  "a",
  "addemoji",
  "addlist",
  "addstickers",
  "addstyle",
  "addtheme",
  "auction",
  "auth",
  "bg",
  "boost",
  "c",
  "call",
  "confirmphone",
  "contact",
  "giftcode",
  "invoice",
  "iv",
  "joinchat",
  "k",
  "login",
  "m",
  "msg",
  "newbot",
  "nft",
  "oauth",
  "proxy",
  "s",
  "setlanguage",
  "share",
  "socks",
  "web",
  "z",
])

const isPublicPeerUsername = (username: string) =>
  /^[A-Za-z_][A-Za-z0-9_]{1,31}$/.test(username) &&
  !RESERVED_TME_ROUTES.has(username.toLowerCase())

const toUsernameTarget = (username: string | undefined): SendTarget | null => {
  if (username === undefined || !isPublicPeerUsername(username)) return null
  return { type: "peer", peer: `@${username}` }
}

const toPrivateChannelTarget = (rawChannelId: string | null | undefined): SendTarget => {
  if (rawChannelId === undefined || rawChannelId === null || !/^\d+$/.test(rawChannelId)) {
    throw new Error(`Invalid Telegram private channel ID: ${rawChannelId ?? "missing"}`)
  }

  const channelId = Number(rawChannelId)
  if (!Number.isSafeInteger(channelId) || channelId <= 0) {
    throw new Error(`Invalid Telegram private channel ID: ${rawChannelId}`)
  }

  const markedChannelId = getMarkedPeerId(channelId, "channel")
  if (!Number.isSafeInteger(markedChannelId)) {
    throw new Error(`Invalid Telegram private channel ID: ${rawChannelId}`)
  }
  return { type: "dialog", id: markedChannelId }
}

const parseTmeTarget = (target: string, rawTarget: string): SendTarget => {
  const linkedPhone = links.phoneNumber.parse(target)
  if (linkedPhone) return { type: "phone", phone: linkedPhone.phone }

  const invite = links.chatInvite.parse(target)
  if (invite) return { type: "invite", hash: invite.hash }

  const url = new URL(target)
  const segments = url.pathname.split("/").filter(Boolean)
  const [route, second, third] = segments

  switch (route) {
    case "c":
      if (
        segments.length > 4 ||
        segments.slice(2).some((segment) => !/^\d+$/.test(segment))
      ) {
        throw new Error(`Unsupported Telegram link: ${rawTarget}`)
      }
      return toPrivateChannelTarget(second)

    case "s": {
      const previewTarget = toUsernameTarget(second)
      if (
        previewTarget &&
        segments.length <= 3 &&
        (third === undefined || /^\d+$/.test(third))
      ) {
        return previewTarget
      }
      throw new Error(`Unsupported Telegram link: ${rawTarget}`)
    }

    case "boost": {
      const publicBoostTarget = segments.length === 2 ? toUsernameTarget(second) : null
      if (publicBoostTarget) return publicBoostTarget
      if (segments.length === 1 && url.searchParams.has("c")) {
        return toPrivateChannelTarget(url.searchParams.get("c"))
      }
      throw new Error(`Unsupported Telegram link: ${rawTarget}`)
    }

    default: {
      const publicTarget = toUsernameTarget(route)
      if (publicTarget) return publicTarget
      throw new Error(`Unsupported Telegram link: ${rawTarget}`)
    }
  }
}

const parseSendTarget = (rawTarget: string): SendTarget => {
  if (/^-?\d+$/.test(rawTarget)) {
    const id = Number(rawTarget)
    if (!Number.isSafeInteger(id)) throw new Error(`Invalid Telegram peer ID: ${rawTarget}`)
    return { type: "dialog", id }
  }

  const phone = rawTarget.match(/^\+(\d+)$/)
  if (phone) return { type: "phone", phone: phone[1]! }

  const tmeUrl = normalizeTmeUrl(rawTarget)
  if (tmeUrl) return parseTmeTarget(tmeUrl, rawTarget)

  return { type: "peer", peer: rawTarget }
}

export const resolveSendTarget = async (
  client: SendTargetClient,
  rawTarget: string,
): Promise<tl.TypeInputPeer> => {
  const target = parseSendTarget(rawTarget)

  switch (target.type) {
    case "dialog": {
      const [dialog] = await client.findDialogs(target.id)
      if (!dialog) throw new Error(`Telegram dialog not found: ${rawTarget}`)
      return dialog.peer.inputPeer
    }
    case "invite": {
      const chat = await client.getChat(links.chatInvite({ hash: target.hash }))
      return chat.inputPeer
    }
    case "phone":
      return client.resolvePhoneNumber(target.phone)
    case "peer":
      return client.resolvePeer(target.peer)
  }
}
