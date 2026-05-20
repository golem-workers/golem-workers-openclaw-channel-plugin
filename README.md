# golem-workers-openclaw-channel-plugin

Relay-backed OpenClaw channel plugin with Channel Message SDK delivery, a typed
loopback relay bridge, account runtime management, plugin-owned routing, and
focused contract tests.

## What is implemented

- standalone TypeScript package with build, lint, and test scripts
- `openclaw.plugin.json` plus package entrypoints
- typed loopback relay bridge schemas with `zod`
- plugin-owned `config`, `setup`, `status`, `security`, `pairing`, and
  `approvalCapability` surfaces
- OpenClaw SDK channel plugin entry with target resolution, Channel Message SDK
  `message.send` wiring, and gateway runtime hooks
- account-scoped runtime registry, HTTP relay client, and local event ingress
- canonical target resolution, session routing, outbound route building, and
  stateless handle-based routing helpers
- SDK-native outbound text/media/payload send with real `MessageReceipt`
  results, multi-file `mediaUrls`/`attachments` delivery, plus compatibility
  typing and file-download request actions
- shared `message` tool sends are prepared for OpenClaw core delivery through
  the Channel Message SDK adapter instead of the old action handler path
- transport-level event decoding for delivery receipts and typing updates
- reconnect and duplicate-terminal-event handling tests
- recovery-aware account status snapshots with reconnect diagnostics

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
    ├── relay-client.ts
    ├── relay-events.ts
    ├── security.ts
    ├── session-conversation.ts
    ├── status.ts
    ├── target-resolution.ts
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

## Runtime semantics

- transient local HTTP failures move an account into `degraded`, not `stopped`
- `stopped` is reserved for explicit teardown such as `stopAccount(...)`
- the relay client periodically refreshes `/hello` on loopback and automatically
  re-runs the hello handshake after local relay restarts or other transient HTTP
  failures
- SDK message sends use synchronous loopback `POST /actions` calls as the local
  relay transport bridge
- relay inbound events arrive through plugin-owned loopback HTTP ingress
- plain text inbound retries are coalesced before delivery; attachments stay durable

## Current limitations

- the canonical routing model is now opaque-handle based, but the host OpenClaw
  SDK surface still exposes some legacy chat-kind fields for compatibility
- control-plane transport events and outbound action envelopes are now
  handle-first (`conversation.handle`, `thread.handle`); relay-side parsers may
  still tolerate legacy compatibility fields during migration
- relay hello/capability negotiation now supports provider profiles and
  normalized provider features, but older legacy capability maps are still
  carried on the wire for migration compatibility
- plugin runtime is intentionally stateless: reconnects do not restore replay
  cursors or thread bindings, and message gaps during disconnects are tolerated
- directory lookup is local grammar-only; no live relay directory API is used yet
- OpenClaw core integration still depends on the host SDK surface; the generic
  relay plugin package already exposes richer action handlers than the current
  OpenClaw runtime invokes directly
- backend-originated transport events flow through the existing relay push
  ingress as `transport_event`; for Telegram Bot API in this stack, backend
  remains the owner of polling/webhook ingestion and secret-dependent Telegram
  transport execution, and can forward normalized delivery receipts to the
  plugin through relay without exposing bot tokens on the agent side

## Deploy To Agent

The repo includes SSH-based helper scripts for live-agent testing from a local
build.

Agent/server image preparation in the sibling repos can pin this repo
explicitly via `RELAY_CHANNEL_PLUGIN_GIT_REF` instead of relying on
`NODE_ENV`-driven branch selection.

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

### npm publish (phase 1)

The package is published as `@golemworkers/relay-channel`. Agent install still
uses the legacy bundle flow until phase 2; release automation can publish to
npm ahead of that switch.

Local validation:

```bash
npm run build
npm run validate:npm-publish
```

Dry-run publish:

```bash
npm run publish:npm-release -- --version 1.0.45 --dry-run
```

Real publish (requires `npm whoami` or `NPM_TOKEN`):

```bash
npm run publish:npm-release -- --version 1.0.45 --publish
```

`release-all.sh` prepares bundle artifacts for every plugin release. When the
plugin repo has release changes it also publishes to npm by default; use
`DRY_RUN=1` for `npm publish --dry-run` or `PUBLISH_RELAY_CHANNEL_PLUGIN_NPM=0`
to skip npm publish.

### Upload and install on a remote agent

The deploy script:

- builds a bundle when `--bundle` is not provided
- uploads it over `scp`
- installs it through `openclaw plugins install`
- optionally injects `channels.relay-channel` from a local JSON file via `openclaw config set`
- explicitly enables `relay-channel` through `openclaw plugins enable`
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

To start a mock relay HTTP control plane on `127.0.0.1:43129` on the temporary agent and
run an outbound functional probe against it:

```bash
npm run smoke:agent:mock -- \
  --base-url https://dev-api.golemworkers.com \
  --channel-config-file ./examples/relay-channel.config.json
```