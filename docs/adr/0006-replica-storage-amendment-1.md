# ADR 6 Amendment 1 — Personal row completeness

- **Status:** Accepted for the frontend state-store pilot (POD-5403)
- **Date:** 2026-10-03
- **Amends:** [ADR 6](0006-replica-storage.md) D3 and D4; follows [ADR 2](0002-sync-protocol.md) D10
- **Consumers:** Replica kernel, cache adapters, client facade, adapter conformance

## Context

Personal read-state rows are sparse. A missing row means “no read cursor” only after
this principal's slice is complete. Today a warm cache restores rows and its cursor
without restoring that knowledge. The first successful resume therefore changes
missing session read cursors from loading to missing after paint, flips unread marks,
and sends a second delivery through the session pool.

## Decisions

### D7 — Completeness belongs to the cache's cursor

`ReplicaCacheStore` gains `readPersonalRowsCompleteAt(): Cursor | null`.
A non-null marker certifies that the installed personal rows are complete at that
exact `(feedId, epoch, seq)`. It belongs to the same principal partition as the rows
and cursor. Adapters first validate the scope fingerprint defined in D10.
Consumers trust it only when the whole triple equals `readCursor()`;
an absent, malformed or mismatched marker means unknown completeness.

`CacheMutation` gains optional `personalRowsCompleteAt: Cursor | null`. A non-null
value must equal the cursor supplied in that same mutation; adapters reject a claim
without that cursor or with a different triple. There is no independent marker setter.
A mutation changing rows or cursor without certification clears completeness. An
explicit null clears the marker while allowing the previous rows and cursor to remain
visible during recovery.

### D8 — One atomic commit, with data and cursor

The marker is staged, published and persisted in the SAME atomic batch as the cursor
and data it describes, including buffered bootstrap deltas and span-enrolled writes.
It is never ahead of them. Abort, crash and quota failure preserve a whole pre-state
or post-state, never a marker advertising rows or a cursor that did not commit
(ADR 2 D10; ADR 6 D4.1). Degraded memory follows the same atomic contract and existing
explicit durability reporting.

A complete bootstrap installs its final cursor, rows and marker together. Certified
deltas preserve completeness by explicitly certifying their resulting cursor. An old
cache acquires its first marker only when a resume finishes successfully, by committing
the installed cursor and marker together after every range frame has committed. An
interrupted or rejected range must not upgrade an old cache's completeness.

### D9 — Recovery and principal boundaries

Every rebootstrap rung clears the marker through ONE path, `Replica.rebootstrap`,
after any older in-flight frame commit settles and before the new walk begins. An
older span must not restore certification behind that invalidation. This includes compaction, resync-required, rescope,
malformed input, epoch changes, corruption and schema changes. Ordinary recovery keeps
the previous slice visible; clearing completeness does not delete authored outbox work.
`discardCache()` clears rows, cursor and marker together and cannot reach the outbox.

Markers never cross principal partitions. Switching principal uses that principal's
own cache; it never copies the previous principal's marker. Erasing a principal also
erases its marker. A new principal without its own certified cache starts unknown.

### D10 — Additive compatibility, without a boot migration

Durable adapters use an optional metadata key in their existing metadata store/table,
plus an additive `scopeFingerprint` field in the cursor metadata value.
This amendment requires NO IndexedDB version bump, SQLite schema bump, migration or
boot refusal. A cache written by today's dev/mw, with no key, opens normally and keeps
today's behavior: present personal rows are usable immediately, absent rows become
authoritative at the first live posture. Its next successful resume certifies later
warm starts.

A downgrade can rebootstrap or rescope and later upgrade again. Cursor equality alone
is NOT sufficient: ADR 2 Amendment 1 D13.1 gives all principals the same feed identity,
and D14.4 does not rotate the epoch on rescope. A replacement bootstrap may therefore
install the same `(feedId, epoch, seq)` as the previous slice. Today's replica install
constructs a fresh triple from the bootstrap head; both old durable adapters replace
the cursor metadata value with it, without merging unknown fields. They can leave the
unknown completeness key behind, but they drop any fingerprint in the cursor row.
Old `discardCache()` also removes the cursor row even if it leaves the unknown key.

Each complete snapshot receives a fresh, adapter-local scope fingerprint. Its cursor
metadata and completeness marker carry the SAME fingerprint in the SAME atomic batch
with the rows. Certified deltas retain it; clearing completeness and later certifying
a slice creates a new fingerprint. `readPersonalRowsCompleteAt()` returns a triple only
when both stored triples AND their nonempty fingerprints match. A missing, malformed
or mismatched fingerprint means unknown, never a boot refusal. The fingerprint is private
cache metadata, not a wire cursor or a second authorization surface. After an old
snapshot install, the surviving marker is therefore untrusted even at an identical
cursor. The memory-adapter downgrade regression pins that exact equality case, including
old discard followed by reinstall; durable probes replace the cursor row directly and
reopen independently.

### D11 — Attach-time values and proof

The client facade reads completeness before pool attach. A certified warm cache
therefore yields the final read cursor and unread value on the first delivery; reaching
live does not issue a second delivery solely to declare sparse rows complete. The
values once live remain identical to the previous implementation, including sessions
with explicit personal rows and those without them. Legacy caches retain their existing
first-live fallback.

Acceptance requires the same conformance assertions on memory, IndexedDB and mobile
SQLite: staged visibility, commit/abort, final buffered snapshot cursor, recovery rungs,
discard and principal isolation, plus legacy-cache behavior. Durable crash probes reopen
storage independently. A planted fault that certifies an incomplete personal slice must
fail the parity assertions; a marker alone is not evidence that its rows are complete.
Production phone warm-start evidence at 5,200 sessions must show the extra delivery gone,
paired with a web startup check. Only focused validation is required.
