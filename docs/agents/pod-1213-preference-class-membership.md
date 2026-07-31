# POD-1213 — `user_preferences`, classified

Companion to [`pod-1211-durable-class-membership.md`](./pod-1211-durable-class-membership.md).
POD-1211's membership gate caught this table the way it caught POD-421's — on the merge, within
minutes of the gate existing, with nothing else in the repo noticing. This file is the
adjudication it asked for.

## The finding

```
drizzle-table-undeclared  apps/server/src/migrations/schema.ts → user_preferences
```

`visibilityClassOf` answered `personal` for a class it had never heard of, so an unclassified
table and a deliberately-personal one returned the same value and every classification test stayed
green. That is POD-385's Limit, and it is why the answer below had to be argued rather than
defaulted into.

## The classification

**Row `preferences-personal-keys`, visibility `per-user-state`.** The row already existed — it is
the row POD-418 classifies the VALUES against (`SETTINGS_TIER_ROW['personal-preference']`), and it
has been `perUserState(...)` since the matrix was written. What changed at POD-1213 is that the
row acquired a physical store: its `sites` said these keys lived in "one instance-wide blob
today", a sentence the migration made false.

So the entry names a row that exists, and no row was added. The interesting part is the two
answers it is NOT.

### Not `personal`, and POD-1211's own argument is why

`personal` is **grantable**. POD-1211 rejected it for the audit trail on exactly that ground, and
the ground holds harder here: "share my sidebar order, my session defaults, my ntfy topic and my
Telegram chat id" is a verb that must not exist. `per-user-state` is non-grantable BY
CONSTRUCTION (ADR 9 D3 rule 4) — sharing an entity never shares anybody's per-user rows — and
that is a live prohibition rather than a label:

```ts
// packages/sync/src/feed/visibility.ts
if (declared === 'per-user-state') {
  // …a grant edge on a per-user-state row must not be able to widen it.
  const keyed = this.state.keyedUserOf(ref)
  if (keyed === null || keyed !== human) {
    return { visible: false, reason: 'per-user-state-not-yours' }
  }
```

`mayRead` is **not consulted** on this arm, so a grant row cannot widen it even if someone writes
one. Under `personal` the same table would be reachable through `personal-not-granted`'s inverse —
one grant edge away from another person's notification routing. This is the direction POD-1211's
brief called dangerous for the three per-user-state classes, and it is the reason the answer is not
the default one.

### Not `secret`, and this is where it INVERTS the audit trail

POD-1211 chose `secret` for `settings-audit-trail` because `visibility.ts` refuses a declared
secret with `secret-never-replicates`, and never replicating was the property that trail most
needed. Here that same property is the one thing the class must **not** have:

- A personal preference **must** replicate — to the owning user's own replicas only, which is
  precisely what the per-user-state row says (`client-to-server-to-clients`, "only to the owning
  user's own replicas: a per-user row is not another reader's row"). Declaring it `secret` would
  refuse that replication and take the settings screen offline-dead, contradicting
  `offline-eligible` and the offline-editable preference story POD-418/POD-419/POD-420 built the
  whole tier split around.
- **There IS an owner to be private TO.** That was the audit trail's disqualifier — it names an
  actor, an on-behalf-of and a setting that may be instance-scoped or another person's, three
  principals none of which owns the record of the act. A preference row has exactly one user id in
  its key, and that user is its only permitted writer. The thing that made `personal` unavailable
  there (no owner) and the thing that makes `per-user-state` available here (an owner, in the key)
  are the same axis read from opposite ends.
- Reading an audit trail is an ADMIN act (ADR 1 D15), which is the governance `secret` carries.
  Reading your own preferences is the opposite: it is what every settings screen load is.

### Not `deployment-substrate`

Substrate means TENANT-VISIBLE, and ADR 1 Amendment 1 D9.3 makes that ratchet one-way. These are
per-reader values; the instance-tier keys that genuinely are substrate stayed on the settings blob
under `preferences-instance-keys`, which is the row that already carries that classification.

## The declaration is honest, checked the way POD-1076 checked its declines

`perUserState(...)` declares `writers: ['operator']` and `systemWriter: 'never-writes'`. POD-1076
DECLINED `notification_facts` and `message_wake_cooldowns` from this family because the server
writes them as `system`, and adopting them would have been a false declaration. The same test,
applied here:

- The only runtime writers of `user_preferences` are `SettingsRepository.setSettingsFor` and
  `applyPreferencePatch`, reached from `settings.set` / `settings.updatePersonal` /
  `settings.updateInstance` — every one of them carrying a principal resolved at the transport.
- `modules/settings/trpc.ts` REFUSES a principal with no human behind it (`onBehalfOfUser` → null)
  before the handler runs, and records the refusal. So there is no path by which `system` writes a
  row here.
- The migration's backfill is not a system writer at runtime; it is frozen history, and it writes
  every row to `'user:sole'`, the one identity that authored the values it lifted.

`attribution: { actor: 'required', onBehalfOf: 'required' }` also holds: both halves are the same
user, and the trpc seam supplies them from the capability rather than from any input.

## What this does NOT decide

- **Whether a preference should ever be shareable.** The answer today is no, by construction, and
  changing it would require moving the class — which is an ADR 9 D3 question, not a per-feature
  one. Recorded so a future "share my setup with a teammate" feature is a class change somebody
  reviews rather than a grant row somebody writes.
- **Who the row's OWNER is once accounts exist.** `owner: the-user-in-the-key` is exact and needs
  nothing further; what is still placeholder is the transport that decides which user is asking
  (POD-315). Every call site that names `FIRST_ADMIN_USER_ID` today is greppable.
- POD-421's coupled condition still stands and is not weakened by this: if a reader is ever added
  to `settings_audit_events`, the per-user rows become a cross-user surface through the trail, and
  `PREFERENCE_REDACTION` must be revisited before it ships.

## Proof the gate can say NO about THIS entry

| Mutation | Reported |
|---|---|
| Remove the `user_preferences` entry (i.e. the pre-fix state) | `drizzle-table-undeclared  apps/server/src/migrations/schema.ts → user_preferences` |
| Mistype the row id (`preferences-personal-keys` → `…-keyz`) | `store-names-a-row-that-does-not-exist` — "a misspelled row id resolves `personal` through `visibilityClassOf` and passes every classification test there is" |

Clean run: `durable-class audit: clean — 88 durable stores, every one on the matrix or explained`.
