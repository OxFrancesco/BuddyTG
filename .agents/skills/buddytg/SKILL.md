---
name: buddytg
description: Operate the local BuddyTG Telegram CLI safely with Bun. Use when an agent needs to authenticate or inspect the active Telegram account, export Saved Messages/bookmarks to Markdown, list or resolve chats, send a message as the user, configure or send a bot notification, or inspect BuddyTG CLI usage.
---

# BuddyTG

Use BuddyTG as the local-first interface to the user's Telegram account. Run it from the BuddyTG repository with Bun:

```bash
bun run buddytg
```

Use a globally installed `buddytg` executable only when it is already available. Never substitute npm or npx. Run `bun run buddytg` without arguments for current CLI help, and read the repository [README](../../../README.md) when more detail is needed. Prefer those sources over copying a large command reference into context.

## Protect the account and data

- Keep API credentials, sessions, bot tokens, and chat IDs in the macOS Keychain. Let interactive login prompts collect secrets; never print, persist, commit, or paste them into commands or chat.
- If `TG_API_ID`, `TG_API_HASH`, or `TG_BOT_TOKEN` is already provided by the environment, use it without displaying or inspecting its value.
- Treat exported Markdown and downloaded media as private Telegram data. Choose an intentional destination, check whether it already exists, and do not overwrite it without the user's approval.
- Use an explicit export path instead of the default when the working directory could be ambiguous. Keep exports out of public repositories unless the user explicitly chooses otherwise.
- Treat `send` as an irreversible external action. Resolve ambiguous recipients first, show the exact recipient and text, and obtain explicit authorization before sending to anyone other than Saved Messages.
- Allow `send me` after the user asks to save that exact content. Treat `notify` as a message to the user's own configured bot chat.
- Never interpolate dynamic text into shell source. Double quotes still evaluate command substitutions and backticks that are pasted into a command. Pass every dynamic peer, message, path, query, and notification field as a separate argv element through a subprocess API.
- Run `logout` only on an explicit request: it revokes the Telegram session when possible and removes all BuddyTG secrets from Keychain.

## Pass dynamic values as argv

Use a structured subprocess boundary for any value supplied by the user, Telegram, or another tool. `Bun.spawn` receives an argv array and does not invoke a shell:

```ts
const runBuddyTG = async (...args: string[]) => {
  const child = Bun.spawn(["bun", "run", "buddytg", ...args], {
    cwd: buddyTgRepo,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`BuddyTG exited with code ${exitCode}`)
}
```

Keep `buddyTgRepo`, peers, messages, paths, queries, and formatted notifications as runtime string values; never paste them into the source of a shell command or a generated script. The fixed shell commands below are safe only because they contain no dynamic values.

## Check or establish the account

Check the active identity before account-sensitive work:

```bash
bun run buddytg whoami
```

If there is no usable session, run interactive QR login:

```bash
bun run buddytg login
```

Use `bun run buddytg login --phone` only when QR login is unsuitable. Pause for the user to scan the QR code or provide the Telegram code and any 2FA password through the CLI prompts; never ask them to expose those secrets in chat.

## Export Saved Messages

Export all Saved Messages to a chosen Markdown file:

```ts
await runBuddyTG("bookmarks", outputPath)
```

Add `--download-media` only when the user wants attachments downloaded beside the export:

```ts
await runBuddyTG("bookmarks", outputPath, "--download-media")
```

Expect the export to be ordered oldest first and to retain timestamps, message IDs, rich text, tags, forwards, and reply links where Telegram exposes them. Afterward, report the destination and exported count printed by the CLI. Do not reproduce private bookmark contents unless the task requires analyzing them.

## Resolve chats

List recent dialogs before sending when a peer is not unambiguous:

```bash
bun run buddytg chats
```

Pass a dynamic query through argv:

```ts
await runBuddyTG("chats", query, "--limit", "200")
```

Add `--archived` only when archived dialogs are relevant. Match the returned name, username, type, and ID; prefer the verified ID for a final send when usernames or similarly named chats could be confused.

## Send messages

Save content to the user's Saved Messages:

```ts
await runBuddyTG("send", "me", exactMessage)
```

Send externally only after the recipient and exact text have been confirmed:

```ts
await runBuddyTG("send", verifiedPeer, exactMessage)
```

Accept a verified chat ID, `@username`, phone number, or `t.me` link as the peer. Do not infer a recipient from a partial name, and do not claim success unless the CLI returns the sent message ID.

## Send self-notifications

Configure the user's notification bot interactively when needed:

```bash
bun run buddytg bot login
```

Send a plain notification or select one parse mode:

```ts
await runBuddyTG("notify", message)
await runBuddyTG("notify", "--html", safeHtml)
await runBuddyTG("notify", "--markdown", escapedMarkdownV2)
await runBuddyTG("notify", "--silent", lowPriorityMessage)
```

Escape dynamic content for the selected parse mode. For agent completion or blocker notifications to Francesco, also follow the dedicated `telegram-notify` skill for its required wording and anti-spam rules.
