---
name: telegram-notify
description: Notify Francesco on Telegram when an agent finishes a task, completes a goal, ends a long-running job, or needs attention. Use when done with significant work (feature complete, build/deploy finished, tests passing, PR pushed), when a task fails and needs the user, or when asked to "ping me", "notify me", or "send me a message on Telegram". Sends rich-formatted push notifications via the buddytg CLI.
---

# Telegram Notify

Send Francesco a real push notification on Telegram when you finish a task.

## Command

```bash
buddytg notify --html "<message>"
```

`buddytg` is installed globally at `~/.local/bin/buddytg`. Fallback if missing:
`bun run buddytg notify ...` from `/Volumes/T6-7/Coding/Personal/BuddyTG`.

## Message format (required)

Always use `--html` and follow this template — "Agent X is done with Y in Z":

```bash
buddytg notify --html "$(printf '<b>✅ %s is done!</b>\n\n<b>Task:</b> %s\n<b>Project:</b> <code>%s</code>\n\n%s' \
  "<agent name, e.g. Devin / Claude Code>" \
  "<short task summary>" \
  "<repo/project name>" \
  "<optional details: results, links, next steps>")"
```

Example:

```bash
buddytg notify --html "$(printf '<b>✅ Devin is done!</b>\n\n<b>Task:</b> QR login + bot notifications\n<b>Project:</b> <code>BuddyTG</code>\n\nBuild ✅ Types ✅ <a href="https://github.com/OxFrancesco/BuddyTG">Pushed to GitHub</a>' )"
```

For failures or blockers, use `<b>⚠️ ... needs attention</b>` instead of `✅ ... is done!`.

## Rules

- Supported HTML tags: `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a href="...">`, `<blockquote>`, `<tg-spoiler>`.
- Escape literal `<`, `>`, `&` in dynamic content as `&lt;`, `&gt;`, `&amp;`.
- Use `printf` with `\n` for newlines (raw `\n` inside quotes is not interpreted).
- Add `--silent` for low-priority FYI messages (no sound).
- Notify once per completed task, not per step. Do not spam.
- If the command fails with a missing bot token, run `tg bot login` is required — ask the user, never guess a token.
- Never print or log the bot token or session; secrets live in the local secret store.
