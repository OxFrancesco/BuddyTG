# BuddyTG

A small, local-first Telegram CLI for macOS and Linux. Send messages from your personal Telegram account, export Saved Messages, deliver push notifications, and answer coding-agent approval requests through a bot you control.

BuddyTG uses [mtcute](https://mtcute.dev) for MTProto, [Effect](https://effect.website) for application logic, and a local secret store for credentials and sessions. It does not write Telegram credentials or session data to project files.

## What it can do

- Send messages as your Telegram user to Saved Messages, usernames, phone numbers, groups, and channels
- Send one explicitly confirmed local file as an exact document or validated native photo
- Download one Telegram attachment to a private local file without overwriting
- List your chats, groups, and channels with the IDs needed to message them
- Sign in with a QR code or phone number
- Export Saved Messages to Markdown, preserving rich text, tags, forwards, and reply links
- Optionally download media alongside an export
- Send Telegram push notifications through your own bot, with HTML, MarkdownV2, and silent delivery support
- Ask a correlated free-text or multiple-choice question and wait for the Telegram response
- Route Codex and Claude Code permission requests to Telegram approval buttons
- Keep API credentials, user sessions, bot tokens, and chat IDs in a local secret store (macOS Keychain, or a private user directory on Linux)

## Requirements

- macOS or Linux
- [Bun](https://bun.sh)
- A Telegram account
- A Telegram `api_id` and `api_hash` from [my.telegram.org/apps](https://my.telegram.org/apps)

## Secret storage

BuddyTG never writes credentials or session data into the git working tree, committed `.env` files, or the README.

- **macOS:** uses the Keychain via the `security` CLI when that command is available.
- **Linux, and macOS without Keychain:** stores secrets in a private user directory:
  - `$XDG_CONFIG_HOME/buddytg/secrets` when `XDG_CONFIG_HOME` is set
  - otherwise `~/.config/buddytg/secrets`

  The directory is created with mode `0700` and each secret file with `0600`.

Set `BUDDYTG_SECRETS_DIR` to an absolute path to use a different file-backed directory (this also selects the file backend on macOS). Do not point it at a repository. Environment variables still override stored values.

## Quick start

Clone the repository, install dependencies, and log in:

```bash
bun install
bun run buddytg login
```

BuddyTG asks for your Telegram API credentials the first time and stores them in the local secret store. For QR login, open Telegram and go to **Settings → Devices → Link Desktop Device**, then scan the code shown in the terminal.

On Linux, MTProto uses Telegram's WebSocket front (`wss://venus.web.telegram.org/apiws` for DC2) with IPv4-only DNS, because direct TCP to the DC is reset during the unencrypted auth-key handshake on some hosts. macOS still uses TCP. Set `BUDDYTG_TRANSPORT=tcp` or `BUDDYTG_TRANSPORT=websocket` to override.

Confirm the active account and send a message to Saved Messages:

```bash
bun run buddytg whoami
bun run buddytg send me "Hello from BuddyTG"
```

Use phone-based login instead when QR login is unavailable:

```bash
bun run buddytg login --phone
```

## Commands

All source-checkout examples use `bun run buddytg`. If you build and install the executable, replace that prefix with `buddytg`.

### Send a message

```bash
bun run buddytg send me "Saved for later"
bun run buddytg send @username "Hello"
bun run buddytg send +391234567890 "Hello"

# Groups and channels: by ID (see `chats`), public username, or t.me link
bun run buddytg send -1001234567890 "Hello group"
bun run buddytg send @publicgroup "Hello"
bun run buddytg send https://t.me/publicgroup "Hello"
```

The examples above contain fixed literals. When a message or peer comes from a user,
Telegram, or another program, pass it as a separate argv element (for example with
`Bun.spawn(["bun", "run", "buddytg", "send", peer, message])`). Do not paste dynamic
text into shell source: double quotes still evaluate command substitutions and backticks.

### Send a file safely

Send exactly one regular local file. BuddyTG resolves the recipient, prints the resolved
name and stable Telegram ID plus the local file manifest, and then asks you to type that
exact ID before it starts the upload:

```bash
bun run buddytg file send me archive.zip
bun run buddytg file send @username photo.jpg --caption "From the trip"
bun run buddytg file send @username photo.jpg --as photo
```

The default `document` mode preserves the uploaded bytes. `--as photo` opts into Telegram's
native photo handling and accepts only files with JPEG, PNG, or WebP signatures; Telegram may
process a native photo. URLs, directories, empty files, and final-component symbolic links are
rejected. BuddyTG holds the opened file descriptor across confirmation and refuses an in-place
change detected between the manifest and upload.

For a non-interactive caller, omit the confirmation flag on the first run. BuddyTG prints the
resolved manifest and exits without uploading. Re-run with the ID it printed:

```bash
bun run buddytg file send @username archive.zip --confirm-to 123456789
```

`--confirm-to` must equal the resolved recipient ID. There is intentionally no generic `--yes`
or recursive/directory upload. Regular accounts are preflighted against mtcute's 2000 MiB limit;
Premium accounts use its 4000 MiB limit. Caption ceilings are also validated before upload.

### Download a file safely

Download a single attachment by source peer and message ID, or paste a copied `t.me` message
link. `--to` is required and must identify an existing, non-symlink directory:

```bash
bun run buddytg file download me 123 --to ~/Downloads
bun run buddytg file download -1001234567890 456 --to ~/Downloads
bun run buddytg file download https://t.me/publicgroup/456 --to ~/Downloads
```

Before writing, BuddyTG prints the resolved source ID, remote metadata, exact destination, and
size ceiling, then asks you to type the source ID. For non-interactive use, pass the matching ID:

```bash
bun run buddytg file download me 123 --to ~/Downloads --confirm-from 123456789
```

Use `--name invoice.pdf` to choose a plain filename. The default download ceiling is 2 GiB;
raise it explicitly with a value such as `--max-size 3000MiB` (maximum 4000 MiB). Remote names
are sanitized, terminal control characters are escaped, content-protected media is refused,
and an existing destination is never replaced. Data streams into a hidden `0600` temporary
file in the chosen directory, is size-checked, synced, and atomically published only when
complete. Partial data is removed after failures or interruption.

Saved Messages exports include message IDs, so `bookmarks` is one convenient way to find the
ID for a Saved Messages attachment. A copied Telegram message link is usually easiest for
groups and channels. Message links are parsed only as Telegram identifiers; BuddyTG never
fetches arbitrary web URLs for file transfer.

### List chats and groups

```bash
# List your most recent 50 dialogs with their IDs
bun run buddytg chats

# Filter by name or username, cap matching results, include archived chats
bun run buddytg chats defai
bun run buddytg chats --limit 200 --archived
```

Use the printed ID as the `<peer>` argument for `send`. Negative IDs identify groups and channels.

### Export Saved Messages

```bash
# Export to saved-messages.md
bun run buddytg bookmarks

# Choose the output file
bun run buddytg bookmarks notes/telegram.md

# Download supported attachments into notes/telegram-media/
bun run buddytg bookmarks notes/telegram.md --download-media
```

Exports are ordered oldest first. Each entry includes its timestamp and message ID; rich formatting, tags, forwarded-message attribution, and links between replies are retained where available.

### Configure bot notifications

Notifications use the Telegram Bot API, which produces normal mobile and desktop push notifications without sending from your user account.

1. Create a bot with [@BotFather](https://t.me/BotFather) using `/newbot`.
2. Open the new bot's chat and send `/start` so it can message you.
3. Save and validate its token:

```bash
bun run buddytg bot login
```

Then send notifications:

```bash
bun run buddytg notify "Build finished"
bun run buddytg notify --silent "Background job finished"
bun run buddytg notify --html "<b>Build passed</b>"
bun run buddytg notify --markdown "*Build passed*"
```

`bot login` uses the logged-in Telegram user to determine your private chat ID, so
complete the normal user login first. HTML and MarkdownV2 follow Telegram's supported
formatting syntax; escape dynamic or untrusted text before selecting a parse mode.

### Ask from a script and wait for Telegram

`ask` sends a plain Telegram question and waits until you reply to that exact bot
message. With no options, Telegram opens its native Force Reply interface:

```bash
bun run buddytg ask "Which branch should I use?"
```

Add repeatable options to use native inline keyboard buttons instead. The opaque value
on the left is printed to stdout; the human-readable label on the right is shown in
Telegram:

```bash
bun run buddytg ask \
  --option "main=Use main" \
  --option "feature=Use feature branch" \
  --timeout 900 \
  "Which branch should I use?"
```

BuddyTG accepts only a reply to the exact prompt message or a callback carrying that
prompt's random nonce. It also verifies the configured private chat and sender IDs.
Progress goes to stderr so stdout contains only the answer and can be consumed by a
hook or another program.

`ask` uses Telegram Bot API [`getUpdates`](https://core.telegram.org/bots/api#getupdates)
long polling. Telegram does not permit long polling while that bot has an outgoing
webhook configured, and a bot should have only one active update consumer. Use a
dedicated BuddyTG bot and do not run concurrent `ask` commands for the same token.

### Answer Codex and Claude Code approvals from Telegram

This repository already contains project-local hook configurations for
[Codex](https://learn.chatgpt.com/docs/hooks) and
[Claude Code](https://code.claude.com/docs/en/hooks):

- `.codex/hooks.json`
- `.claude/settings.json`

They call `bun <repo>/src/cli.ts hook permission`, wait for your Telegram button tap,
and emit the shared `PermissionRequest` allow/deny JSON response. If Telegram is not
configured, unavailable, or times out, the hook exits without a decision and the agent
falls back to its normal local permission dialog.

Set up the bot before starting either agent:

```bash
bun run buddytg login
bun run buddytg bot login
bun run buddytg notify "BuddyTG approvals are ready"
```

Then:

1. Start Codex or Claude Code from this repository.
2. Open `/hooks` in the agent.
3. Review and trust the project-local `PermissionRequest` hook.
4. Trigger an action that needs approval and tap **Allow once** or **Deny** in Telegram.

For another repository, first install the standalone `buddytg` executable on `PATH`.
Then add the following handler under `hooks.PermissionRequest` in either
`.codex/hooks.json` or `.claude/settings.json`:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "buddytg hook permission",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

Codex loads project hooks only for trusted repositories and requires the current hook
definition to be reviewed. Claude Code also exposes project hooks through `/hooks`.
The adapter intentionally offers only one-time allow or deny decisions; it does not
create persistent allow rules.

### Inspect or remove the session

```bash
bun run buddytg whoami
bun run buddytg logout
```

`logout` attempts to revoke the Telegram session and removes BuddyTG's API credentials, user session, bot token, and chat ID from the local secret store.

Run the CLI without arguments to see its built-in help:

```bash
bun run buddytg
```

## Environment variables

Environment variables take precedence over values stored in the local secret store.

| Variable | Purpose |
| --- | --- |
| `TG_API_ID` | Telegram application ID |
| `TG_API_HASH` | Telegram application hash |
| `TG_BOT_TOKEN` | Bot API token used by `notify`, `ask`, and approval hooks |
| `TG_BOT_CHAT_ID` | Private Telegram chat/user ID used by bot commands |
| `BUDDYTG_SECRETS_DIR` | Optional override for the file-backed secret directory |
| `BUDDYTG_TRANSPORT` | MTProto transport: `websocket` (Linux default) or `tcp` (macOS default) |
| `BUDDYTG_USE_IPV6` | Set to `1` to use IPv6 DCs / AAAA lookups (default is IPv4-only) |

For example:

```bash
TG_API_ID=123456 TG_API_HASH=your_api_hash bun run buddytg login
```

Avoid committing credentials to shell scripts, `.env` files, or the repository.

## Build a standalone executable

```bash
bun run build
./dist/buddytg whoami
```

To invoke it from anywhere, copy `dist/buddytg` into a directory already on your `PATH`.

## Development

Install dependencies and run the CLI directly from TypeScript:

```bash
bun install
bun run buddytg
```

Useful checks:

```bash
bun run test
bun run typecheck
bun run build
```

Keep command behavior and examples in this README aligned with the usage text in `src/cli.ts`.

### Project structure

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | Top-level command dispatch and the existing account/message commands |
| `src/chats.ts` | Chat-list argument parsing, filtering, and display rows |
| `src/file-commands.ts` | Confirmed Telegram upload/download orchestration and progress reporting |
| `src/file-transfer.ts` | File argument parsing, local preflight, validation, and private atomic writes |
| `src/peer-target.ts` | Safe resolution of IDs, phone numbers, and Telegram links |
| `src/telegram.ts` | MTProto clients, authentication state, and session persistence |
| `src/mtproto-transport.ts` | TCP vs WebSocket MTProto selection (Linux defaults to WebSocket) |
| `src/bot.ts` | Telegram Bot API calls and bot target loading |
| `src/ask.ts` | Correlated Force Reply/inline-button questions and long polling |
| `src/permission-hook.ts` | Shared Codex/Claude permission-hook input and decision mapping |
| `src/keychain.ts` | Effect secret-store service (macOS Keychain or a private user directory) |
| `src/prompt.ts` | Interactive and secret terminal prompts |

The Telegram client uses in-memory storage. After authenticated operations, its exported session is persisted in the local secret store rather than in a session file inside the project.

## Security notes

- Treat `api_hash`, bot tokens, and exported Telegram sessions as secrets.
- BuddyTG stores secrets in the macOS Keychain or a private `0700` user directory unless an environment variable overrides them.
- Message contents still pass through Telegram's user or bot APIs as required by the selected command.
- Approval hooks send the project name, tool name, and approval description or input preview to your configured private Telegram chat.
- Telegram replies are accepted only from the configured chat and when correlated to the active prompt; use a dedicated bot and protect its token.
- Markdown exports and downloaded media contain your Telegram data; choose their destination and permissions accordingly.
- File uploads never accept a URL or directory and do not begin before the exact resolved recipient ID is confirmed.
- Direct downloads refuse collisions, use private temporary files, enforce a streaming size limit, and publish only complete data.
- A successful upload is reported only with Telegram's returned message ID. If an upload started but Telegram did not return an ID, BuddyTG reports delivery as unknown instead of claiming success.
