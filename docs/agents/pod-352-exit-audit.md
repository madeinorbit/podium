# POD-352 exit audit — secrets/preferences split

Closed out by **POD-421** (3.7d), the last of #352's four children. Every item is
answered against a named artifact from the sibling that produced it, cited rather
than re-derived, per POD-352's instruction that POD-418/419/420's evidence is
"worth citing rather than re-deriving".

Two items do **not** land at zero, and they are recorded as gaps with owners
rather than reported as passes. Both are stated in full below. An exit audit that
rounded them to zero would be the failure this programme exists to end.

---

## 1. No secret material in any wire projection, replica store, outbox entry, dead-lettered payload, audit record, event log or error body

**ZERO — and the last three clauses were POD-421's, because nothing held them.**

| Surface | Held by | Evidence |
|---|---|---|
| wire projection | POD-418 | `SecretPresenceWire` is built **independently** of `ServerSecret` rather than as `omit({value})`, so no projection has a value key to forget to strip. `packages/model/src/settings/secrets.ts`; proved structurally and by a key-NAME detector in `secrets.test.ts`, each with a planted-leak case. |
| replica store, outbox (incl. terminal + dead-lettered) | POD-419 | The scrub runs at **every store open**, over every region and every outbox state. `packages/model/src/settings/scrub.ts`, `packages/sync/src/adapters/secret-scrub.ts`. Mutant D (scrub only `state === 'queued'`) killed by *removes material from EVERY region and EVERY outbox state* (3 ≠ 5). |
| server storage | POD-419 | Migration `20260730224810_server-secret-store` lifts the five keys out of `meta['settings']` into `server_secrets` and `json_remove`s them from the blob. 12 cases against a captured real pre-migration database, mutation-verified twice. |
| **audit record** | **POD-421** | `store/settings-audit.ts` + `modules/settings/audit.ts`. The detail is redacted through the contract's own `redaction` metadata before it reaches the repository, and `append` takes a `RedactionReport` rather than a bare payload — there is no parameter for an unredacted one. `wiring.test.ts` asserts against the row read back **out of SQLite**, not against the object handed in. |
| **event log** | **POD-421** | Same reader. `redactForLog` is applied on both the applied and refused paths. |
| **error body** | **POD-421** | Two halves, stated apart because a path list structurally cannot cover the second: the structured payload (`redactForLog`) and the message STRING (`messageMentionsRedactedValue`, applied to the trail by `recordSettingsCommand` and to the wire by `redactErrorMessage`). Both fail closed for an unknown command. |

**Runtime, not just unit:** `tests/e2e/browser/settings-surfaces.browser.e2e.ts`
plants real material through the contracted command and asserts it appears in
neither the rendered document nor **any** `/trpc` response body the page
receives, with the captured-body list asserted non-empty first.

`settings.experimental` is whitelisted as intentionally-replicated preference
data (POD-419), so the audit does not false-positive on it.

**Mutation evidence (POD-421):** bypassing the redactor in `audit.ts` — 5 tests
killed it across two files. Neither the "value gone" assertion alone nor the
"redactedPaths named" assertion alone would have been sufficient; both were
required, which is why both are asserted.

---

## 2. No settings field without a declared visibility class, and an unclassified field resolves to per-user private, not tenant-visible — **both directions demonstrated**

**ZERO (POD-418).**

`SETTINGS_CLASSIFICATION` is **derived by walking the split shapes**, not a hand
list — a field added to a shape cannot simply be absent from a list while the
default-closed backstop answers for it. 39 leaves: 24 personal / 10 instance /
5 secret.

Both directions, by three instruments that fail differently:

1. **Derivation** (`classification.ts`), with `classification.test.ts` pinning
   known deep paths and a negative control — an empty walker classifies nothing
   and every "no secret leaked" claim then passes vacuously.
2. **Reconciliation** (`packages/runtime/src/settings.classification.test.ts`) —
   the leaves of the LIVE blob and the classified paths are the same set in both
   directions. This is the instrument that can see a field added to the blob and
   to no tier.
3. **Backstop** — `classifySettingsPath` returns `undefined` for an unknown path
   (so "unclassified" stays distinguishable from "deliberately personal") while
   `settingsPathMayReplicate` / `settingsPathMayEnqueue` answer `false`. The
   honest "I don't know" and the safe answer are deliberately different
   functions.

