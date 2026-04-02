# golem-workers-openclaw-channel-plugin

Relay-backed OpenClaw channel plugin skeleton with a typed control-plane contract,
account runtime management, plugin-owned routing, file data-plane helpers, and
focused contract tests.

## What is implemented

- standalone TypeScript package with build, lint, and test scripts
- `openclaw.plugin.json` plus package entrypoints
- typed control-plane and data-plane schemas with `zod`
- plugin-owned `config`, `setup`, `status`, `security`, `pairing`, and
  `approvalCapability` surfaces
- account-scoped runtime registry and WebSocket relay client
- canonical target resolution, session routing, outbound route building, and
  durable in-memory persistence helpers
- outbound text send and file-download request actions
- capability-gated shared message-tool action discovery
- replay-gap, reconnect, and duplicate-terminal-event handling tests

## Project structure

```text
.
├── docs/
├── index.ts
├── openclaw.plugin.json
├── setup-entry.ts
├── runtime-api.ts
├── api.ts
└── src/
    ├── account-runtime.ts
    ├── approval.ts
    ├── channel.test.ts
    ├── channel.ts
    ├── config.ts
    ├── file-data-plane.ts
    ├── message-actions.ts
    ├── outbound-adapter.ts
    ├── outbound-session-route.ts
    ├── pairing.ts
    ├── persistence.ts
    ├── relay-client.ts
    ├── relay-events.ts
    ├── security.ts
    ├── session-conversation.ts
    ├── status.ts
    ├── target-resolution.ts
    ├── thread-bindings.ts
    └── protocol/
```

## Commands

```bash
npm install
npm run build
npm run lint
npm run test
```

## Docs

- spec: `relay-channel-plugin-spec.md`
- implementation plan: `docs/relay-channel-plugin-implementation-plan.md`

## Current limitations

- persistence is in-memory only; no durable store backend is wired yet
- directory lookup is local grammar-only; no live relay directory API is used yet
- the package defines a local channel-plugin contract shim because the actual
  OpenClaw SDK package is not part of this repository