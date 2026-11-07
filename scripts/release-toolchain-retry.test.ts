import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type Step = {
  id?: string
  uses?: string
  if?: string
  run?: string
  'continue-on-error'?: boolean
  with?: Record<string, unknown>
}
type Workflow = { jobs: Record<string, { steps: Step[] }> }
const groups = ['release.yml', 'desktop-release.yml'].flatMap((file) => {
  const config = Bun.YAML.parse(
    readFileSync(join(__dirname, '../.github/workflows', file), 'utf8'),
  ) as Workflow
  return Object.entries(config.jobs).flatMap(([job, { steps }]) =>
    steps.flatMap((initial, index) => {
      if (!initial.id?.match(/^mise_setup_\d+$/)) return []
      const [waitFirst, fallback, waitSecond, final] = steps.slice(index + 1, index + 5)
      if (!waitFirst || !fallback || !waitSecond || !final) throw new Error('incomplete mise retry')
      return [
        { name: `${file}/${job}/${initial.id}`, initial, waitFirst, fallback, waitSecond, final },
      ]
    }),
  )
})

function shouldRun(step: Step, outcomes: Record<string, string>) {
  const condition = step.if?.match(/^steps\.(\w+)\.outcome == 'failure'$/)
  if (!condition?.[1]) throw new Error(`unexpected retry condition: ${step.if}`)
  return outcomes[condition[1]] === 'failure'
}

describe('release tool setup recovery', () => {
  it('covers all eight installer calls', () => {
    expect(groups).toHaveLength(8)
  })

  it.each(groups)('$name retries before compilation and preserves installation arguments', (g) => {
    expect(g.initial.uses).toBe('jdx/mise-action@v2')
    expect(g.initial['continue-on-error']).toBe(true)
    expect(g.fallback).toMatchObject({
      uses: 'jdx/mise-action@v2',
      'continue-on-error': true,
      with: { ...g.initial.with, fetch_from_github: false },
    })
    expect(g.final.uses).toBe('jdx/mise-action@v2')
    expect(g.final.with).toEqual({ ...g.initial.with, fetch_from_github: false })
    expect(g.final['continue-on-error']).not.toBe(true)
    expect(g.waitFirst.run).toBe('sleep 15')
    expect(g.waitSecond.run).toBe('sleep 45')
    expect(g.fallback.with).toEqual({ ...g.initial.with, fetch_from_github: false })

    const id = g.initial.id ?? ''
    const fallbackId = g.fallback.id ?? ''
    const retries = [g.waitFirst, g.fallback, g.waitSecond, g.final]
    expect(retries.map((step) => shouldRun(step, { [id]: 'success' }))).toEqual([
      false,
      false,
      false,
      false,
    ])
    expect(retries.map((step) => shouldRun(step, { [id]: 'skipped' }))).toEqual([
      false,
      false,
      false,
      false,
    ])
    expect(
      retries.map((step) => shouldRun(step, { [id]: 'failure', [fallbackId]: 'success' })),
    ).toEqual([true, true, false, false])
    expect(
      retries.map((step) => shouldRun(step, { [id]: 'failure', [fallbackId]: 'failure' })),
    ).toEqual([true, true, true, true])
  })
})
