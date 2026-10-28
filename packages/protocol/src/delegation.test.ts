import { describe, expect, it } from 'vitest'
import { COORDINATION_RULE, DELEGATION_RULE, LOCK_RULE } from './delegation'

describe('LOCK_RULE', () => {
  it('reserves the merge namespace to the canonical name', () => {
    // The mutex having two spellings is what let two sessions hold it at once.
    expect(LOCK_RULE).toContain('merge:<branch>')
    expect(LOCK_RULE).toMatch(/RESERVED/)
    expect(LOCK_RULE).toMatch(/REFUSED/)
  })

  it('sits next to the lock and delegation rules without drifting into them', () => {
    // Smoke that the two prime co-tenants still export as strings.
    expect(typeof LOCK_RULE).toBe('string')
    expect(typeof DELEGATION_RULE).toBe('string')
  })
})

describe('prime-bound procedure length (POD-789)', () => {
  it('keeps the two always-loaded procedures under 4 KB combined', () => {
    const combined = LOCK_RULE.length + DELEGATION_RULE.length
    expect(combined).toBeLessThan(4000)
  })
})

describe('COORDINATION_RULE (POD-2062)', () => {
  it('names the commands a coordinator needs without reading Podium source', () => {
    expect(COORDINATION_RULE).toContain('podium issue coordinator <id> --claim')
    expect(COORDINATION_RULE).toContain('--type phase --parent-id <id>')
    expect(COORDINATION_RULE).toContain('dep-add <later-task> <earlier-task>')
    expect(COORDINATION_RULE).toContain('podium issue move <new> --after <previous>')
    expect(COORDINATION_RULE).toMatch(/exits 1 with the reason on stderr/)
  })

  it('limits phases to real multi-stage work without forbidding one-task stages', () => {
    expect(COORDINATION_RULE).toContain('two or more stages that run one after another')
    expect(COORDINATION_RULE).toContain('A stage may hold a single task')
    expect(COORDINATION_RULE).toContain('Never a phase per routine task')
  })

  it('files the plan before launching, edges between tasks, solo work flat (POD-2178)', () => {
    expect(COORDINATION_RULE).toContain('WITHOUT `--start`')
    expect(COORDINATION_RULE).toContain('podium issue start <task>')
    expect(COORDINATION_RULE).toContain('Edges go between tasks, never phases')
    expect(COORDINATION_RULE).toContain('Phases only group')
    expect(COORDINATION_RULE).toContain('podium issue todo <id> --add')
  })

  it('never presents the per-issue budget as a way around a refusal', () => {
    expect(COORDINATION_RULE).toContain('never to get around a refusal')
  })

  it("closes accepted tasks but never the coordinator's own issue (POD-2232)", () => {
    expect(COORDINATION_RULE).toContain('podium issue close <task> --reason done --note')
    expect(COORDINATION_RULE).toContain('send it back')
    expect(COORDINATION_RULE).toContain('Your own issue stays open for the user to close')
  })

  it('stays a short paragraph: it rides every prime', () => {
    expect(COORDINATION_RULE.length).toBeLessThan(2600)
  })
})
