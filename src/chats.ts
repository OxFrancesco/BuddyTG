export interface ChatsOptions {
  readonly query?: string
  readonly limit: number
  readonly archived: boolean
}

interface UserDialogPeer {
  readonly type: "user"
  readonly id: number
  readonly isBot: boolean
  readonly displayName: string
  readonly username: string | null
}

interface ChatDialogPeer {
  readonly type: "chat"
  readonly id: number
  readonly chatType: string
  readonly displayName: string
  readonly username: string | null
}

export interface ChatDialog {
  readonly peer: UserDialogPeer | ChatDialogPeer
}

export interface ChatRow {
  readonly id: number
  readonly type: string
  readonly name: string
  readonly username: string | null
}

export const parseChatsArgs = (tokens: readonly string[]): ChatsOptions => {
  let query: string | undefined
  let limit = 50
  let archived = false

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!

    if (token === "--limit") {
      const value = tokens[index + 1]
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--limit requires a positive integer value")
      }

      limit = Number(value)
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new Error("--limit must be a positive safe integer")
      }
      index += 1
    } else if (token === "--archived") {
      archived = true
    } else if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`)
    } else if (query !== undefined) {
      throw new Error("chats accepts at most one query")
    } else {
      query = token
    }
  }

  return { query, limit, archived }
}

export const collectChatRows = async (
  dialogs: AsyncIterable<ChatDialog>,
  options: Pick<ChatsOptions, "query" | "limit">,
): Promise<ChatRow[]> => {
  const query = options.query?.toLowerCase()
  const rows: ChatRow[] = []

  for await (const dialog of dialogs) {
    const peer = dialog.peer
    const row: ChatRow = {
      id: peer.id,
      type: peer.type === "user" ? (peer.isBot ? "bot" : "user") : peer.chatType,
      name: peer.displayName,
      username: peer.username,
    }

    if (
      query &&
      !row.name.toLowerCase().includes(query) &&
      !row.username?.toLowerCase().includes(query)
    ) {
      continue
    }

    rows.push(row)
    if (rows.length === options.limit) break
  }

  return rows
}
