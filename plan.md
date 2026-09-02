# Linux secret store + MTProto transport

- [x] Inspect Keychain/`security` usage and other darwin-only calls
- [x] Add file-backed secret store (XDG/home, 0700/0600) behind the existing Effect `Keychain` service
- [x] Keep macOS Keychain via `security` when available on darwin
- [x] Update CLI copy, README, and agent skills so Linux is first-class
- [x] Add tests for Linux save/load, permissions, and backend selection
- [x] Run `bun run test` and `bun run typecheck`
- [x] Open PR
- [x] Switch Linux MTProto to official WebSocket + IPv4-only (keep macOS TCP)
- [x] Re-run tests/typecheck and update PR
- [x] Fix Bun WebSocket constructor: protocols sequence, not options object
