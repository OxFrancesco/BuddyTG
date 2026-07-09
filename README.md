# tg-ping-ping

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
bun run tg login              # scan a QR code with the Telegram app (default)
bun run tg login --phone      # or log in with phone number + code
bun run tg send me "ping"     # message yourself (Saved Messages)
bun run tg send @user "hi"    # message someone
bun run tg bookmarks          # export Saved Messages to saved-messages.md
bun run tg bot login          # set up your notification bot (token from @BotFather)
bun run tg notify "done!"     # push notification via your own bot
bun run tg notify --html "<b>Build passed</b> ✅ <a href='https://example.com'>logs</a>"
bun run tg notify --markdown "*Build passed* ✅ [logs](https://example.com)"
bun run tg whoami             # show logged-in account
bun run tg logout             # log out + wipe Keychain entries
```
