# Can claude be driven without rotating the operator's token?

*Investigated 2026-08-26 17:36–17:45 CEST for POD-1761. **Read-only** — nothing
was spawned, no token was used, no credential file was written. Token values are
never printed here; comparisons are SHA-256 prefixes.*

**Short answer: yes, inside a checkable window, and the danger is narrower and
better-defined than the ledger's warning implies. But the agent homes are
currently seeded with a *superseded* refresh token, and that is the state to fix
before driving.**

---

## 1. How did POD-2874 authenticate claude?

**They didn't seed anything.** `docs/evidence/pod-2874/drive-daemon.sh` copies no
credential — zero matches for `cp`, `credentials`, `auth.json`. It deliberately
leaves `HOME` and every derived path alone.

But their `drive.ts:660` *expects* one — `throw new Error('expected seeded
credential at ' + credentials)` — and their agent home has one. Its hashes are
**identical to mine**:

| copy | accessToken | refreshToken | expiresAt |
|---|---|---|---|
| operator live | `e3c0c6873037` | `6bde26d7bb35` | 23:47:42 today |
| p2777 agent-home | `ceef7c5053c7` | `e4daad8ee9ac` | **15:52:40 — expired** |
| p2874 agent-home | `ceef7c5053c7` | `e4daad8ee9ac` | **15:52:40 — expired** |

Same bytes in both rigs, so both are copies of the operator's credential taken
*before* it rotated. Their A8 reading — `Not logged in — Run /login` — is what
claude does when it cannot authenticate with what it finds.

## 2. Does using an unexpired token trigger a refresh?

**No. Refresh happens only when the access token is already expired**, and it is
the **claude binary** that does it, never Podium.

`apps/daemon/src/quota-claude.ts` is the only place Podium reads the token, and
it is careful:

```ts
if (typeof expiresAt === 'number' && expiresAt <= now) {
  return { ...withAcct, status: 'expired', error: 'token expired (refreshes on next Claude use)' }
}
```

It **returns before making any network call** when the token is expired. When the
token *is* valid it makes one read-only `GET` to the usage endpoint with
`Bearer ${token}` — and on a `401` it returns `status: 'expired'` rather than
attempting a refresh. The product's own comment names the actor: *"refreshes on
next Claude use"*.

So there is a genuine safe window: **while `expiresAt > now`, nothing refreshes.**

## 3. Is there a read-only way to confirm validity?

Yes, and the product already uses it: read `claudeAiOauth.expiresAt` from the
credential file and compare to now. Pure file read — no network, nothing
consumed. That is how every number in this document was obtained.

## 4. What exactly would rotate it?

**Running the claude binary against a home whose access token has expired.** Not
a spawn per se, not a turn per se — the expiry is the trigger. Podium never
rotates: it reads, and at most performs one read-only GET with an unexpired
token.

---

## The state that actually matters, and it is not the one the ledger warns about

Both agent homes hold **an expired access token AND a refresh token that has
already been superseded** — the operator's rotated at 15:47 to
`6bde26d7bb35`, while the homes still hold `e4daad8ee9ac`.

Spawning claude there would attempt a refresh using a superseded refresh token.
Under the OAuth 2.0 security BCP, presenting an already-rotated refresh token is
treated as replay and *may* revoke the whole token family — which is the
mechanism by which the operator could be logged out.

**Empirically, that did not happen here.** POD-2874 drove claude cells at
**17:13–17:16**, after both the agent-home token expired (15:52) and the
operator's rotated (15:47). Right now:

- the operator's credential is **valid until 23:47:42**, and
- the coordinator session **is claude** and is still sending mail — a live control.

So at least one claude spawn against a superseded refresh token did **not** revoke
the operator's family. That is one observation, not a guarantee, and it is
consistent with claude simply reporting `Not logged in` — which is exactly what
POD-2874 recorded.

## Recommendation

**Do not drive claude with the agent homes as they stand.** Not because a refresh
is certain to be destructive, but because it is the one case that cannot be
undone if it is, and its outcome is unknown.

Two safe paths, in order of preference:

1. **Drive logged-out, deliberately.** Accept `Not logged in` and score only the
   cells that do not need inference — session lifecycle, terminal attach, view
   switching, kill, driver identity. This is effectively what POD-2874 did, and
   it needs no credential at all. Cells needing a turn are then honestly BLOCKED
   on "no credential", which is a rig limitation and should be recorded as one.
2. **Re-copy the operator's *current* credential and drive only inside its
   window** — today that is until **23:47:42**, checkable by reading `expiresAt`
   before each run. While unexpired the binary uses it as-is and does not
   refresh. This must be treated as a hard deadline, not a guideline: past it,
   the next claude use *will* refresh, and both holders then race.

Path 2 buys the inference-dependent cells, at the cost of a deadline someone has
to respect. **The operator should be the one to choose it**, since it is their
session at stake — this is a decision, not a measurement.
