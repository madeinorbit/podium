/**
 * THE PHASE-2 CLIENT AUDIT, PROBED (POD-378).
 *
 * `docs/agents/rewrite-fanout-ledger.md` records this run's recurring defect
 * class: an instrument whose refusing arm the environment can never produce. An
 * audit that reports "ZERO, ZERO, ZERO" is indistinguishable from four detectors
 * that match nothing at all, and the second is easier to write by accident.
 *
 * So every detector is driven against a SYNTHETIC violation of its own item and
 * must fire, and — where the item has a near-miss that must NOT be flagged — the
 * near miss is pinned too. The near misses are the half that stops the audit from
 * being "fixed" by deleting the comments that record why the fix happened.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clientVisibilityFilter,
  discoverCompositionRoots,
  perUserStateLocalHome,
  REPO_ROOT,
  readClientLines,
  runPhase2ClientAudit,
  type SourceLine,
  unattributedStoreRead,
  worldAssumption,
} from './audit-phase2-client'

/** Source lines as the detectors take them, from literal text. */
function lines(file: string, body: string): SourceLine[] {
  return body.split('\n').map((text, index) => ({ file, line: index + 1, text }))
}

describe('phase-2 client audit — every detector can say NO', () => {
  it('world-assumption fires on the affirmative claim', () => {
    const found = worldAssumption(
      lines('apps/web/src/x.ts', '// safe to count here: the client holds the world'),
    )
    expect(found).toHaveLength(1)
  })

  it('world-assumption does NOT fire on the sentence recording the amendment', () => {
    // THE NEAR MISS THAT MATTERS. `engine/overlay.ts` genuinely contains these
    // words, negated. A detector that flagged it would be silenced by deleting
    // the explanation — the fix that makes the codebase worse and the audit green.
    const found = worldAssumption(
      lines(
        'packages/client-core/src/engine/overlay.ts',
        [
          '// A replica no longer holds the world, only its principal’s slice',
          '// The client never holds the world under scoping.',
          '// D7.3 rejected an IVM engine because the client does not hold the world any more.',
        ].join('\n'),
      ),
    )
    expect(found).toEqual([])
  })

  it('client-visibility-filter fires on an entity filter keyed on visibility', () => {
    const found = clientVisibilityFilter(
      lines('apps/web/src/x.ts', 'const mine = sessions.filter((s) => s.visibility !== "private")'),
    )
    expect(found).toHaveLength(1)
  })

  it('client-visibility-filter fires on the OWNERSHIP spelling too', () => {
    // One concept, two spellings. A detector that knew only `visibility` would
    // certify every `ownerId` filter in the codebase forever.
    const found = clientVisibilityFilter(
      lines('apps/web/src/x.ts', 'const mine = issueRows.filter((i) => i.ownerId === me)'),
    )
    expect(found).toHaveLength(1)
  })

  it('client-visibility-filter does NOT fire on layout filtering', () => {
    // `RightRail.tsx`'s real line. Which PANEL to render is not a visibility
    // decision about an entity, and flagging it would force an allowlist —
    // which is where a real finding would then hide.
    const found = clientVisibilityFilter(
      lines(
        'apps/web/src/app/RightRail.tsx',
        "{RIGHT_PANELS.filter((panel) => panel.id !== 'issue' && panelAllowed(panel.id)).map(",
      ),
    )
    expect(found).toEqual([])
  })

  it('per-user-state-local-home fires on a persisted key naming a moved member', () => {
    const found = perUserStateLocalHome(
      lines('apps/web/src/x.ts', "ui.set('podium.issue.readAt.' + id, String(now))"),
    )
    expect(found).toHaveLength(1)
  })

  it('per-user-state-local-home fires on the mobile preference store as well', () => {
    // Both platforms, because the brief names both homes and a detector that only
    // knew the web one would certify mobile by never looking.
    const found = perUserStateLocalHome(
      lines('apps/mobile/src/x.ts', "void AsyncStorage.setItem('pinnedAt:' + id, stamp)"),
    )
    expect(found).toHaveLength(1)
  })

  it('per-user-state-local-home does NOT fire on reading the field off a wire row', () => {
    // The client legitimately renders `readAt` from a row it did not persist.
    // Grading that would make every unread badge a finding.
    const found = perUserStateLocalHome(
      lines('apps/web/src/x.ts', 'const unread = issue.readAt === null'),
    )
    expect(found).toEqual([])
  })

  it('per-user-state-local-home derives its member list from the family, not a copy', () => {
    // A hand-copied list passes forever after a seventh member is added. This
    // fails if the family is ever emptied or renamed out from under the detector,
    // which is the drift the detector exists to survive.
    const found = perUserStateLocalHome(lines('apps/web/src/x.ts', "ui.set('tuckedAt', v)"))
    expect(found).toHaveLength(1)
  })
})

