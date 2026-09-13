# BuddyTG for pi

This repository is a local pi package. The existing Bun CLI and compiled executable are unchanged. The extension starts the repository's `src/cli.ts` through Bun using an argv array, never a shell. It works when pi itself runs under Node.

## Activate

From this repository:

```sh
bun install
bun run typecheck
bun run test
pi -e ./pi/index.ts
```

For all projects, after any concurrent settings edits finish:

```sh
pi install .
```

Then restart pi or use `/reload`. Do not install both the single-file entry and package, or register the extension in another global extension too. The plugin itself does not modify global settings. The package explicitly exports no skills, avoiding collisions with separately installed BuddyTG or unslop skills.

Bun must be on Pi's PATH. The portable `buddytg/` folder in `OxFrancesco/pi-extensions` contains the same plugin and CLI sources. Run `bun install` in that folder before loading it. Load only one copy. If the BuddyTG package is already installed globally, exclude the portable entry with `"-extensions/buddytg/pi/index.ts"` in the global settings `extensions` array.

Use `/buddytg login` in the Pi terminal, approve the dialog, then scan the QR with your Telegram app. Pi suspends its TUI and gives the existing CLI inherited terminal input/output. API setup and masked 2FA prompts run there, not in chat or tool results. Ctrl+C cancels; Pi restores its TUI in a finally block. The screen is cleared afterward, but external terminal recording/scrollback is outside the plugin's control. Credentials and sessions use the CLI secret store: macOS Keychain or the private Linux file backend. The probe uses the same platform transport selection as the CLI. The plugin does not assume that whoever scans is Francesco; it displays the actual account returned by Telegram.

## Tools and command

- `buddytg_whoami` shows the active account.
- `buddytg_chats` lists or searches up to 200 dialogs, optionally including archived chats.
- `buddytg_send` sends exact plain text to a previously verified numeric recipient ID.
- `buddytg_send_file` sends a nonempty regular local file as a document. Relative paths resolve against pi's current directory. It checks for changes during approval and uses the CLI's exact recipient confirmation and upload checks.
- `/buddytg` displays help; `/buddytg whoami` retains the existing account command.
- `/buddytg login` opens private interactive QR login after confirmation.
- `/buddytg logout` explicitly confirms before running the existing CLI logout, including removal of API and bot secrets. This affects the CLI too.
- `/buddytg refresh` performs a fresh read-only account check.
- `/buddytg status` displays the most recent check without network access.

## Status beside No-Stop

`BuddyTG: Active` is right-aligned in the existing No-Stop widget row immediately above the input's top border. No-Stop retains its own left-hand label, commands, cancellation behavior and verifier. The previous top-right terminal overlay is removed. BuddyTG does not call `setWidget`, `setHeader`, `setFooter`, `setEditorComponent` or `showOverlay` for status.

The global owner at `~/.pi/agent/extensions/nostop/index.ts` now uses `src/status-row.ts` to render both labels in one width-aware component. It preserves the original one-cell side padding. Long No-Stop text truncates to leave space for the badge; on very narrow terminals the badge hides rather than wrapping or obscuring No-Stop. Resizes and theme changes render fresh output. `pi-logo-loader.ts` still owns the π animation in the editor border below this row; `cute-welcome.ts` still owns the welcome header. Neither was changed.

The owner and publisher cooperate through `pi.events`, with no imports between the two extensions:

- `nostop:row-status:v1` accepts `{ id: "buddytg", status: { text, tone } }`. The four badge texts are `BuddyTG: Active`, `BuddyTG: Inactive`, `BuddyTG: Checking...`, and `BuddyTG: Error`. Tone is `success`, `muted`, or `error`.
- `{ id: "buddytg", status: null }` removes only BuddyTG's contribution.
- `nostop:row-status-request:v1` requests a replay. No-Stop subscribes and requests on startup; BuddyTG subscribes and publishes on startup. Either startup order works.
- The owner validates IDs, bounded single-line text without terminal controls, and tones. Status events carry no account names, credentials, actions or authentication authority. Both sides unsubscribe on shutdown; pending account checks are aborted and late results ignored.

