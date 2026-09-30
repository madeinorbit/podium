/**
 * POD-4555 (L4a) — the generator is deterministic, covers the whole
 * vocabulary through the real engine, and emits the audit §3.3 shapes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RowSourceEvent } from '../stats'
import { type Change, CHANGE_KINDS, countKinds, gen, ROW_KINDS, type RowChange, SHAPES } from './changes'
import { runChanges, type StepResult } from './run'

afterEach(() => {
  vi.restoreAllMocks()
})

/** The ids a row change must show up under in the feed. */
function targetOf(c: RowChange): string {
  switch (c.kind) {
    case 'newSession':
    case 'heartbeat':
    case 'phaseChange':
    case 'offerChange':
    case 'newOrphanSession':
      return c.sessionId
    case 'newWorktree':
      return c.path
    default:
      return c.id
  }
}

const rowIds = (events: readonly RowSourceEvent[]): Set<string> =>
  new Set(events.flatMap((e) => e.rows.map((r) => r.id)))

/** kind:id of every row a step published, in order — the determinism key. */
const signature = (s: StepResult): string =>
  `${s.change.kind}|${s.skipped ?? ''}|${s.events.map((e) => `${e.type}:${e.rows.map((r) => `${r.kind}:${r.id}:${r.value === undefined ? '-' : '+'}`).join(',')}`).join(';')}`

