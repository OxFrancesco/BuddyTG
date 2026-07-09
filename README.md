# BuddyTG

A small, local-first Telegram CLI for macOS. Send messages from your personal Telegram account, export Saved Messages, and deliver push notifications through a bot you control.

BuddyTG uses [mtcute](https://mtcute.dev) for MTProto, [Effect](https://effect.website) for application logic, and the macOS Keychain for credentials and sessions. It does not write Telegram credentials or session data to project files.

## What it can do

- Send messages as your Telegram user to Saved Messages, usernames, phone numbers, groups, and channels
- List your chats, groups, and channels with the IDs needed to message them
- Sign in with a QR code or phone number
- Export Saved Messages to Markdown, preserving rich text, tags, forwards, and reply links
- Optionally download media alongside an export
- Send Telegram push notifications through your own bot, with HTML, MarkdownV2, and silent delivery support
- Keep API credentials, user sessions, bot tokens, and chat IDs in the macOS Keychain

## Requirements

- macOS, because secure storage currently uses the `security` Keychain CLI
- [Bun](https://bun.sh)
- A Telegram account
- A Telegram `api_id` and `api_hash` from [my.telegram.org/apps](https://my.telegram.org/apps)

## Quick start

Clone the repository, install dependencies, and log in:

```bash
bun install
bun run buddytg login
```

BuddyTG asks for your Telegram API credentials the first time and stores them in the Keychain. For QR login, open Telegram and go to **Settings → Devices → Link Desktop Device**, then scan the code shown in the terminal.

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

Quote messages containing shell metacharacters or spaces.

### List chats and groups

```bash
# List your most recent 50 dialogs with their IDs
bun run buddytg chats

# Filter by name or username, adjust the limit, include archived chats
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

`notify` uses the logged-in Telegram user to determine your chat ID the first time, so complete the normal user login before configuring notifications. HTML and MarkdownV2 follow Telegram's supported formatting syntax; escape dynamic or untrusted text before selecting a parse mode.

### Inspect or remove the session

```bash
bun run buddytg whoami
bun run buddytg logout
```

`logout` attempts to revoke the Telegram session and removes BuddyTG's API credentials, user session, bot token, and chat ID from the Keychain.

Run the CLI without arguments to see its built-in help:

```bash
bun run buddytg
```

## Environment variables

Environment variables take precedence over values stored in the Keychain.

| Variable | Purpose |
| --- | --- |
| `TG_API_ID` | Telegram application ID |
| `TG_API_HASH` | Telegram application hash |
| `TG_BOT_TOKEN` | Bot API token used by `notify` |

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
bun run typecheck
bun run build
```

There is currently no automated test suite. Keep command behavior and examples in this README aligned with the usage text in `src/cli.ts`.

### Project structure

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | Command parsing and command implementations |
| `src/telegram.ts` | MTProto clients, authentication state, and session persistence |
| `src/bot.ts` | Telegram Bot API calls and bot token loading |
| `src/keychain.ts` | Effect service backed by the macOS Keychain |
| `src/prompt.ts` | Interactive and secret terminal prompts |

The Telegram client uses in-memory storage. After authenticated operations, its exported session is persisted under the `buddytg` Keychain service rather than in a local session file.

## Security notes

- Treat `api_hash`, bot tokens, and exported Telegram sessions as secrets.
- BuddyTG stores secrets in the macOS Keychain unless an environment variable overrides them.
- Message contents still pass through Telegram's user or bot APIs as required by the selected command.
- Markdown exports and downloaded media contain your Telegram data; choose their destination and permissions accordingly.
