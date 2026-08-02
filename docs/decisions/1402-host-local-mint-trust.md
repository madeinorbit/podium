# POD-1402 — Host-local mint trust (ACCEPT)

**Status:** Decided 2026-08-02  
**Decision:** ACCEPT under single-operator Podium  
**Reopen:** POD-1067 (multi-user) — instrument in `HOST_LOCAL_MINT_TRUST` + tripwire tests  
**ADR:** [ADR 3 D14](../adr/0003-command-security.md)

## Fact (executed, not inferred)

From a constrained agent shell on the live instance (session with
`PODIUM_AGENT_RELAY=http://127.0.0.1:45778/session/…`, same OS user as the
operator):

| Step | Command / path | Result |
|---|---|---|
| Identity | `PODIUM_AGENT_RELAY`, `PODIUM_SESSION_RELAY` set; `PODIUM_SESSION_TOKEN` unset | Agent relay principal |
| Files readable | `/home/mgw/.podium/podium.db` (rw), `auth.json` (r; keys: `passwordHash` only) | Same as operator OS user |
| Operator-only over relay | `podium issue promote POD-1113 --outside-scope` | `only an operator may promote a proposed issue` (exit 1) |
| Operator-only over relay | `podium issue delete …` | `not allowed to 'delete' issues` |
| Mint | `podium auth mint-session --ttl 2m --print-only` | 43-char token; stderr expiry 2m out |
| Mint files (strace) | `~/.podium/config.json`, `instance.json`, `podium.db` (+wal/shm) **RDWR** | Does **not** open `auth.json` |
| After mint | `PODIUM_SESSION_TOKEN=$TOKEN env -u PODIUM_AGENT_RELAY -u PODIUM_SESSION_RELAY podium issue promote POD-1113 --outside-scope` | `issue is not proposed` — **operator** answer |
| After mint | same env, `podium issue delete` / `restore` | Allowed (operator capability) |

The scope gate is bypassed, not defeated: the caller presents a different
principal. Trust root = write access to `$PODIUM_STATE_DIR/podium.db`.

## Decision

**ACCEPT.** Agent/operator relay scope is accident prevention and product
ergonomics on the default path. It is not adversarial containment of a process
that already shares the operator's OS user and state dir.

ENFORCE options rejected for single-operator:

- Refuse when relay env is set — bypassable (`env -u`); contradicts POD-1375.
- Require instance password — agent still has DB write (can INSERT the row).
- Interactive TTY — same class; breaks non-interactive operator scripts.

## Shape

Not POD-1315 (require a missing principal) — there is no missing field to
require under single-operator.  
Not POD-1410/1412 alone (coverage of an existing guard) — there is no security
guard to cover; the honest product is the decision.  
**This issue:** recorded ACCEPT + **instrument that fails when multi-user
arrives without rebinding mint.**

## Instrument

| Piece | Location |
|---|---|
| Decision object | `HOST_LOCAL_MINT_TRUST` in `packages/runtime/src/session-mint.ts` |
| Coherence + schema tripwire | `packages/runtime/src/session-mint.test.ts` (schema read via relative path) |
| ADR | ADR 3 D14 |
| CLI help | `podium auth` usage |

Multi-user must, in one change: set `assumesSingleOperator: false`, set
`mintBoundToIdentity: true`, and actually bind mint to an identity.

## Mutant verification (tripwire)

| Mutant | Measured | Exit |
|---|---|---|
| `assumesSingleOperator: false` while `mintBoundToIdentity: false` | 2 failed: coherence + schema branch require `mintBoundToIdentity=true` | 1 |
| Forbidden list includes existing column `label` | 1 failed: `expected … not to include 'label'` with measured column list | 1 |
| Schema gains `userId: text('user_id')` on `client_sessions` | 1 failed: `gained 'userId' while assumesSingleOperator=true` | 1 |
| Delete exact column-set pin only | Still 15/15 green under single-op — **did not fire**; forbidden-list + coherence cover the multi-user flip | 0 |
| Delete coherence if/else body only | Still 15/15 green while flags stay single-op — **did not fire until flag flips** (mutant 1 proves the branch) | 0 |

Anchors restored; final run 15/15 exit 0.
