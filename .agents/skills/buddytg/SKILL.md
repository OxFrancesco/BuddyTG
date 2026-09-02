---
name: buddytg
description: Operate the local BuddyTG Telegram CLI safely with Bun. Use when an agent needs to authenticate or inspect the active Telegram account, export Saved Messages/bookmarks, list or resolve chats, send a message or explicitly confirmed local file, privately download Telegram media, configure bot notifications, ask for a correlated Telegram response, bridge coding-agent approvals, or inspect BuddyTG CLI usage.
---

# BuddyTG

Use BuddyTG as the local-first interface to the user's Telegram account. Run it from the BuddyTG repository with Bun:

```bash
bun run buddytg
```

Use a globally installed `buddytg` executable only when it is already available. Never substitute npm or npx. Run `bun run buddytg` without arguments for current CLI help, and read `README.md` from the BuddyTG repository root when more detail is needed. Prefer those sources over copying a large command reference into context.

## Protect the account and data

- Keep API credentials, sessions, bot tokens, and chat IDs in the local secret store (macOS Keychain, or `~/.config/buddytg/secrets` on Linux). Let interactive login prompts collect secrets; never print, persist, commit, or paste them into commands or chat.
- If `TG_API_ID`, `TG_API_HASH`, or `TG_BOT_TOKEN` is already provided by the environment, use it without displaying or inspecting its value.
- Treat exported Markdown and downloaded media as private Telegram data. Choose an intentional destination, check whether it already exists, and do not overwrite it without the user's approval.
- Use an explicit export path instead of the default when the working directory could be ambiguous. Keep exports out of public repositories unless the user explicitly chooses otherwise.
- Treat `send` as an irreversible external action. Resolve ambiguous recipients first, show the exact recipient and text, and obtain explicit authorization before sending to anyone other than Saved Messages.
- Treat `file send` as an irreversible external action. Confirm the exact local path and recipient, and let BuddyTG verify the resolved recipient ID before any bytes are uploaded. Never guess or bypass `--confirm-to`.
- Treat `file download` output as private account data. Use an intentional existing directory, retain the default size ceiling unless the user approves a larger one, and never work around collision or content-protection refusals.
- Allow `send me` after the user asks to save that exact content. Treat `notify` as a message to the user's own configured bot chat.
- Treat `ask` as a message to the user's own configured bot chat. Approval-hook prompts may include a project name, tool name, and command/input preview, so never add unrelated secrets.
- Never interpolate dynamic text into shell source. Double quotes still evaluate command substitutions and backticks that are pasted into a command. Pass every dynamic peer, message, path, query, and notification field as a separate argv element through a subprocess API.
- Run `logout` only on an explicit request: it revokes the Telegram session when possible and removes all BuddyTG secrets from the local secret store.

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

BuddyTG authentication lives in the local secret store (macOS Keychain, or a private
user directory on Linux). Sandboxed commands may be unable to read those entries
and can falsely report `Not logged in`, request API credentials, or start the
bot-login flow even when the user is already authenticated. When a sandboxed
authentication check fails, retry the exact BuddyTG command outside the sandbox
(use `require_escalated` when available) before concluding that credentials are
missing. Do not start login or ask the user to re-enter secrets until the
unsandboxed check also fails.

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

## Send local files

Send one regular local file only after the user has identified the exact file and recipient. BuddyTG rejects URLs, directories, empty files, and final-component symbolic links; document mode preserves bytes, while `--as photo` deliberately opts into validated JPEG, PNG, or WebP native-photo handling.

Use the exact stable recipient ID from `whoami`, `chats`, or a prior BuddyTG preflight as the confirmation value:

```ts
await runBuddyTG(
  "file",
  "send",
  verifiedPeer,
  localFilePath,
  "--confirm-to",
  verifiedRecipientId,
)
```

Add a caption or native-photo mode only when explicitly intended:

```ts
await runBuddyTG(
  "file",
  "send",
  verifiedPeer,
  localPhotoPath,
  "--caption",
  exactCaption,
  "--as",
  "photo",
  "--confirm-to",
  verifiedRecipientId,
)
```

In an interactive terminal, omit `--confirm-to` and type the exact ID shown in the manifest. In a non-interactive agent run, omitting it intentionally exits after the safe preflight without uploading; only rerun after the ID and manifest have been verified. There is no generic `--yes`. Report success only when BuddyTG prints the sent message ID; if it reports delivery as unknown, preserve that uncertainty.

## Download Telegram files

Download one attachment by verified peer and message ID, or by a copied `t.me` message link. The destination must be an existing, intentional, non-symlink directory:

```ts
await runBuddyTG(
  "file",
  "download",
  verifiedPeer,
  String(messageId),
  "--to",
  destinationDirectory,
  "--confirm-from",
  verifiedSourceId,
)
```

For a copied Telegram message link, keep the link as one argv value:

```ts
await runBuddyTG(
  "file",
  "download",
  telegramMessageLink,
  "--to",
  destinationDirectory,
  "--confirm-from",
  verifiedSourceId,
)
```

BuddyTG sanitizes remote names, writes through a private `0600` temporary file, enforces the streaming size limit, and refuses overwrites. Use `--name` only with a plain user-approved filename. The default ceiling is 2 GiB; raise `--max-size` up to 4000 MiB only when the user expects that file size. Do not claim success unless the CLI prints the final destination and byte count.

## Send self-notifications

If `notify` asks for a bot token after running inside a sandbox, stop that prompt and
retry the notification outside the sandbox. Ask the user to configure the bot only when
the unsandboxed attempt also confirms that the token is missing.

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

## Ask for a correlated response

Use `ask` when the running workflow is explicitly allowed to wait for the user. Pass
questions and options as separate argv values:

```ts
const answer = await runBuddyTG(
  "ask",
  "--option",
  "allow=Allow once",
  "--option",
  "deny=Deny",
  "--timeout",
  "540",
  exactQuestion,
)
```

Without `--option`, Telegram opens its Force Reply interface. With options, BuddyTG
uses inline callback buttons and prints the selected opaque value to stdout. It accepts
only the configured private chat/user and a reply or callback correlated to that exact
prompt.

`ask` uses Bot API long polling. Do not run concurrent `ask` processes with the same
bot token, and do not remove an existing Telegram webhook without explicit permission.
If Telegram reports that a webhook is configured, use a separate bot or ask the user
how to proceed.

## Bridge coding-agent approvals

`buddytg hook permission` reads a Codex or Claude Code `PermissionRequest` JSON object
from stdin, asks with **Allow once** and **Deny** buttons, and writes the shared
structured decision to stdout. Use it only as a configured command hook; do not pipe
hand-constructed approval payloads into it.

The BuddyTG repository includes `.codex/hooks.json` and `.claude/settings.json`.
Review and trust the hook through the agent's `/hooks` UI. For another trusted
repository with the standalone executable on `PATH`, follow the configuration in
`README.md`. Hook failures intentionally leave the decision unresolved so the normal
local approval dialog can take over.
