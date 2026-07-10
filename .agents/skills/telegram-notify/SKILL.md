---
name: telegram-notify
description: Notify Francesco on Telegram when an agent finishes a task, completes a goal, ends a long-running job, or needs attention. Use when done with significant work (feature complete, build/deploy finished, tests passing, PR pushed), when a task fails and needs the user, or when asked to "ping me", "notify me", or "send me a message on Telegram". Sends rich-formatted push notifications via the buddytg CLI.
---

# Telegram Notify

Send Francesco a real push notification on Telegram when you finish a task.

## Command

Use a globally installed `buddytg` when available. From a BuddyTG source checkout, run
the package script from the repository root. Dynamic notification fields must be passed
as separate argv elements; never paste them inside a shell command, command substitution,
or generated script source.

## Message format (required)

Always use `--html` and follow the wording "Agent X is done with Y in Z". Build the HTML
from escaped runtime values, then execute it without a shell:

```ts
const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const html = [
  `<b>✅ ${escapeHtml(agentName)} is done!</b>`,
  "",
  `<b>Task:</b> ${escapeHtml(taskSummary)}`,
  `<b>Project:</b> <code>${escapeHtml(projectName)}</code>`,
  ...(detailsText ? ["", escapeHtml(detailsText)] : []),
].join("\n")

const command = Bun.which("buddytg") ?
    ["buddytg", "notify", "--html", html]
  : ["bun", "run", "buddytg", "notify", "--html", html]
const child = Bun.spawn(command, {
  cwd: buddyTgRepo,
  stdout: "inherit",
  stderr: "inherit",
})
if ((await child.exited) !== 0) throw new Error("BuddyTG notification failed")
```

For failures or blockers, use `<b>⚠️ ... needs attention</b>` instead of `✅ ... is done!`.

## Rules

- Supported HTML tags: `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a href="...">`, `<blockquote>`, `<tg-spoiler>`.
- Escape literal `<`, `>`, `&` in dynamic content as `&lt;`, `&gt;`, `&amp;`.
- Join notification lines with real newline characters before passing the final HTML as one argv element.
- Add `--silent` for low-priority FYI messages (no sound).
- Notify once per completed task, not per step. Do not spam.
- If the command fails with a missing bot token, ask the user to run `buddytg bot login`
  (or `bun run buddytg bot login` from a source checkout); never guess a token.
- Never print or log the bot token or session; secrets live in the macOS Keychain.
