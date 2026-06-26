// apps/daemon/src/output-scheduler-isolation.bun.test.ts
// Run: bun --conditions=@podium/source test apps/daemon/src/output-scheduler-isolation.bun.test.ts
import { expect, test } from 'bun:test'
import { OutputScheduler } from './output-scheduler'

test('a P3 flood does not delay a P0 session and stays batched', async () => {
  const sent: Array<{ sid: string; n: number }> = []
  const s = new OutputScheduler({
    flush: (sid, frames) => sent.push({ sid, n: frames.length }),
    coalesceMs: 50,
    coalesceMaxBytes: 1_000_000, // disable size-cap so we test the timer path
  })
  s.setPriority('bg', 3)
  s.setPriority('fg', 0)
  // background floods 500 frames; foreground sends 1
  for (let i = 0; i < 500; i++) s.enqueue('bg', 'x')
  s.enqueue('fg', 'k')
  await new Promise((r) => setTimeout(r, 0)) // foreground per-tick flush
  const fgImmediate = sent.filter((x) => x.sid === 'fg')
  expect(fgImmediate).toEqual([{ sid: 'fg', n: 1 }]) // fg flushed on the tick, batched once
  expect(sent.some((x) => x.sid === 'bg')).toBe(false) // bg NOT flushed yet (still coalescing)
  await new Promise((r) => setTimeout(r, 80))
  const bg = sent.filter((x) => x.sid === 'bg')
  expect(bg.length).toBe(1) // 500 frames → ONE batched send
  expect(bg[0]!.n).toBe(500)
})