**POD-421 added a fourth direction, at the screen:**
`apps/web/src/features/settings/surfaces.test.ts` requires every classified leaf
to be reachable from a declared tab **or** named in `NOT_ON_THIS_SCREEN` with a
reason, and nothing to be on both. Five leaves are genuinely on no settings tab
(sidebar sort/order/grouping, `autoContinue.promptDismissed`, `steward.enabled`),
so that list is populated rather than decorative.

---

## 3. No contract without a declared exposure, offline class, role gate and redaction metadata

**ZERO for the declarations (POD-420) — and as of POD-421 two of the four are
actually READ.**

`classificationErrors` enforces the declarations at L1 and again over the joined
registry table, so a gate cannot pass at L1 and be absent where the handlers
live. Seven contracts (POD-420's six plus POD-421's `settings.secretPresence`).

**The finding this audit must record rather than bury**, because it is the
defect class of the whole run arriving in the audit's own subject matter:

> A totality test proves every field is CLASSIFIED and proves nothing about
> whether anything READS the classification. Two of these four fields were
> declared, internally consistent, reviewable, green — and had no consumer.
> `roleFloor` was compared against nothing (POD-420 said so in as many words at
> the `settings.setSecret` rationale: *"Nothing enforces the floor today"*), and
> `redaction` was read by nothing.

POD-421 shipped both consumers:

- **`roleFloor`** → `apps/server/src/modules/settings/authz.ts`, derived so an
  eighth command is gated by whatever its contract declares. `authz.test.ts`
  asserts **both arms for every contract in the shipped table** — an admin
  passes AND a member is refused wherever the floor is `admin` — which is the
  instrument POD-352 asked for. Mutation-verified: deleting the gate call from
  the real router is killed 5 ways in `wiring.test.ts`.
- **`redaction`** → `packages/commands/src/redaction.ts`, item 1 above.

