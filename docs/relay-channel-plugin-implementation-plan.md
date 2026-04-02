# Relay Channel Plugin Implementation Plan

This document mirrors the approved implementation plan and anchors it inside the
plugin repository.

## Source anchors

- spec: `../relay-channel-plugin-spec.md`
- package overview: `../README.md`

## Step 1. Create package skeleton and typed protocol layer

- add `openclaw.plugin.json`, `package.json`, `index.ts`, `setup-entry.ts`,
  `api.ts`, and `runtime-api.ts`
- assemble the channel in `src/channel.ts`
- define typed control-plane and data-plane schemas in
  `src/protocol/control-plane.ts` and `src/protocol/data-plane.ts`
- lock internal shapes for capability snapshots, account status, session
  conversation, and action records

## Step 2. Implement core channel surfaces

- implement `config`, `setup`, `status`, `security`, `pairing`, and
  `approvalCapability`
- keep DM policy, allowlists, approvals, and session semantics plugin-owned
- expose `connecting`, `healthy`, `degraded`, and `stopped` account states

## Step 3. Build account runtime and relay client

- implement account runtime registry in `src/account-runtime.ts`
- implement relay connect, hello handshake, capability snapshot, reconnect, and
  replay hooks in `src/relay-client.ts`
- correlate requests and actions by `requestId`, `actionId`, and
  `idempotencyKey`

## Step 4. Implement routing and plugin-owned state

- implement target normalization and explicit target parsing in
  `src/target-resolution.ts`
- implement `resolveSessionConversation(...)` in `src/session-conversation.ts`
- implement `resolveOutboundSessionRoute(...)` in
  `src/outbound-session-route.ts`
- keep replay cursors, thread bindings, message correlations, and recent action
  records in plugin-owned persistence helpers

## Step 5. Add delivery and capability gating

- implement outbound text send and inbound text receive flow
- capability-gate edit, delete, reaction, typing, poll, topic, callback, and
  approval-native actions
- derive shared `message` tool actions from current account and target
  capabilities instead of stale caches

## Step 6. Add local file data plane

- keep file transfer bytes on loopback HTTP data-plane URLs
- use upload/download tokens instead of raw WebSocket bytes
- keep action lifecycle and final status on the control plane

## Step 7. Harden with replay, tests, and docs

- suppress duplicate terminal events safely
- surface replay gaps explicitly
- refresh capabilities after reconnect
- cover unit, integration-style, and conformance scenarios with tests
- keep `README.md` and this document updated with the implemented contract

## Recommended delivery order

1. Skeleton and protocol schemas.
2. Core channel surfaces.
3. Runtime and relay handshake.
4. Routing and plugin-owned state.
5. Baseline text delivery.
6. File data plane.
7. Capability-gated features.
8. Replay, reliability, tests, and docs.