describe('gen', () => {
  it('is deterministic in the seed and never reads the clock or Math.random', () => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('gen read Math.random')
    })
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('gen read Date.now')
    })
    const a = gen(1, 400)
    const b = gen(1, 400)
    expect(a).toEqual(b)
    expect(a).toHaveLength(400)
    expect(gen(2, 400)).not.toEqual(a)
  })

  it('draws only the kinds it is weighted for', () => {
    const only = gen(3, 200, Object.fromEntries([...CHANGE_KINDS, 'shapes'].map((k) => [k, k === 'heartbeat' || k === 'evict' || k === 'reAdd' ? 1 : 0])))
    expect(new Set(only.map((c) => c.kind))).toEqual(new Set(['heartbeat', 'evict', 'reAdd']))
  })

  it('emits each audit §3.3 shape in its defining pattern', () => {
    const changes = gen(1, 3000)
    const tagged = (shape: string): Change[] => changes.filter((c) => 'shape' in c && c.shape === shape)
    // clock decay: a visible row finishes, then the clock crosses the 24 h grace window.
    const decay = tagged('clockDecay')
    for (let k = 0; k < decay.length; k += 2) {
      expect(decay[k]).toMatchObject({ kind: 'stageChange', stage: 'done' })
      expect(decay[k + 1]).toMatchObject({ kind: 'clockTick' })
      expect((decay[k + 1] as { ms: number }).ms).toBeGreaterThan(24 * 60 * 60_000)
    }
    // offer removed on a finished child: ends with the offer cleared.
    const offer = tagged('offerRemovedOnFinishedChild')
    expect(offer.some((c) => c.kind === 'offerChange' && c.offer === false)).toBe(true)
    // evict then re-add: consecutive, same row.
    const readd = tagged('evictThenReAdd')
    for (let k = 0; k < readd.length; k += 2) {
      expect(readd[k]).toMatchObject({ kind: 'evict' })
      expect(readd[k + 1]).toMatchObject({ kind: 'reAdd', id: (readd[k] as { id: string }).id })
    }
    // two rank moves in one batch: one kernel batch, two siblings re-keyed.
    for (const c of tagged('twoRankMovesInOneBatch')) {
      expect(c.kind).toBe('batch')
      const members = (c as { changes: RowChange[] }).changes
      expect(members.map((m) => m.kind)).toEqual(['rankMove', 'rankMove'])
      expect(new Set(members.map((m) => (m as { id: string }).id)).size).toBe(2)
    }
    for (const c of tagged('rankMoveWithinGroup')) expect(c.kind).toBe('rankMove')
  })

  it('POD-4681: emits each R-VIS shape in its defining pattern', () => {
    const changes = gen(1, 3000)
    const tagged = (shape: string): Change[] => changes.filter((c) => 'shape' in c && c.shape === shape)
    // Excluded keeper: backlog parent, proposed child, flat grandchild.
    const keeper = tagged('excludedKeeper')
    expect(keeper.length).toBeGreaterThan(0)
    for (let k = 0; k + 4 < keeper.length; k += 5) {
      expect(keeper[k]).toMatchObject({ kind: 'newIssue' })
      expect(keeper[k + 1]).toMatchObject({ kind: 'stageChange', stage: 'backlog' })
      expect(keeper[k + 2]).toMatchObject({ kind: 'newIssue' })
      expect(keeper[k + 3]).toMatchObject({ kind: 'newIssue' })
      expect(keeper[k + 4]).toMatchObject({ kind: 'stageChange', stage: 'proposed' })
      const parent = (keeper[k] as { id: string }).id
      expect((keeper[k + 1] as { id: string }).id).toBe(parent)
      const child = (keeper[k + 2] as { id: string }).id
      expect((keeper[k + 2] as { parentId: string }).parentId).toBe(parent)
      expect((keeper[k + 3] as { parentId: string }).parentId).toBe(child)
      expect((keeper[k + 4] as { id: string }).id).toBe(child)
    }
    // Orphan in worktree: backlog owner given a scanned lane, then an issueless session.
    const orphan = tagged('orphanInWorktree')
    expect(orphan.length).toBeGreaterThan(0)
    for (let k = 0; k + 4 < orphan.length; k += 5) {
      expect(orphan[k]).toMatchObject({ kind: 'newIssue' })
      expect(orphan[k + 1]).toMatchObject({ kind: 'stageChange', stage: 'backlog' })
      expect(orphan[k + 2]).toMatchObject({ kind: 'newWorktree' })
      expect(orphan[k + 3]).toMatchObject({ kind: 'setWorktree' })
      expect(orphan[k + 4]).toMatchObject({ kind: 'newOrphanSession' })
      const owner = (orphan[k] as { id: string }).id
      expect((orphan[k + 1] as { id: string }).id).toBe(owner)
      expect((orphan[k + 3] as { id: string }).id).toBe(owner)
      expect((orphan[k + 3] as { path: string }).path).toBe((orphan[k + 2] as { path: string }).path)
      expect((orphan[k + 4] as { ownerId: string }).ownerId).toBe(owner)
    }
    // Draft-vessel starter: agent draft, its live session, parentless starter, link.
    const starter = tagged('draftVesselStarter')
    expect(starter.length).toBeGreaterThan(0)
    for (let k = 0; k + 3 < starter.length; k += 4) {
      expect(starter[k]).toMatchObject({ kind: 'newDraftIssue' })
      expect(starter[k + 1]).toMatchObject({ kind: 'newSession' })
      expect(starter[k + 2]).toMatchObject({ kind: 'newIssue', parentId: null })
      expect(starter[k + 3]).toMatchObject({ kind: 'setStartedBy' })
      const vessel = (starter[k] as { id: string }).id
      expect((starter[k + 1] as { issueId: string }).issueId).toBe(vessel)
      const issue = (starter[k + 2] as { id: string }).id
      expect((starter[k + 3] as { id: string }).id).toBe(issue)
      expect((starter[k + 3] as { sessionId: string }).sessionId).toBe(
        (starter[k + 1] as { sessionId: string }).sessionId,
      )
    }
  })

  it('POD-4940: emits the awaiting-merge shape in its defining pattern', () => {
    const changes = gen(1, 3000)
    const tagged = (shape: string): Change[] => changes.filter((c) => 'shape' in c && c.shape === shape)
    // Awaiting merge: agent child, finished, then the unlanded branch.
    const merge = tagged('awaitingMerge')
    expect(merge.length).toBeGreaterThan(0)
    for (let k = 0; k + 2 < merge.length; k += 3) {
      expect(merge[k]).toMatchObject({ kind: 'newIssue', audience: 'agent' })
      expect(merge[k + 1]).toMatchObject({ kind: 'stageChange', stage: 'done' })
      expect(merge[k + 2]).toMatchObject({ kind: 'setBranch' })
      const id = (merge[k] as { id: string }).id
      expect((merge[k] as { parentId: string }).parentId).not.toBeNull()
      expect((merge[k + 1] as { id: string }).id).toBe(id)
      expect((merge[k + 2] as { id: string }).id).toBe(id)
      expect((merge[k + 2] as { branch: string }).branch).toContain('podium/merge-')
    }
  })

  it('POD-4681: each R-VIS shape occurs in every default 3x200 seed', () => {
    for (const seed of [1, 2, 3]) {
      const changes = gen(seed, 200)
      const { shapes } = countKinds(changes)
      expect(shapes['excludedKeeper'] ?? 0, `seed ${seed} excludedKeeper`).toBeGreaterThanOrEqual(1)
      expect(shapes['orphanInWorktree'] ?? 0, `seed ${seed} orphanInWorktree`).toBeGreaterThanOrEqual(1)
      expect(shapes['draftVesselStarter'] ?? 0, `seed ${seed} draftVesselStarter`).toBeGreaterThanOrEqual(1)
      expect(shapes['awaitingMerge'] ?? 0, `seed ${seed} awaitingMerge`).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('gen through the engine', () => {
  it(
    'COVERAGE: 2,000 steps at seed 1 apply every change kind at least 10 times, with every audit shape and every L1c write-path event',
    async () => {
      const changes = gen(1, 2000)
      const { steps, run } = await runChanges(changes)
      try {
        const applied = steps.filter((s) => !s.skipped)
        const generated = countKinds(changes)
        const hit = countKinds(applied.map((s) => s.change))
        const report = Object.fromEntries(
          CHANGE_KINDS.map((k) => [k, `${hit.kinds[k] ?? 0}/${generated.kinds[k] ?? 0}`]),
        )
        for (const kind of CHANGE_KINDS) {
          expect(hit.kinds[kind] ?? 0, `${kind} applied (applied/generated ${JSON.stringify(report)})`).toBeGreaterThanOrEqual(10)
        }
        for (const shape of SHAPES) {
          expect(hit.shapes[shape] ?? 0, `shape ${shape}`).toBeGreaterThanOrEqual(10)
        }

        // Every applied row change reached the feed under its own id: a real
        // change, not a synthesised one. A worktree arrives through discovery
        // (`worktreesChanged` → `refreshRepos`), not a kernel row; the feed
        // emits its lane by path all the same (POD-4606), and the engine's own
        // repos prove the change landed.
        const lanes = new Set(
          run.ctx.engine.getSnapshot().repos.flatMap((r) => (r.worktrees ?? []).map((w) => w.path)),
        )
        const reach = (m: RowChange, ids: Set<string>, where: string): void => {
          if (m.kind === 'newWorktree') {
            expect(lanes.has(m.path), `${where} worktree ${m.path} missing from the engine`).toBe(true)
          }
          expect(ids.has(targetOf(m)), `${where} ${m.kind} ${targetOf(m)} missing from the feed`).toBe(true)
        }
        for (const s of applied) {
          if (s.change.kind === 'batch') {
            const skippedMembers = (s.detail?.['skippedMembers'] as number[] | undefined) ?? []
            const ids = rowIds(s.events)
            s.change.changes.forEach((m, member) => {
              if (!skippedMembers.includes(member)) reach(m, ids, `step ${s.index} batch`)
            })
          } else if ((ROW_KINDS as readonly string[]).includes(s.change.kind)) {
            reach(s.change as RowChange, rowIds(s.events), `step ${s.index}`)
          }
        }

        // The L1c §5 write-path events, each observed through the kernel.
        const details: Record<string, unknown>[] = applied.map((s) => ({ kind: s.change.kind, ...s.detail }))
        const echoes = details.filter((d) => d.kind === 'echo')
        expect(echoes.filter((d) => d['beforeReceipt'] === true).length, 'echo before the receipt').toBeGreaterThan(0)
        expect(echoes.filter((d) => d['beforeReceipt'] === false).length, 'echo after the receipt').toBeGreaterThan(0)
        expect(details.filter((d) => d.kind === 'supersede' && d['collapsed'] === true).length, 'supersede collapsed by the kernel outbox').toBeGreaterThan(0)
        const reloads = details.filter((d) => d.kind === 'refresh')
        expect(reloads.reduce((n, d) => n + (d['resent'] as number), 0), 'reload re-sends pending writes').toBeGreaterThan(0)
        expect(reloads.reduce((n, d) => n + (d['duplicateReceipts'] as number), 0), 'duplicate receipt').toBeGreaterThan(0)
        expect(run.server.refused.size, 'rejections').toBeGreaterThanOrEqual(10)
        expect(run.server.applied.size, 'receipts').toBeGreaterThanOrEqual(10)
        // A remote value landing on a field whose edit is still unanswered (S3),
        // and one landing after the receipt (the W8 overtake window).
        const remotes = details.filter((d) => d.kind === 'remoteOnPending')
        expect(remotes.filter((d) => d['unanswered'] === true).length, 'remote update on a pending field').toBeGreaterThanOrEqual(10)
        expect(remotes.filter((d) => d['unanswered'] === false).length, 'remote update after the receipt').toBeGreaterThan(0)
      } finally {
        run.dispose()
      }
    },
    300_000,
  )

  it(
    'applies the same sequence to the same events on a fresh engine',
    async () => {
      const changes = gen(5, 150)
      const first = await runChanges(changes)
      first.run.dispose()
      const second = await runChanges(changes)
      second.run.dispose()
      expect(second.steps.map(signature)).toEqual(first.steps.map(signature))
    },
    300_000,
  )
})
