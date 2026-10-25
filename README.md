# BuddyTG

BuddyTG also ships a native pi package with typed Telegram tools (sends are auto-approved unless `BUDDYTG_CONFIRM_SENDS=1`), `/buddytg login`, and an account indicator right-aligned beside No-Stop above the input border. See [pi setup and safety limits](pi/README.md).

A small, local-first Telegram CLI for macOS and Linux. Send messages from your personal Telegram account, export Saved Messages, deliver push notifications, and answer coding-agent approval requests through a bot you control.

BuddyTG uses [mtcute](https://mtcute.dev) for MTProto, [Effect](https://effect.website) for application logic, and a local secret store for credentials and sessions. It does not write Telegram credentials or session data to project files.

## What it can do

- Send messages as your Telegram user to Saved Messages, usernames, phone numbers, groups, and channels
- Send one explicitly confirmed local file as an exact document or validated native photo
- Download one Telegram attachment to a private local file without overwriting
- List your chats, groups, and channels with the IDs needed to message them
- Read a chat's recent messages, search messages, list unread chats, and reply to a specific message
- Sign in with a QR code or phone number
- Export Saved Messages to Markdown, preserving rich text, tags, forwards, and reply links
- Optionally download media alongside an export
- Send Telegram push notifications through your own bot, with HTML, MarkdownV2, and silent delivery support
- Ask a correlated free-text or multiple-choice question and wait for the Telegram response
- Route Codex and Claude Code permission requests to Telegram approval buttons
- Run as a stateless MCP server (protocol 2026-07-28), locally over stdio or remotely behind Log in with Telegram
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

Set `BUDDYTG_SECRETS_DIR` to an absolute path to use a different file-backed directory (this also selects the file backend on macOS). Do not point it at a repository. The file store refuses secret files and directories that belong to another user or that group or others can write. Environment variables still override stored values.

On macOS, secrets are written to the Keychain through `security -i` on stdin, so they never appear in a process argument list.

## Quick start

Clone the repository, install dependencies, and log in:

```bash
bun install
bun run buddytg login
```

BuddyTG asks for your Telegram API credentials the first time and stores them in the local secret store. For QR login, open Telegram and go to **Settings → Devices → Link Desktop Device**, then scan the code shown in the terminal.

On Linux, MTProto uses Telegram's WebSocket front (`wss://venus.web.telegram.org/apiws` for DC2) with `dns.setDefaultResultOrder("ipv4first")`, because direct TCP to the DC is reset during the unencrypted auth-key handshake on some hosts. macOS still uses TCP. Set `BUDDYTG_TRANSPORT=tcp` or `BUDDYTG_TRANSPORT=websocket` to override.

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

`--confirm-telegram` asks for the approval in Telegram instead: your bot sends the resolved recipient
and the file details with **Send file** and **Don't send** buttons. The MCP `buddytg_send_file` tool
always uses it.

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

### Read, search and reply

```bash
# The last 20 messages of a chat, oldest first; page back with --before
bun run buddytg history -1001234567890
bun run buddytg history -1001234567890 --limit 50 --before 4120

# Search every chat, or one chat
bun run buddytg search "invoice"
bun run buddytg search "invoice" --chat -1001234567890

# Chats with unread messages, among your 500 most recent dialogs, archived ones included
bun run buddytg unread
bun run buddytg unread --skip-archived

# Reply to message 4120 in that chat
bun run buddytg reply -1001234567890 4120 "On it"
```

`history`, `search` and `unread` print a header line, then one JSON object per message or chat.
Names and text are written by other people, so JSON quoting keeps a crafted message on its own line,
and invisible or direction-changing characters are printed as `\u` escapes. Reading never marks
messages as read. Text from content-protected chats is left out, and messages longer than 2,000
characters are cut, with `truncatedFrom` giving the full length.

`reply` checks that the message exists in that chat first. Telegram would otherwise post a reply to
a missing ID as an ordinary message.

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
dedicated BuddyTG bot. A second `ask` (or `hook permission`, or `file send
--confirm-telegram`) for the same token fails at once with "Another buddytg
process … is running" instead of competing for updates, and a Telegram
getUpdates conflict from a consumer elsewhere is reported the same way.

### Answer Codex and Claude Code approvals from Telegram

This repository already contains project-local hook configurations for
[Codex](https://learn.chatgpt.com/docs/hooks) and
[Claude Code](https://code.claude.com/docs/en/hooks):

- `.codex/hooks.json`
- `.claude/settings.json`

They run `bun --no-env-file src/cli.ts hook permission` from this repository's root
(Claude Code via `$CLAUDE_PROJECT_DIR`, Codex via `git rev-parse --show-toplevel`), wait for your Telegram button tap,
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

The Telegram message shows the full command (or the full tool input), every other argument such as
`dangerouslyDisableSandbox`, and the agent's own description only as a labeled extra. Invisible and
direction-changing characters are shown as `\u{…}`. A request too long for one Telegram message is
never truncated: BuddyTG sends a notice without buttons and leaves the decision to the local dialog.

For another repository, first install the standalone `buddytg` executable on `PATH` (built with
`bun run build`, see below).
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

### Run as an MCP server

`buddytg mcp` is a stateless MCP server for protocol revision `2026-07-28`. It is built on the
official v2 TypeScript SDK. Clients on `2025-11-25` and older are still served, statelessly, so
current Claude Code and Claude Desktop builds work today.

Every tool call starts a fresh CLI process. That process reads the session from the secret store,
does one thing and exits, so nothing carries over between requests.

| Tool | Does |
| --- | --- |
| `buddytg_whoami` | Shows the logged-in account |
| `buddytg_chats` | Lists or searches dialogs and their numeric IDs |
| `buddytg_send` | Sends text to a numeric ID |
| `buddytg_reply` | Replies to one message ID; sends nothing if that message is gone |
| `buddytg_history` | Reads a chat's recent messages, oldest first (stdio, or HTTP with `--allow-read`) |
| `buddytg_search` | Searches all chats or one chat (stdio, or HTTP with `--allow-read`) |
| `buddytg_unread` | Lists chats with unread messages (stdio, or HTTP with `--allow-read`) |
| `buddytg_send_file` | Uploads one local file as a document after you approve it in Telegram (stdio only) |
| `buddytg_notify` | Pushes a notification through your bot |
| `buddytg_ask` | Asks through your bot and waits for the reply |

**Local, over stdio.** The client launches the process, so access is limited to your OS user:

```bash
claude mcp add buddytg -- buddytg mcp
# from a source checkout:
claude mcp add buddytg -- bun --cwd /path/to/BuddyTG --no-env-file src/cli.ts mcp
```

**Remote, over Streamable HTTP with Log in with Telegram.** Run this behind a stable HTTPS hostname,
for example a Cloudflare named tunnel pointing at `127.0.0.1:8790`:

```bash
buddytg mcp http --url https://buddytg.example.com
```

1. In [@BotFather](https://t.me/BotFather), open your bot, then **Bot Settings → Login Widget**. Add
   both URLs the server prints to **Allowed URLs**: the origin, and `/oauth/telegram/callback`.
2. Run `buddytg mcp setup` and paste the **Client ID** and **Client Secret** shown there.
3. Add `https://buddytg.example.com/mcp` as a connector in Claude, or run
   `claude mcp add --transport http buddytg https://buddytg.example.com/mcp`.

The server is also its own OAuth 2.1 authorization server. Claude registers through Client ID
Metadata Documents or dynamic registration, then opens a consent page that names the client and
where it will return. That page hands off to Telegram's OpenID Connect login (`oauth.telegram.org`,
PKCE, RS256/ES256 `id_token`). Only the Telegram account that owns the BuddyTG session can finish:
the ID stored by `buddytg notify`, or the comma-separated `BUDDYTG_MCP_ALLOWED_IDS`. Anyone else
gets a refusal page after Telegram login.

The authorization server keeps no session store either. Client registrations, the in-flight
Telegram login, authorization codes and tokens are JWTs. They are signed, or encrypted where they
carry a PKCE verifier, with keys derived from one secret. Access tokens last an hour and are bound
to the `/mcp` resource. Refresh tokens rotate on every use, and a sign-in lasts at most 30 days no
matter how often it is refreshed. `buddytg mcp revoke` replaces the stored secret, which signs every
client out. If `BUDDYTG_MCP_SECRET` comes from the environment, revoke refuses: rotate it where it is
defined. An environment secret must be at least 32 random bytes in base64url.

The consent page is a same-origin form. Approving it sets a short-lived cookie, and the Telegram
callback only completes in the browser that approved, so a Telegram login link sent by someone else
cannot grant access. Client ID Metadata Documents are fetched only from public addresses, with a
16 KiB cap.

Settings are read from the environment first, so `doppler run -- buddytg mcp http` works. The
variables are `BUDDYTG_MCP_URL`, `BUDDYTG_MCP_SECRET`, `TG_LOGIN_CLIENT_ID`,
`TG_LOGIN_CLIENT_SECRET` and `BUDDYTG_MCP_ALLOWED_IDS`. Without them, the secret store is used. The
HTTP server binds `127.0.0.1` and validates `Host` and `Origin`. It does not expose
`buddytg_send_file`, because a remote caller could then upload any file your user can read. Over
stdio, every upload waits for your **Send file** tap in Telegram (the message names the resolved
recipient and the file), and paths inside BuddyTG's secret store are refused.

Over HTTP the reading tools are off unless you start the server with `buddytg mcp http --allow-read`.
With them on, anyone holding a valid access token can read and search every chat on the account.
Every reading tool, and the server instructions, tell the model that names and message text are
untrusted data. That makes prompt injection harder, but a model can still be talked into acting on a
message, so keep sends confirmed in your client.

Live end-to-end test against your own account, which posts messages to the chats you list:

```bash
BUDDYTG_LIVE_CHATS=-1001234567890,-4612345678 bun test src/mcp/live.e2e.test.ts
```

### Inspect or remove the session

```bash
bun run buddytg whoami
bun run buddytg logout
```

`logout` attempts to revoke the Telegram session and removes BuddyTG's API credentials, user session, bot token, and chat ID from the local secret store. It lists any of these still set in the environment.

Logging in as a different Telegram account removes the stored bot chat ID and MCP secret, because both
belong to the previous account. Run `buddytg notify "Ready"` again afterwards.

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

Bun normally loads `.env` and `bunfig.toml` (including `preload` scripts) from the directory it runs
in. BuddyTG's own launchers avoid that: the built executable disables both, and the pi extension, MCP
tools and hooks start Bun in the BuddyTG directory with `--no-env-file`. If you run
`bun src/cli.ts` yourself inside another repository, that repository's `.env` and `bunfig.toml` apply.

## Build a standalone executable

```bash
bun run build
./dist/buddytg whoami
```

To invoke it from anywhere, copy `dist/buddytg` into a directory already on your `PATH`. The build
passes `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`, so the executable ignores `.env`
and `bunfig.toml` in whatever directory it runs from. Rebuild and reinstall any copy built before
this change.

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
| `src/messages.ts` | History, search, unread and reply commands, with untrusted JSON-line output |
| `src/file-commands.ts` | Confirmed Telegram upload/download orchestration and progress reporting |
| `src/file-transfer.ts` | File argument parsing, local preflight, validation, and private atomic writes |
| `src/peer-target.ts` | Safe resolution of IDs, phone numbers, and Telegram links |
| `src/telegram.ts` | MTProto clients, authentication state, and session persistence |
| `src/mtproto-transport.ts` | TCP vs WebSocket MTProto selection (Linux defaults to WebSocket) |
| `src/bot.ts` | Telegram Bot API calls and bot target loading |
| `src/ask.ts` | Correlated Force Reply/inline-button questions and long polling |
| `src/permission-hook.ts` | Shared Codex/Claude permission-hook input and decision mapping |
| `src/keychain.ts` | Effect secret-store service (macOS Keychain or a private user directory) |
| `src/lock.ts` | Single-instance lockfile for each bot's update stream |
| `src/prompt.ts` | Interactive and secret terminal prompts |

The Telegram client uses in-memory storage. After authenticated operations, its exported session is persisted in the local secret store rather than in a session file inside the project.

## Security notes

- Treat `api_hash`, bot tokens, and exported Telegram sessions as secrets.
- BuddyTG stores secrets in the macOS Keychain or a private `0700` user directory unless an environment variable overrides them.
- Message contents still pass through Telegram's user or bot APIs as required by the selected command.
- `history`, `search` and `unread` hand other people's messages to whatever reads the output. Over MCP HTTP they need `--allow-read`.
- Approval hooks send the project name, tool name, and the full command or tool input to your configured private Telegram chat.
- Telegram replies are accepted only from the configured chat and when correlated to the active prompt; use a dedicated bot and protect its token.
- Markdown exports and downloaded media contain your Telegram data; choose their destination and permissions accordingly.
- File uploads never accept a URL or directory and do not begin before the exact resolved recipient ID is confirmed.
- Direct downloads refuse collisions, use private temporary files, enforce a streaming size limit, and publish only complete data.
- A successful upload is reported only with Telegram's returned message ID. If an upload started but Telegram did not return an ID, BuddyTG reports delivery as unknown instead of claiming success.
