import { describe, expect, test } from "bun:test"
import { resolveSendTarget } from "./peer-target"

type SendTargetClient = Parameters<typeof resolveSendTarget>[0]

const makeClient = (overrides: Partial<SendTargetClient>): SendTargetClient => ({
  findDialogs: async () => {
    throw new Error("unexpected dialog lookup")
  },
  getChat: async () => {
    throw new Error("unexpected invite lookup")
  },
  resolvePhoneNumber: async () => {
    throw new Error("unexpected phone lookup")
  },
  resolvePeer: async () => {
    throw new Error("unexpected direct peer lookup")
  },
  ...overrides,
})

describe("resolveSendTarget", () => {
  test("rehydrates a numeric dialog ID before sending", async () => {
    const hydratedPeer = { _: "inputPeerSelf" as const }
    let requestedDialogId: number | undefined

    const client = makeClient({
      findDialogs: async (id: number) => {
        requestedDialogId = id
        return [{ peer: { inputPeer: hydratedPeer } }]
      },
    })

    expect(await resolveSendTarget(client, "-1001234567890")).toBe(hydratedPeer)
    expect(requestedDialogId).toBe(-1001234567890)
  })

  test("resolves public t.me targets by username", async () => {
    const resolvedPeer = { _: "inputPeerSelf" as const }
    let requestedUsername: string | undefined

    const client = makeClient({
      resolvePeer: async (username: string) => {
        requestedUsername = username
        return resolvedPeer
      },
    })

    const cases = [
      ["https://t.me/publicgroup", "@publicgroup"],
      ["t.me/publicgroup", "@publicgroup"],
      ["https://t.me/publicgroup/", "@publicgroup"],
      ["https://t.me/publicgroup?single", "@publicgroup"],
      ["https://t.me/publicgroup/123?single", "@publicgroup"],
      ["https://t.me/s/telegram/1", "@telegram"],
      ["https://t.me/alice?text=hello&profile", "@alice"],
      ["https://t.me/mybot?start=abc", "@mybot"],
      ["https://t.me/mybot/app?startapp=abc", "@mybot"],
      ["https://t.me/mybot/app", "@mybot"],
      ["https://t.me/telegram/s/live", "@telegram"],
      ["https://t.me/boost/telegram", "@telegram"],
      ["https://t.me/self", "@self"],
      ["https://t.me/me", "@me"],
    ] as const

    for (const [target, username] of cases) {
      expect(await resolveSendTarget(client, target)).toBe(resolvedPeer)
      expect(requestedUsername).toBe(username)
    }
  })

  test("rejects reserved non-peer t.me routes", async () => {
    const client = makeClient({})

    const reservedLinks = [
      "https://t.me/share?url=https://example.com",
      "https://t.me/oauth?startapp=token",
      "https://t.me/share",
      "https://t.me/share/123",
      "https://t.me/s/share/1",
      "https://t.me/s/telegram/1/2",
    ]

    for (const target of reservedLinks) {
      await expect(resolveSendTarget(client, target)).rejects.toThrow("Unsupported Telegram link")
    }
  })

  test("resolves a private message link through its marked channel ID", async () => {
    const resolvedPeer = { _: "inputPeerSelf" as const }
    let requestedDialogId: number | undefined

    const client = makeClient({
      findDialogs: async (id: number) => {
        requestedDialogId = id
        return [{ peer: { inputPeer: resolvedPeer } }]
      },
    })

    for (const target of ["https://t.me/c/666/123", "https://t.me/boost?c=666"]) {
      expect(await resolveSendTarget(client, target)).toBe(resolvedPeer)
      expect(requestedDialogId).toBe(-1000000000666)
    }
  })

  test("rejects malformed private channel IDs before dialog lookup", async () => {
    let dialogLookups = 0
    const client = makeClient({
      findDialogs: async () => {
        dialogLookups += 1
        return []
      },
    })

    for (const channelId of [
      "-1000123456789",
      "0",
      String(Number.MAX_SAFE_INTEGER),
      "9007199254740992",
    ]) {
      await expect(resolveSendTarget(client, `https://t.me/c/${channelId}/1`)).rejects.toThrow(
        "Invalid Telegram private channel ID",
      )
    }
    expect(dialogLookups).toBe(0)
  })

  test("resolves an invite link through chat lookup", async () => {
    const invitedPeer = { _: "inputPeerSelf" as const }
    let requestedInvite: string | undefined

    const client = makeClient({
      getChat: async (invite: string) => {
        requestedInvite = invite
        return { inputPeer: invitedPeer }
      },
    })

    expect(await resolveSendTarget(client, "https://t.me/+abc_DEF-123")).toBe(invitedPeer)
    expect(requestedInvite).toBe("https://t.me/+abc_DEF-123")
  })

  test("resolves a raw phone number through the phone boundary", async () => {
    const phonePeer = { _: "inputPeerSelf" as const }
    let requestedPhone: string | undefined

    const client = makeClient({
      resolvePhoneNumber: async (phone: string) => {
        requestedPhone = phone
        return phonePeer
      },
    })

    expect(await resolveSendTarget(client, "+391234567890")).toBe(phonePeer)
    expect(requestedPhone).toBe("391234567890")
    expect(await resolveSendTarget(client, "https://t.me/+391234567890")).toBe(phonePeer)
    expect(requestedPhone).toBe("391234567890")
  })
})
