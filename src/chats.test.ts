import { describe, expect, test } from "bun:test"
import { collectChatRows, parseChatsArgs } from "./chats"

describe("parseChatsArgs", () => {
  test("parses a query and options in command-line order", () => {
    expect(parseChatsArgs(["--archived", "defai", "--limit", "200"])).toEqual({
      query: "defai",
      limit: 200,
      archived: true,
    })
  })

  test("keeps a numeric query when it equals the limit value", () => {
    expect(parseChatsArgs(["50", "--limit", "50"])).toEqual({
      query: "50",
      limit: 50,
      archived: false,
    })
  })

  test("rejects missing, non-positive, non-integer, and unsafe limits", () => {
    const invalidArguments = [
      ["--limit"],
      ["--limit", "nope"],
      ["--limit", "0"],
      ["--limit", "-1"],
      ["--limit", "1.5"],
      ["--limit", String(Number.MAX_SAFE_INTEGER + 1)],
    ]

    for (const args of invalidArguments) {
      expect(() => parseChatsArgs(args)).toThrow(/--limit/)
    }
  })

  test("rejects unknown options and extra query arguments", () => {
    expect(() => parseChatsArgs(["--unknown"])).toThrow(/Unknown option/)
    expect(() => parseChatsArgs(["first", "second"])).toThrow(/one query/)
  })
})

describe("collectChatRows", () => {
  test("applies the result limit after query filtering", async () => {
    async function* dialogs() {
      yield {
        peer: {
          type: "chat" as const,
          id: -1001,
          chatType: "group",
          displayName: "Most recent",
          username: null,
        },
      }
      yield {
        peer: {
          type: "chat" as const,
          id: -1002,
          chatType: "supergroup",
          displayName: "Target discussion",
          username: "target_chat",
        },
      }
      throw new Error("iteration should stop after collecting the requested match")
    }

    expect(await collectChatRows(dialogs(), { query: "target", limit: 1 })).toEqual([
      {
        id: -1002,
        type: "supergroup",
        name: "Target discussion",
        username: "target_chat",
      },
    ])
  })
})