`exposure` was already read (the derived router's both-directions check).
`delivery.class` is read by `planSettingsWrite` and `ONLINE_ONLY_SETTINGS_COMMANDS`.

---

## 4. No serialized effective-capability snapshot on any settings contract, outbox entry or representation

**ZERO.**

`settingsAuthzDeps` reads the account role **live** at every call
(`users.roleOf`) and stores it nowhere. ADR 9 D5 A1's live resolution is
satisfied by there being nothing to serialize.

The one thing that could have become a snapshot is POD-421's `settings.viewer`,
which tells the client which commands it may attempt so a control can be
disabled-with-reason instead of editable-then-refused. It is a **rendering hint
with no authority**: recomputed per request, never stored, never enqueued, never
attached to a contract or an outbox entry, and the server re-runs the identical
gate at apply time regardless of what the client believed (ADR 3 D8).
`authz.test.ts` asserts it agrees with the gate for every command and both roles,
so the two cannot drift — one rule, not two.

---

## 5. No cross-user leakage: a second user's per-user preference rows never reach the first user's replica or UI

**NOT AT ZERO. RECORDED AS AN OPEN GAP, owner POD-1213 (Per-user preference
storage).**

POD-352 raised this directly and instructed: *"Do not audit around this and do
not build it yourself."* POD-421's brief permits exactly this form — *"or the
dependency … is recorded as an open gap rather than waved through"* — so this is
the permitted arm, not a waiver.

**The cause is nearer than the brief assumed.** The brief framed it as depending
on Phase 2's watermarked scoped feed (POD-1077). The actual cause is simpler: the
per-user preference **storage move was never shipped by anyone**.
`PersonalPreferences` exists as a model shape keyed `(userId)` from POD-418, but
the values still sit in the one instance-wide `meta['settings']` blob served
whole to every authenticated client. One user's session defaults, sidebar order,
`autoContinue` dismissal, ntfy topic and `telegramChatId` are readable by every
other user today.

**What POD-421 did about it, given it may not fix it:**

- **The product does not claim otherwise.** The brief asked for copy on the
  preferences surface saying that editing it affects nobody else. That sentence
  is false on this build, so it is not rendered. The surface states the declared
  class **and** what is true today, naming POD-1213 — and a test pins the caveat
  so it cannot be tidied away by someone who reads the per-user class name and
  assumes the storage followed. POD-352 backed this explicitly.
- **The audit trail does not widen it.** `settings_audit_events` is server-only
  and projected into nothing — no wire shape, no replica, no UI — the same
  standing `workflow_events` has. A preference value recorded there reaches no
  other user's replica because it reaches no replica at all. `store/settings-audit.ts`
  records that a future reader would change this and must be gated first.

---

## 6. No `instance_id` anywhere in the settings family

**ZERO.** ADR 1 D5 stands: multi-user lives *inside* one instance, and the
readiness doc restates it precisely so nobody confuses multi-user with
multi-tenant and starts adding columns.

```
$ grep -rn "instance_id\|instanceId" packages/model/src/settings packages/commands/src/settings \
      apps/server/src/modules/settings apps/server/src/store/settings-audit.ts \
      apps/web/src/features/settings
(no matches)
```

The table POD-421 added (`settings_audit_events`) carries no such column, which
is the direction the item exists to police — a new table is where one would most
plausibly appear.

---

## 7. The per-user-versus-instance boundary is recorded IDENTICALLY in this family and in POD-1076, and no settings field reached the per-user state family by two migrations

**ZERO — re-aimed, because the item as written was checking the wrong boundary.**

POD-352's correction, recorded here because the original phrasing would have
passed vacuously:

> The item says to verify that "POD-1076's Phase-1 fan-out and POD-419's residue
> migration are disjoint". They are, but that is not where the risk was. POD-352's
> brief assumed POD-1076 would ship the preference-key migration; **POD-1076
> landed the opposite** and recorded it in
> `packages/model/src/user-state/family.ts`, where `personalPreferenceKeys` sits
> in `PER_USER_STATE_NON_MEMBERS` reasoning that the settings surface is
> POD-352's.

So the recorded agreement is `PER_USER_STATE_NON_MEMBERS`, and it is recorded on
both sides: POD-352 has adopted it, and POD-418's classification is the settings
family's half. The real double-migration question is **POD-1213 vs POD-380 vs
POD-1076**, and today it is not a double-migration risk at all —

**the failure mode here showed up in its other direction: not two migrations for
one field, but ZERO.** That is item 5. An audit item phrased only against
double-migration would have reported this clean.

---

## Still open, handed forward — answering either here would be an audit failure

Both are recorded as deferred on POD-352, verbatim, and neither is answered by
anything POD-421 shipped.

**O1 — May a non-admin see secret presence and fingerprint?**
The existence-leak class of readiness §3.1.2 (*"Decide per surface whether
existence is private or only content is"*). **Absent a recorded human decision,
POD-421 fails closed: presence and fingerprint are admin-grade.** Shipping the
closed default is explicitly **not** the decision — it is the safe placeholder,
it is the only direction that can be revised later without having already
leaked, and the opposite default cannot be un-leaked. The fail-closed behaviour
is real and verified at runtime for a member principal (§3.1.5's consistent-error
rule: the refusal is `NOT_FOUND` with the same string an absent surface produces,
and the screen has exactly one unavailable state with no reason attached).

**O2 — Does server-injected managed-credential usage bill the delegating human
rather than the machine owner?**
Readiness §3.1.4 M2. Untouched. POD-418 already refused to answer it by accident
when it declined to fold `accounts.credential` into the settings secret store
(`NOT_A_SETTINGS_SECRET`), and POD-421 preserves that: managed credentials are a
different matrix row with a different id-minting story and are not on the secrets
surface.

---

## Summary

| # | Item | Verdict |
|---|---|---|
| 1 | No secret material anywhere, incl. audit/event/error | **zero** |
| 2 | Every settings field classified, both directions | **zero** |
| 3 | Every contract declares exposure/offline/role/redaction | **zero**, and two of the four now have consumers |
| 4 | No serialized effective-capability snapshot | **zero** |
| 5 | No cross-user preference leakage | **OPEN — POD-1213** |
| 6 | No `instance_id` in the settings family | **zero** |
| 7 | Per-user/instance boundary recorded on both sides | **zero**, item re-aimed |
| O1 | Non-admin secret presence | **open**, failed closed |
| O2 | Managed-credential billing | **open**, untouched |