describe('phase-2 client audit — the composition-root detector', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'podium-audit-probe-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function write(file: string, body: string): void {
    mkdirSync(join(root, dirname(file)), { recursive: true })
    writeFileSync(join(root, file), body, 'utf8')
  }

  it('fires on a root that builds a persisted replica and never asks who owns it', () => {
    write('a/root.ts', 'const replica = createReplica({ storage })')
    expect(unattributedStoreRead(root, ['a/root.ts'])).toHaveLength(1)
  })

  it('does NOT fire once the root runs the attribution gate', () => {
    write(
      'a/root.ts',
      [
        'const decision = decideLegacyAdoption(plan, evidence)',
        'const replica = createReplica({ storage })',
      ].join('\n'),
    )
    expect(unattributedStoreRead(root, ['a/root.ts'])).toEqual([])
  })

  it('does NOT fire on a file that builds no persisted replica at all', () => {
    write('a/root.ts', 'export const noop = () => {}')
    expect(unattributedStoreRead(root, ['a/root.ts'])).toEqual([])
  })

  it('DISCOVERS a new composition root instead of being told about it', () => {
    // THE CASE THIS SUITE DID NOT HAVE, and the omission cost a real miss.
    // Roots used to be a hardcoded list of two. POD-1223/1228 merged two more
    // production roots and the audit went on reporting the same two findings —
    // a reader would have concluded the new roots were clean when the detector
    // had never looked at them. The old guard here was
    // `COMPOSITION_ROOTS.length > 0`, which passes happily while the list is two
    // names out of four; that is why it is gone and this is here.
    write('apps/web/src/lib/brandNewRoot.ts', 'const r = createKernelReplica({ cache, side })')
    expect(discoverCompositionRoots(root, ['apps/web/src'])).toContain(
      'apps/web/src/lib/brandNewRoot.ts',
    )
  })

  it('does NOT count the DEFINITION of a constructor as a call to it', () => {
    // `export function createReplica(init: ReplicaInit = {}): Replica {` matches the
    // construction pattern exactly, so the first discovery pass reported the two
    // files that DECLARE the constructors. A mention is not a call. Fixed by
    // requiring call shape — never by naming those two files, which would also
    // skip a real call appearing in either later.
    write(
      'apps/web/src/lib/defs.ts',
      [
        'export function createReplica(init: ReplicaInit = {}): Replica {',
        '  return impl(init)',
        '}',
      ].join('\n'),
    )
    expect(discoverCompositionRoots(root, ['apps/web/src'])).toEqual([])
  })

  it('does NOT grade a root CLEAN on a mere MENTION of the gate', () => {
    // POD-1239's finding, and it is the sharper half of the mention-is-not-a-call
    // family: call shape was required to be graded a ROOT, but a bare mention was
    // enough to be graded CLEAN. The gate's names are exactly the words a comment
    // ABOUT the gate contains, so a root can certify itself with a TODO describing
    // the consumer it does not have — and the lenient half is the one that decides
    // whether a security property is REPORTED AS HELD.
    write(
      'a/root.ts',
      [
        '// TODO: call migrateLegacyReplica here before we read anything',
        'const replica = createReplica({ storage })',
      ].join('\n'),
    )
    expect(unattributedStoreRead(root, ['a/root.ts'])).toHaveLength(1)
  })

  it('does NOT grade a root CLEAN on an unused `import type` of the evidence', () => {
    // `LegacyIdentityEvidence` is a TYPE. A type mention is not an act, and an
    // unused `import type` is precisely the shape that passes a name test while
    // spending no evidence. A root that genuinely attributes necessarily CALLS one
    // of the two functions.
    write(
      'a/root.ts',
      [
        "import type { LegacyIdentityEvidence } from '@podium/sync/adapters/legacy-replica'",
        'const replica = createReplica({ storage })',
      ].join('\n'),
    )
    expect(unattributedStoreRead(root, ['a/root.ts'])).toHaveLength(1)
  })

  it('does NOT promote a file into the population on a COMMENTED-OUT construction', () => {
    // The same blanking, in the other direction — this one fell out of POD-1239's
    // probe rather than being looked for. An innocent file that merely SHOWS the
    // construction in a comment was being reported as an unattributed root.
    write('a/root.ts', '// const replica = createReplica({ storage })')
    expect(discoverCompositionRoots(root, ['a'])).toEqual([])
  })

  it('reports the REAL line number even when a block comment precedes the call', () => {
    // Blanking comments renumbered every line after a block comment in the first
    // draft, so findings pointed at real files and fictional lines. Nothing caught
    // it — the count was right and the suite was green; only diffing the printed
    // output against a known-good run showed 135 had become 98. A report whose line
    // numbers are confidently wrong sends the reader to an innocent line, which
    // costs more trust than having no line number at all.
    write(
      'a/root.ts',
      [
        '/**',
        ' * A header that spans',
        ' * several lines.',
        ' */',
        'const replica = createReplica({ storage })',
      ].join('\n'),
    )
    expect(unattributedStoreRead(root, ['a/root.ts'])[0]?.line).toBe(5)
  })

  it('does NOT fire on a construction over the shipped EPHEMERAL seam', () => {
    // POD-1252. The item is about a PERSISTED store; the detector could only see
    // the construction, so it reported the shadow harness and the fixture capture —
    // two replicas over a private Map that dies with the function. The exemption is
    // a POSITIVE declaration (`memoryStorage()`), never a name list: an allowlist is
    // where a real finding would hide, and calling the gate in a root that decides
    // nothing teaches the next reader that the call is ceremony.
    write('a/root.ts', 'const replica = createReplica({ storage: memoryStorage() })')
    expect(unattributedStoreRead(root, ['a/root.ts'])).toEqual([])
  })

  it('resolves the ephemeral seam through a same-file binding', () => {
    // `legacy-snapshot.ts`'s shape: the store is named because the capture writes
    // to it and reads it back. One hop, in the same file — an IMPORT hop is not
    // followed, for the reason this audit already gives about the gate.
    write(
      'a/root.ts',
      [
        'const storage = memoryStorage()',
        'const replica = createReplica({ storage, enumerateKeys: () => storage.keys() })',
      ].join('\n'),
    )
    expect(unattributedStoreRead(root, ['a/root.ts'])).toEqual([])
  })

  it('STILL fires on a persisted construction in a file that also names the ephemeral seam', () => {
    // THE ANTI-SPOOF CASE, and the reason the exemption is per CALL rather than per
    // file. A file-level check would let one honest in-memory replica certify a
    // sibling construction over the user's real store — the partial-mechanism shape,
    // where N-1 of N links looks exactly like the whole thing working.
    write(
      'a/root.ts',
      [
        'const scratch = createReplica({ storage: memoryStorage() })',
        'const real = createReplica({ storage: window.localStorage })',
      ].join('\n'),
    )
    const found = unattributedStoreRead(root, ['a/root.ts'])
    expect(found).toHaveLength(1)
    expect(found[0]?.line).toBe(2)
  })

  it('does NOT exempt a construction whose ARGUMENTS merely mention the seam', () => {
    // The balanced-paren read is what makes this work: a naive scan stopping at the
    // first `)` would end inside the arrow's own parameter list, and a substring
    // search over the whole file would accept a mention anywhere. Neither would be
    // a claim about where THIS replica persists.
    write(
      'a/root.ts',
      'const r = createReplica({ storage: window.localStorage, onFallback: () => memoryStorage() })',
    )
    expect(unattributedStoreRead(root, ['a/root.ts'])).toHaveLength(1)
  })

  it('does NOT grade tests or perf harnesses as product roots', () => {
    write('apps/web/src/x.test.ts', 'const r = createReplica({ storage })')
    write('apps/web/src/perf/bench.tsx', 'const r = createReplica({ storage })')
    expect(discoverCompositionRoots(root, ['apps/web/src'])).toEqual([])
  })
})

describe('phase-2 client audit — it reads a non-empty repository', () => {
  it('finds source lines under every client root', () => {
    // The whole audit runs over `readClientLines`. If a root were renamed, every
    // line detector would report zero for the best possible reason and the worst
    // possible one, and nothing else in this file would notice.
    const found = readClientLines(REPO_ROOT, ['packages/client-core/src'])
    expect(found.length).toBeGreaterThan(1000)
  })

  it('reports every item, so a dropped detector is visible', () => {
    const items = runPhase2ClientAudit(REPO_ROOT)
    expect(items.map((item) => item.id)).toEqual([
      'world-assumption',
      'client-visibility-filter',
      'per-user-state-local-home',
      'unattributed-store-read',
    ])
  })
})
