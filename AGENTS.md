
<!-- codeview:start -->

## Reference codebases (codeview)

The `resources/` folder contains read-only clones of reference codebases.
If you need to implement code specific to one of these codebases, read the relevant
folder to gather information, feedback, patterns, and templates before writing code.

- `resources/effect` — Effect TypeScript library — functional effect system, concurrency, streams, schema

<!-- codeview:end -->

## Telegram notifications

When you finish a significant task (or hit a blocker needing the user), notify Francesco
on Telegram using the `telegram-notify` skill (`.devin/skills/telegram-notify/SKILL.md`).
Format: rich HTML, "Agent X is done with Y in Z":

```bash
tg notify --html "$(printf '<b>✅ %s is done!</b>\n\n<b>Task:</b> %s\n<b>Project:</b> <code>%s</code>' "Devin" "task summary" "project")"
```

