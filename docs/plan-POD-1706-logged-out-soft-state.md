# Plan — POD-1706 Logged-out harness soft state (phase A)

Parent: POD-1659 (Cross-machine harness login catalog). Design: `docs/2026-08-04-cross-machine-login-catalog.md` §6.5.

## Problem

Starting an agent on a machine whose harness has no login produces a dead-end popup: *"Couldn't start the agent — codex is not logged in on machine 'vmi3407763'"*. There is no way forward from it. Before this refusal existed, the harness simply launched and the user ran `codex login` in the pane — that fallback is what we are restoring.

Two things are wrong today: the refusal itself, and the fact that the session's own state does not reflect that its harness is logged out.

## The shape of the fix

`'logged-out'` stops being a *capability rejection* (a reason a machine cannot run an agent) and becomes a *session condition* (something true about a running session).

**Do not simply delete the arm from the switch.** Narrow the union type so the compiler walks you to every consumer.

## Files

| File | What changes |
|---|---|
| `packages/model/src/predicates/machine-selection.ts:145-190` | `AgentCapabilityRejection` union loses `'logged-out'`; `agentCapabilityRejection()` no longer returns it. The doc comment at :145-151 describing the reasons must be updated too. |
| `apps/server/src/modules/machines/service.ts:375-400` | `requireAgent`'s exhaustive `switch` loses its `'logged-out'` arm. The `never` default is load-bearing — a rejection nobody handled used to fail OPEN and route work to a machine that had just refused it. Keep that property. |
| `apps/server/src/modules/machines/service.ts:330-370` | **See the subtlety below.** |
| `apps/web/src/app/NewPanelMenu.tsx:550` | Was rendering the refusal message; now renders a startable-with-warning affordance. |
| `apps/web/src/lib/SessionContextMenu.tsx:114` | Same. |
| session model / condition | Session carries a login condition so the UI can show "harness not logged in". |

## The subtlety that must not be missed

`resolveMachineForAgent` (`service.ts:330-370`) uses the **same predicate** for IMPLICIT machine selection — picking a machine when the user did not name one. Refusing a logged-out machine there is still correct: an implicit pick must not offer a machine the work cannot run on. The existing comment at :341-345 explains this ("IMPLICIT placement is a surface too… an implicit pick offers one without asking").

So the two call sites must diverge:

- **Implicit selection** — still skips logged-out machines when choosing among candidates.
- **Explicit pin** (`requireAgent` on a machine the user named) — no longer throws; the session starts.

Concretely: keep a predicate that reports logged-out for *ranking* purposes, and remove it only from the *refusal* path. Do not collapse them into one function that does both.

## Session state

The session must honestly report that its harness has no login. Reuse the existing login detection (`detectLogin` via machine inventory) rather than probing separately — the daemon already ships it. The condition should be observable by the UI so it can offer:

1. "Log in here" — the pane is open; the user runs `codex login`.
2. A placeholder for "use the login from `<machine>`", which POD-1708 will make real. Do not build the donor lookup here; leave the affordance absent rather than dead.

## Tests

Per `CLAUDE.md`, match effort to risk. This changes runtime behaviour at a refusal boundary, so it warrants focused coverage:

- Predicate unit test: a logged-out harness no longer yields a capability rejection; `offline`, `harness-missing`, `unauthorized` still do.
- `requireAgent`: a logged-out machine does not throw; an offline one still does.
- `resolveMachineForAgent`: an implicit pick still skips a logged-out machine when a logged-in candidate exists.
- Spawn-level: pinning a logged-out machine yields a session rather than an error.

Extend the existing tables in `packages/model/src/predicates/machine-selection.test.ts` and `apps/server/src/modules/machines/service.test.ts:190` (which currently asserts the `"codex is not logged in on machine 'Builder'"` message — that assertion changes).

Run `bun run typecheck` (trust a cache hit; never force) and `bun run test`.

## Definition of done

- Pinning a logged-out machine opens a session instead of erroring.
- The session's state shows the harness is logged out.
- Implicit machine selection still avoids logged-out machines.
- No `'logged-out'` string remains as a capability-refusal path.
- Typecheck and tests green.

## Out of scope

The catalog (POD-1707) and propagation (POD-1708). Do not add identity extraction, cross-machine lookups, or credential handling here.
