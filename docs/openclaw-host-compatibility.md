# OpenClaw host compatibility for subscription pools

## Admission policy

Minimum **2026.9.8**, inclusive; no upper version-number cutoff. Missing or
unparseable runtime version, required public auth readers, state API, hook API or
hook consent prevents advertising the guard and therefore prevents pool effects.
The version threshold does not promise compatibility with an unreleased upstream
breaking SDK/hook change.

| Host / actual public SDK | Policy |
| --- | --- |
| >=2026.9.8 and <2026.11.2; sync or async reader | Strict v2, no authored fallback sources, runtime candidate equals saved primary |
| >=2026.11.2 with async reader | Existing v1, per-run fallback suppression |
| >=2026.11.2 with sync reader only | Strict v2 |
| Below minimum, unknown version, no reader or hook consent | No capability, authorization refuses before credential effects |

Both modes use explicit `pass`/`block` run-hook decisions. Earlier modern code's
void success could itself be normalized into a block by the actual host runner;
positive modern-host qualification covers this correction. SDK reads disable
refresh/external CLI sync/keychain prompts and do not rewrite model/Harness/config.

## Published release audit (2026-11-10)

The official npm package archives for all **18 stable releases** in 2026.9.8–
2026.11.2 were inspected read-only. Columns below record public provider-auth
reader exports and actual run/model-hook implementation, **not an end-to-end
Gateway execution on every release**. All 18 packages also expose the public
post-mutation `models.authRefresh` handler. Intermediate releases stay conservatively
strict even if they already retain `fallbacksOverride`.

| Official release | Sync reader | Async reader | Explicit run decision | Hook retains fallbacksOverride |
| --- | --- | --- | --- | --- |
| 2026.9.8 | yes | no | yes | no |
| 2026.9.9 | yes | no | yes | no |
| 2026.9.33 | yes | no | yes | no |
| 2026.9.34 | yes | no | yes | no |
| 2026.9.35 | yes | no | yes | no |
| 2026.9.36 | yes | no | yes | no |
| 2026.10.1 | yes | no | yes | no |
| 2026.10.2 | yes | no | yes | no |
| 2026.10.3 | yes | no | yes | no |
| 2026.10.4 | yes | no | yes | no |
| 2026.10.5 | yes | no | yes | no |
| 2026.10.6 | yes | no | yes | no |
| 2026.10.7 | yes | no | yes | no |
| 2026.10.8 | yes | no | yes | no |
| 2026.10.9 | yes | no | yes | no |
| 2026.10.10 | yes | yes | yes | yes |
| 2026.11.1 | yes | yes | yes | yes |
| 2026.11.2 | yes | yes | yes | yes |

## Executed Gateway matrix

Unmodified official packages, pinned Node 24.22.1, sterile temporary HOME/state,
synthetic JWTs, child-only synthetic ChatGPT transport; test fixture removes its
Gateway/state. The real SDK, real loaded capability RPC and real host hook runner
are exercised. Native inference returns A/429 then B. The same live
`agents.list` + `models.authRefresh {operation:"update",agentId}` sequence as
Relay precedes exhausted-pool
refusal with no further inference requests. Depending on the host, refusal is
reported by guard admission or by the earlier explicit-auth-order validation
(`Explicit auth order for openai has no usable profiles.`); both require zero
new inference dispatches. Every host starts with a nonempty
paid-model fallback sentinel. Actual Relay Connect clears it on strict hosts
with CAS and verified Gateway application before auth writes; the exact rest of
the config is preserved. Modern mode retains the sentinel and suppresses it per
run. Admission/refresh thereafter do not rewrite configuration.

| Gateway | Result | Policy |
| --- | --- | --- |
| 2026.9.8 | passed | strict v2 |
| 2026.10.1 | passed | strict v2 |
| 2026.11.1 | passed | strict v2 with async reader |
| 2026.11.2 | passed | v1 with authored fallback sentinel |

Reproduce after building both repositories:

```sh
OPENCLAW_ROOT=/path/to/official/openclaw \
POOL_RELAY_ROOT=/path/to/built/golem-workers-relay \
node scripts/qualification/openclaw-range.mjs
```

This is synthetic native inference, **not real OAuth/native-Codex/lifecycle
acceptance**, not exact profile dispatch/billing telemetry, and not proof for all
future versions. Run admission unit tests separately cover every listed release,
SDK selection, future version-number acceptance, modern/strict policy, and refusal
for missing APIs/below-minimum hosts. No production agent or OpenClaw source was
updated by these checks.
