
<!-- codeview:start -->

## Reference codebases (codeview)

The `resources/` folder contains read-only clones of reference codebases.
If you need to implement code specific to one of these codebases, read the relevant
folder to gather information, feedback, patterns, and templates before writing code.

- `resources/effect` — Effect TypeScript library — functional effect system, concurrency, streams, schema
- `resources/mtcute` — mtcute TypeScript MTProto client — peer resolution, dialogs, links, storage
- `resources/twitterapi-io` — Official TwitterAPI.io API documentation and agent integrations

<!-- codeview:end -->

## Telegram notifications

When you finish a significant task (or hit a blocker needing the user), notify Francesco
on Telegram using the `telegram-notify` skill (`.agents/skills/telegram-notify/SKILL.md`).
Follow its argv-safe execution pattern; never interpolate dynamic fields into shell source.
Format the rich HTML as "Agent X is done with Y in Z":

```html
<b>✅ Agent X is done!</b>

<b>Task:</b> task summary
<b>Project:</b> <code>project</code>
```
