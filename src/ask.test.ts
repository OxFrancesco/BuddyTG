import { describe, expect, test } from "bun:test"
import { matchAskUpdate, parseAskArgs } from "./ask"

describe("parseAskArgs", () => {
  test("parses a free-text question", () => {
    expect(parseAskArgs(["Which", "branch?"])).toEqual({
      question: "Which branch?",
      choices: [],
      timeoutSeconds: 540,
      silent: false,
    })
  })

  test("parses inline choices and delivery options", () => {
    expect(
      parseAskArgs([
        "--option",
        "allow=Allow once",
        "--silent",
        "Deploy?",
        "--option",
        "deny=Deny",
        "--timeout",
        "30",
      ]),
    ).toEqual({
      question: "Deploy?",
      choices: [
        { value: "allow", label: "Allow once" },
        { value: "deny", label: "Deny" },
      ],
      timeoutSeconds: 30,
      silent: true,
    })
  })

  test("rejects malformed, duplicate, and unknown options", () => {
    expect(() => parseAskArgs(["--option", "allow", "Deploy?"])).toThrow(
      "--option must use <value>=<label>",
    )
    expect(() =>
      parseAskArgs([
        "--option",
        "allow=Yes",
        "--option",
        "allow=Again",
        "Deploy?",
      ])
    ).toThrow("duplicate --option value")
    expect(() => parseAskArgs(["--yes", "Deploy?"])).toThrow("Unknown ask option")
  })
})

describe("matchAskUpdate", () => {
  const expected = {
    chatId: 42,
    promptMessageId: 100,
    nonce: "abc",
    choices: [
      { value: "allow", label: "Allow" },
      { value: "deny", label: "Deny" },
    ],
  }

  test("accepts only a text reply to the exact bot prompt", () => {
    expect(
      matchAskUpdate(
        {
          update_id: 1,
          message: {
            message_id: 101,
            chat: { id: 42 },
            from: { id: 42 },
            text: "Use main",
            reply_to_message: { message_id: 100 },
          },
        },
        expected,
      ),
    ).toEqual({ answer: "Use main" })

    expect(
      matchAskUpdate(
        {
          update_id: 2,
          message: {
            message_id: 102,
            chat: { id: 42 },
            from: { id: 42 },
            text: "Unrelated",
            reply_to_message: { message_id: 99 },
          },
        },
        expected,
      ),
    ).toBeUndefined()
  })

  test("maps a correlated callback to its opaque choice value", () => {
    expect(
      matchAskUpdate(
        {
          update_id: 3,
          callback_query: {
            id: "callback-1",
            from: { id: 42 },
            data: "btg:abc:1",
            message: {
              message_id: 100,
              chat: { id: 42 },
            },
          },
        },
        expected,
      ),
    ).toEqual({ answer: "deny", callbackQueryId: "callback-1" })
  })

  test("ignores callbacks from another chat, message, or nonce", () => {
    for (const data of ["btg:other:0", "btg:abc:9"]) {
      expect(
        matchAskUpdate(
          {
            update_id: 4,
            callback_query: {
              id: "callback-2",
              from: { id: 42 },
              data,
              message: {
                message_id: 100,
                chat: { id: 42 },
              },
            },
          },
          expected,
        ),
      ).toBeUndefined()
    }
  })
})
