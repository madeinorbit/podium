/**
 * CAPTURE a real legacy replica store, so POD-377's migration is tested against
 * bytes the shipping writer produced rather than bytes its own test invented.
 *
 * POD-377's acceptance criterion says the migration is "tested from a CAPTURED REAL
 * replica snapshot, not a synthetic one", and the reason is the defect this run has
 * hit repeatedly: a decoder tested only against fixtures it also authored certifies
 * its own guess about the format (POD-306's three conformance gates certifying their
 * own fixture; POD-374's "an importer built against a guessed key set is
 * mechanism-present / coverage-absent"). `readLegacyReplica` decodes TanStack DB's
 * `localStorageCollectionOptions` blob shape. Nothing in `packages/sync` can produce
 * that shape — only TanStack DB can — so the only honest fixture is one TanStack DB
 * wrote.
 *
 * WHAT "REAL" MEANS HERE, precisely, because it is a weaker claim than "taken off a
 * user's phone" and should not be read as that: the bytes are produced by the REAL
 * writer — `createReplica` from `packages/client-core`, the TanStack-backed replica
 * that is still the shipping web and mobile path — driven through the same public
 * calls the app makes. The FORMAT is therefore real, including the parts nobody
 * hand-writes correctly: TanStack's per-row `{versionKey, data}` envelope, its key
 * encoding, and the separate homes the outbox and its awaiting-truth stage occupy.
 * The DATA is representative rather than harvested, because a genuine device
 * capture would carry another person's session titles and message text into the
 * repository forever.
 *
 * THE SNAPSHOT DELIBERATELY CONTAINS QUEUED ENTRIES, in all three of their homes,
 * because that is the family POD-377's outbox decision is about and a capture
 * without them would test the migration's easy half. It also contains an
 * awaiting-truth entry (which must import as `accepted`, not `queued` — re-sending
 * an accepted mutation is the bug that distinction exists to prevent) and a
 * ui-state blob (which must be LEFT BEHIND, not swept up with the replica keys).
 *
 * Run: `bun scripts/capture-legacy-replica-snapshot.ts`
 * The fixture is checked in; `packages/client-core/src/replica/legacy-snapshot.test.ts`
 * fails when the writer drifts away from it, which is what stops the capture from
 * quietly becoming historical fiction.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureLegacyReplicaSnapshot } from '../packages/client-core/src/replica/legacy-snapshot'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(
  HERE,
  '..',
  'packages',
  'sync',
  'src',
  'adapters',
  'legacy-replica',
  '__fixtures__',
  'captured-legacy-replica.json',
)

const snapshot = await captureLegacyReplicaSnapshot()
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`)
console.log(`captured ${Object.keys(snapshot).length} keys -> ${OUT}`)
