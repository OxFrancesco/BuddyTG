# BuddyTG

Send Telegram messages as yourself (a real user account, not a bot) from the terminal.
Built with [mtcute](https://mtcute.dev) (MTProto) and [Effect](https://effect.website).
Your session is stored only in the macOS Keychain — nothing on disk.

## Setup

```bash
bun install
```

Get your Telegram API credentials (**api_id** and **api_hash**) from
**<https://my.telegram.org/apps>** — log in with your phone number, then create
an app (any name works). You'll be asked for them once during `login`, and they
are stored in the Keychain. Alternatively, set `TG_API_ID` / `TG_API_HASH`.

## Usage

```bash
bun run buddytg login              # scan a QR code with the Telegram app (default)
bun run buddytg login --phone      # or log in with phone number + code
bun run buddytg send me "ping"     # message yourself (Saved Messages)
bun run buddytg send @user "hi"    # message someone
bun run buddytg bookmarks          # export Saved Messages to saved-messages.md
                              # keeps rich formatting, tags, and reply links
bun run buddytg bookmarks --download-media   # also save photos/files next to the export
bun run buddytg bot login          # set up your notification bot (token from @BotFather)
bun run buddytg notify "done!"     # push notification via your own bot
bun run buddytg notify --html "<b>Build passed</b> ✅ <a href='https://example.com'>logs</a>"
bun run buddytg notify --markdown "*Build passed* ✅ [logs](https://example.com)"
bun run buddytg whoami             # show logged-in account
bun run buddytg logout             # log out + wipe Keychain entries
```
