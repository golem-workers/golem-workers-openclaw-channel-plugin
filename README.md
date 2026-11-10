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
`package.json`, and `package-lock.json`. The archive intentionally excludes
`node_modules`: OpenClaw installs the locked runtime dependencies once while
installing the plugin.

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

## Managed security baseline (2026-10-28)

Managed images use Node.js >=24.22.1 <25 (`.nvmrc`: 24.22.1). The plugin has its
own resolved dependency tree, independent of backend/relay: runtime Zod >=4.6.7
and test-only ws >=8.22.0. Update and validate this tree when baking new images;
root relay updates do not update an already installed plugin. Existing agent
updates are performed separately by the owner, not by backend-updater.

### October 2026 toolchain security resolution

The committed lockfile refreshes compatible development dependencies (without runtime API changes or new environment variables). Build/lint/test and the full dependency audit validate the selected graph; existing agent installations are not modified.

## Subscription-only pool guard

The optional managed OpenAI subscription pool guard requires the unchanged official
OpenClaw **2026.9.8 or newer**, the public read-only auth-store SDK and supported
model/run/reply hooks. There is no gap or upper version-number cutoff. Versions
2026.9.8 through pre-2026.11.2 use the strict adapter; >=2026.11.2 uses run-scoped
suppression when the asynchronous reader is available, otherwise strict mode. Ordinary channel operation retains its existing
minimum host version. Unsupported hosts do not advertise
`relay-channel.subscriptionGuard.status`; Relay refuses pool authorization before
credential effects with `OPENAI_POOL_GUARD_UPDATE_REQUIRED`.

A separate, explicit agent setup/update must load this plugin and provision
`plugins.entries["relay-channel"].hooks.allowConversationAccess: true` (without
`allowPromptInjection: false`). Authorization never installs plugins, grants hook
access, repairs the runtime, or changes the selected model/Harness. Configuration
owners must keep the guard enabled while the managed pool is active. Codex must
use the standard isolated stdio app-server credential bridge, not user-home or a
remote app server.

For a managed pool, admission reads the durable pool receipt and the target
agent's public auth store without refresh, external CLI synchronization or
keychain prompts. Pending, exhausted, malformed, foreign-token and unsupported
routes fail closed. On >=2026.11.2, run-scoped `fallbacksOverride: []` suppresses
authored model fallbacks **without rewriting persisted configuration**. Only the explicit
ChatGPT subscription route is accepted; unrelated API-key profiles are preserved
but cannot fund an accepted run. The plugin does not infer dispatch account or
billing from the current profile pin. Unmanaged agents are unaffected.

Qualification includes pure admission tests and unchanged official-Gateway
negative probes for chat, external agent RPC, heartbeat/cron context and actual
`cron.run`, with both OpenClaw and correctly installed official Codex Harness.
Synthetic API keys and authored paid fallbacks are retained; the negative probes
run in a network namespace with no external route. These negative probes do not
replace positive real-subscription or provider-lifecycle acceptance.

### Continuous host compatibility (>=2026.9.8)

Versions before 2026.11.2 conservatively use strict mode even where intermediate
hooks already gained some modern features. The adapter prefers the public async
reader when available, otherwise the synchronous `ensureAuthProfileStore`, with
`readOnly: true`, no external CLI sync and no keychain prompts. The minimum is
2026.9.8, with no upper version-number cutoff; unknown versions, missing public
readers or missing hook consent do not advertise a capability. Version admission
is not a guarantee against a future incompatible upstream SDK/hook change.

Strict mode advertises capability **v2**, `runScopedFallbacks: false`,
`configuredFallbacksForbidden: true`, `readOnlyAdmission: true`. Matching Relay
rejects any nonempty authored `fallback`/`fallbacks` source before pool effects,
including nested settings. The guard repeats the check before each run and
permits only the agent's authored selected primary: injected cron/session
candidates cannot authorize another model. Model overrides must be explicitly
saved before use. No model/Harness/reasoning/fallback settings are rewritten.
A host-normalized empty default `baseUrl` resolves to the canonical ChatGPT
endpoint; custom/API endpoints and direct credentials remain forbidden.

>=2026.11.2 with the async public reader keeps capability **v1** and run-scoped
suppression. A newer host with only the synchronous reader can use strict v2
instead of being rejected just for lacking async. Both modes return explicit
`{ outcome: "pass" }` / `{ outcome: "block" }` run decisions: even modern official
hook runners reject an invalid/void decision.

Reproduce the official-host fixture after building this plugin and Relay:

```sh
OPENCLAW_ROOT=/path/to/official/openclaw \
POOL_RELAY_ROOT=/path/to/built/golem-workers-relay \
node scripts/qualification/openclaw-range.mjs
```

The old `openclaw-98.mjs` / `OPENCLAW_98_ROOT` entrypoint remains an alias. The
fixture creates/removes temporary Gateway/state and uses synthetic credentials
with a child-only synthetic ChatGPT transport. It checks the actual SDK, hook
runner, loaded capability, native A/429-to-B dispatch, live auth refresh and
exhausted-pool refusal without API-key dispatch or authored config mutation.
`chatgpt-fixture.mjs` is test-only: never load it in an agent service. This is
**not real OAuth inference acceptance**; real-account native/Codex and lifecycle
acceptance remain separate release gates. See `docs/openclaw-host-compatibility.md`
for the version matrix and evidence scope.
