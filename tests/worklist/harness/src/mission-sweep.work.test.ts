import { mkdirSync, writeFileSync } from 'node:fs'
import { MissionViewReader } from '@podium/client-graph/mission-view'
import { expect, it, vi } from 'vitest'
import { poolScreenCellsAt } from './pool-screen-work'
import { screenWorkVerdicts } from './screen-work-ratios'

it('records the remaining mission sweep work with every reader mounted', async () => {
  const traces: Record<string, unknown>[] = []
  const raw = MissionViewReader.prototype.rawSession
  const spy = vi.spyOn(MissionViewReader.prototype, 'rawSession').mockImplementation(function (id) {
    if (id === 'guard-seat') traces.push({ stack: new Error().stack })
    return raw.call(this, id)
  })
  mkdirSync('.artifacts', { recursive: true })
  try {
    const run = async (scale: 1 | 4) => {
      traces.length = 0
      return poolScreenCellsAt(scale, cell => {
        writeFileSync(`.artifacts/mission-trace-${scale}-${cell.action}.json`, JSON.stringify(traces, null, 2))
        traces.length = 0
      })
    }
    const at1x = await run(1), at4x = await run(4)
    const verdicts = screenWorkVerdicts(at1x.cells, at4x.cells)
    writeFileSync('.artifacts/mission-sweep.json', JSON.stringify({ at1x, at4x, verdicts }, null, 2))
    const mission = /^(consumer:(mission\.|header\.folded)|Mission|SessionSeat|Seats\.)/
    console.info('[mission sweep]', JSON.stringify(verdicts.filter(value => mission.test(value.reader)), null, 2))
    expect(at1x.readers).toEqual(at4x.readers)
  } finally { spy.mockRestore() }
}, 1_800_000)
