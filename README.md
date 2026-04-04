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
- OpenClaw SDK channel plugin entry with target resolution, outbound send wiring,
  and gateway runtime hooks
- account-scoped runtime registry and WebSocket relay client
- canonical target resolution, session routing, outbound route building, and
  durable in-memory persistence helpers
- outbound text/media send plus capability-gated edit, delete, reaction,
  typing, poll, pin, topic, callback-answer, and file-download request actions
- capability-gated shared message-tool action discovery
- transport-level event decoding for inbound message edits/deletes, reactions,
  callbacks, polls, topic updates, delivery receipts, and typing updates
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
npm run bundle:agent
npm run deploy:agent -- --host <host> --identity-file <key.pem>
```

## Docs

- spec: `relay-channel-plugin-spec.md`
- implementation plan: `docs/relay-channel-plugin-implementation-plan.md`

## Current limitations

- persistence is in-memory only; no durable store backend is wired yet
- directory lookup is local grammar-only; no live relay directory API is used yet
- OpenClaw core integration still depends on the host SDK surface; the generic
  relay plugin package already exposes richer action handlers than the current
  OpenClaw runtime invokes directly
- backend-originated transport events currently flow through the existing relay
  push ingress as `transport_event`; broader Telegram update ownership can be
  moved fully into relay later without changing the control-plane wire format

## Deploy To Agent

The repo includes SSH-based helper scripts for live-agent testing from a local
build.

### Build a self-contained bundle

This creates a `.tgz` archive with `dist/`, `openclaw.plugin.json`,
`package.json`, and production `node_modules`.

```bash
npm run bundle:agent
```

Default output path:

```text
.artifacts/relay-channel/relay-channel-bundle.tgz
```

### Upload and install on a remote agent

The deploy script:

- builds a bundle when `--bundle` is not provided
- uploads it over `scp`
- installs it into `~/.openclaw/workspace/plugins/relay-channel`
- patches `~/.openclaw/openclaw.json`
- adds the install path to `plugins.load.paths`
- adds `relay-channel` to `plugins.allow`
- removes `relay-channel` from `plugins.deny`
- optionally injects `channels.relay-channel` from a local JSON file
- restarts `openclaw-gateway.service`
- prints a post-install summary

Example:

```bash
npm run deploy:agent -- \
  --host <ssh-host> \
  --port <ssh-port> \
  --identity-file /tmp/agent-key.pem
```

With channel config:

```bash
npm run deploy:agent -- \
  --host <ssh-host> \
  --port <ssh-port> \
  --identity-file /tmp/agent-key.pem \
  --channel-config-file ./examples/relay-channel.config.json
```

To skip the restart step:

```bash
npm run deploy:agent -- \
  --host <ssh-host> \
  --identity-file /tmp/agent-key.pem \
  --no-restart
```

For backend-side diagnostics after install, use:

```bash
cd ../golem-workers-backend
npm run admin:check-relay-runtime -- --server-id <server-id> --expect-plugin-id relay-channel
```

### Full smoke cycle

This creates a temporary agent through backend admin API, waits until the agent
is ready, downloads the SSH access key, deploys the local plugin bundle over
SSH, verifies that `relay-channel` is present in OpenClaw plugin wiring, and
then deletes the server in `finally`.

By default it installs the plugin without injecting `channels.relay-channel`.
That is intentional for the first live smoke, because channel activation should
only be attempted after the plugin is proven loadable by the real OpenClaw
runtime.

```bash
npm run smoke:agent -- --base-url https://dev-api.golemworkers.com
```

To also inject channel config explicitly:

```bash
npm run smoke:agent -- \
  --base-url https://dev-api.golemworkers.com \
  --channel-config-file ./examples/relay-channel.config.json
```

To start a mock relay websocket on `127.0.0.1:43129` on the temporary agent and
run an outbound functional probe against it:

```bash
npm run smoke:agent:mock -- \
  --base-url https://dev-api.golemworkers.com \
  --channel-config-file ./examples/relay-channel.config.json
```