This is a local cooperative integration, not a built-in Pi slot. The global No-Stop edits are outside this repository and must accompany it on another machine. Without the patched owner, BuddyTG deliberately creates no fallback row or overlay; `/buddytg status` still works. Reload or restart Pi to load both changes. When both distributions are present, use the scoped exclusion above to prevent duplicate registration.

Active means the last account probe confirmed authentication, not a continuous connection guarantee. Inactive means the selected secret store explicitly reports no session item. Permission denial, locked Keychain, malformed credentials/session, revoked-session errors, network failures and timeouts remain Error. Checking replaces the previous badge during a probe or approved account operation. `/buddytg status` retains the detailed account identity from the last check.

Startup/reload performs one read-only check; additional checks happen only on explicit refresh or after an explicitly approved login/logout. No polling occurs. Account commands and status publishing are TUI-only, not RPC/print/JSON.

All sends require a fresh UI confirmation, including sends to the user's own account. There is no model-controlled approval parameter. Print/JSON mode cannot send. RPC requires a client that responds to pi confirmation dialogs; no response cancels after 60 seconds. The manifest includes the exact numeric recipient, message or file path, byte size and caption. Resolve recipients with the read tools first.

## Limits and privacy

Commands have a 60-second deadline and honor tool cancellation. Cancellation kills the direct Bun CLI process. Interrupted or failed sends have unknown delivery status and must not be automatically retried. Large uploads may need the standalone CLI.

Only the first 24 KiB of stdout is retained. Additional output is drained and discarded, not written to temporary files. Stderr is always drained and discarded because transport errors may include credentials. Failures return a generic diagnostic, not raw exception text. Successful read output contains private Telegram account data and becomes part of pi's session and model context.

This is not a sandbox for pi's other tools. Shell access can still invoke the standalone CLI. The extension does not add bots, background polling, notification hooks, model-callable login/logout tools, exports, downloads, native-photo uploads or arbitrary CLI passthrough. Existing CLI commands remain available. Account checks use a separate Bun-only probe with a 20-second deadline; it returns only sanitized account state, never Keychain values or raw diagnostics. File approval is path/metadata based, not a cryptographic snapshot; another local process can change a file after the extension's final check. The CLI retains its own opened-file validation.

## Tests

`bun run test` covers the existing CLI plus literal argv handling, bounded capture, withheld stderr, process failure, cancellation/deadlines, approval denial and cancellation, and native pi extension loading. Tests use local subprocesses and simulated confirmation callbacks. They do not send Telegram messages or require credentials. Account tests also cover strict missing-item handling, malformed responses, explicit-action gates and error privacy using mocks. The integration test loads the actual global No-Stop extension through Pi's native loader and uses deferred fake account probes. It checks both startup orders, one-row right alignment, No-Stop on/off coexistence, all badge states, shutdown, reload and stale-result rejection. It defaults to `~/.pi/agent/extensions/nostop/index.ts`; set `NOSTOP_EXTENSION` to test another copy. It is explicitly skipped if that owner is absent.

Run the owner's regression tests and typecheck separately:

```sh
bun test ~/.pi/agent/extensions/nostop/*.test.ts
bunx --no-install tsc --noEmit --strict --skipLibCheck --target ESNext --module Preserve --moduleResolution bundler --allowImportingTsExtensions --types bun ~/.pi/agent/extensions/nostop/index.ts ~/.pi/agent/extensions/nostop/status-row.test.ts
```

The owner tests cover ANSI/Unicode widths, narrow terminals, resizing, theme invalidation, malformed events and listener cleanup, plus existing verifier lifecycle tests. No live authentication, Telegram send, model call or manual TUI/RPC approval rendering is exercised.
