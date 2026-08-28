# Persistent Claude SDK selection / auth policy (current tip)

Pin: `45323df36` (same as local `issue/1761-agent-runtime`). No product change
in this note. Implementation of a TOS-gated subscription auth declaration is
POD-3031, which already has a live session.

## What the manifest declares

`packages/harness/src/manifests/claude-code.ts` (runtime.embedded):

- `driverId: 'claude-sdk'`
- `auth: ['api-key', 'bedrock', 'vertex']`
- Comment: subscription OAuth is **deliberately absent**; subscription is the
  terminal family.

Hermetic pins of that policy:

- `packages/agent-runtime/src/testing/manifest-axis.test.ts`
  `keeps Claude-on-subscription on the terminal driver` — `select({ auth:
  'subscription', available: ['claude-pty', 'claude-sdk'] })` → `claude-pty`
- same file: `embedded.value.auth` must not contain `'subscription'`

## What the production resolver actually does

`apps/daemon/src/runtime/registry.ts` `resolveRuntimeDriver`:

1. Default / no `runtimeContract` / machine `PODIUM_RUNTIME_DRIVER=claude-sdk`:
   **always `claude-pty`**. The machine default is ignored for Claude.
   Test: `claude-sdk-selection.test.ts` “keeps the interactive PTY default even
   when the SDK is admitted”.
2. `requested === 'claude-sdk'` (per-spawn `runtimeContract`) **and**
   `claude-sdk` is in `available` (only when `PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1`):
   returns `{ ok: true, driverId: 'claude-sdk' }` **without reading
   `embedded.auth`**. Subscription vs api-key is not an enforcement at this
   gate.
3. Same request without TOS: refused, reason names `PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1`.
4. TOS value must be exact `'1'` (`'true'` is not accepted).

So: the declared auth list keeps **policy-default** Claude-on-subscription on
the PTY. The TOS + per-spawn opt-in **already selects** the persistent
RuntimeDriver even when the live account is subscription OAuth. The live
POD-3028 drive observed that: `driverId=claude-sdk` was published.

## Applicability of a subscription spend-limit window

| Question | Answer at this pin |
| --- | --- |
| Can default Claude use persistent SDK? | No. PTY remains the default. |
| Does TOS=1 alone move Claude to SDK? | No. Per-spawn `runtimeContract: 'claude-sdk'` is required. |
| Does the resolver reject subscription auth on that opt-in path? | **No.** Auth list is not consulted. |
| Can a named-instance no-copy drive reach provider quota on either path? | **No.** Product `HOME` is the instance agent-home; without a credential there both paths were `condition=logged-out`. Copying is forbidden. |
| Is persistent SDK quota-testable with the current subscription window? | **Blocked as a quota measurement** (empty instance home / no copy). **Not blocked by the resolver** once TOS+per-spawn are set. |
| Compliant API-key/Bedrock/Vertex account supplied? | None on this drive. |

## Docs / policy still saying subscription SDK is prohibited

For a docs worker (do not edit from this issue):

- `packages/harness/src/manifests/claude-code.ts` (source comment; code owner is POD-3031)
- `packages/agent-runtime/src/testing/manifest-axis.test.ts` (test comment + assertion)
- `docs/SPEC.md` §1 / side-channels: native PTY subscription vs metered Agent SDK
- `docs/plans/pod-1761-release-milestones.md` ground rule 1: “Claude stays on its terminal path permanently (that is the only way to use a Claude subscription)”
- `docs/architecture/pod-1761-spec-gap-audit.md` LD8: embedded family selected for API-key/Bedrock/Vertex only
- `docs/evidence/pod-1761/spec-implementation-audit.md` embedded-family row
- `docs/cloud/multitenant-cloudflare-architecture.md` ToS note on Claude Pro/Max OAuth on cloud hardware
- `docs/internal/SPEC-ADDON-2026-06-12.md` `claude -p` bills pay-per-use even on a subscription

Operator ToS research now permits subscription OAuth inside the Agent SDK.
Those documents are stale relative to that ruling; POD-3031 is the code lane.
