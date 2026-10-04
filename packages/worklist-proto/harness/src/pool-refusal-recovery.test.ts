// @vitest-environment happy-dom
import { recoverableAuthoredText } from '@podium/client-core/outbox-recovery-copy'
import { autorun } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { refusalFixture } from './refusal-fixture'
import { measureWork } from './work-meter'

const fixtures: Awaited<ReturnType<typeof refusalFixture>>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose() })
async function boot(scale: 1 | 4 = 1) {
  const f = await refusalFixture(scale)
  fixtures.push(f)
  return f
}

it('announces a refusal after its model rebases and preserves the exact input for recovery', async () => {
  const f = await boot()
  const views: { title: string | undefined; notSaved: boolean }[] = []
  const title = () => {
    const row = f.pool.row('issue', f.id)
    return row && typeof row !== 'symbol' ? row.title : undefined
  }
  const stop = autorun(() => views.push({ title: title(), notSaved: f.pool.notSaved('issue', f.id) }))
  let announced: unknown
  const off = f.handle.transactions!.onRejected(() => { announced = views.at(-1) })
  try {
    f.pool.mutate('issueUpdate', { id: f.id, patch: { title: '  original input\nkept  ' } })
    await vi.waitFor(() => expect(f.outbox.pending()).toHaveLength(1))
    expect(title()).toContain('original input')
    f.setOnline(true)
    await vi.waitFor(() => expect(f.outbox.deadLetters()).toHaveLength(1))
    expect(announced).toEqual({ title: f.original, notSaved: true })
    expect(recoverableAuthoredText(f.outbox.deadLetters()[0]!.entry.input)).toBe('  original input\nkept  ')
    expect(views.at(-1)).toEqual({ title: f.original, notSaved: true })
    expect(f.outbox.pending()).toHaveLength(0)
  } finally { stop(); off() }
})

it('rolls back an expired real queue entry and shows its mark until recovery discards it', async () => {
  const f = await boot()
  const id = f.pool.mutate('issueUpdate', { id: f.id, patch: { title: 'expired words' } })
  await vi.waitFor(() => expect(f.outbox.pending()).toHaveLength(1))
  f.ctx.advanceClock(14 * 24 * 60 * 60 * 1000 + 1)
  f.setOnline(true)
  await vi.waitFor(() => expect(f.outbox.deadLetters()).toHaveLength(1))
  expect(f.outbox.deadLetters()[0]).toMatchObject({ parkedFrom: 'expired', reason: { code: 'max-age' } })
  expect(f.pool.row('issue', f.id)).toMatchObject({ title: f.original })
  expect(f.pool.notSaved('issue', f.id)).toBe(true)
  await f.outbox.discard(id)
  expect(f.pool.notSaved('issue', f.id)).toBe(false)
})

it('not-saved refusal and retry work stays flat at 1x and 4x on the shared corpus', async () => {
  const samples: { scale: number; issues: number; refusal: Awaited<ReturnType<typeof measureWork>>['work']; retry: Awaited<ReturnType<typeof measureWork>>['work'] }[] = []
  for (const scale of [1, 4] as const) {
    const f = await boot(scale)
    let markerRuns = 0
    const stops = f.ctx.corpus.issues.map(issue => autorun(() => {
      f.pool.notSaved('issue', issue.id)
      markerRuns++
    }, { name: `not-saved row:${issue.id}` }))
    try {
      const id = f.pool.mutate('issueUpdate', { id: f.id, patch: { title: 'refused meter words' } })
      await vi.waitFor(() => expect(f.outbox.pending()).toHaveLength(1))
      markerRuns = 0
      const refusal = await measureWork(async () => {
        f.setOnline(true)
        await vi.waitFor(() => expect(f.outbox.deadLetters()).toHaveLength(1), { interval: 5 })
      }, { pool: f.pool })
      expect(markerRuns).toBe(1)
      expect(f.pool.notSaved('issue', f.id)).toBe(true)
      f.setOnline(false)
      markerRuns = 0
      const retry = await measureWork(async () => {
        await f.outbox.retry(id, { expectedRevision: 0 })
      }, { pool: f.pool })
      expect(markerRuns).toBe(1)
      expect(f.pool.notSaved('issue', f.id)).toBe(false)
      samples.push({ scale, issues: f.ctx.corpus.issues.length, refusal: refusal.work, retry: retry.work })
    } finally { stops.forEach(stop => stop()) }
  }
  console.info('[not-saved work]', JSON.stringify(samples))
  for (const action of ['refusal', 'retry'] as const) {
    const small = samples[0]![action], large = samples[1]![action]
    for (const kind of ['derivations', 'rows', 'elements'] as const) {
      expect(large[kind] ?? 0, `${action} ${kind}`).toBeLessThanOrEqual(small[kind] ?? 0)
    }
    expect(small.derivations).toBeGreaterThan(0)
  }
})
