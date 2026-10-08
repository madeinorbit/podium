import { expect, it, vi } from 'vitest'
import { legacyFilterCommands } from '@/test-support/legacy-palette-filter'
import { filterCommandCandidates, flattenGroups, type PaletteCandidate, type PaletteCommand } from './command-palette'

it('matches the old ranking while constructing labels and references only for returned rows', () => {
  const details = vi.fn((command: PaletteCommand) => command)
  const full: PaletteCommand[] = []
  for (let n = 0; n < 100; n++) {
    full.push({ id: `task:${n}`, group: 'task', label: `Task ${n}`,
      keywords: ['task', 'issue', `#${n}`, 'Backlog'], run() {} })
    full.push({ id: `agent:${n}`, group: 'agent', label: `Agent ${n}`,
      keywords: ['repo', 'codex', 'agent', 'session'], run() {} })
  }
  full.push(...full.slice(0, 6).map(command => ({ ...command, group: 'recent' as const })))
  const candidates: PaletteCandidate[] = full.map(command => ({
    id: command.id, group: command.group, search: () => ({ label: command.label, keywords: command.keywords }),
    build: () => details(command),
  }))
  for (const query of ['', 'task', 'agent', 'repo', '#1', 'no matching command']) {
    details.mockClear()
    const actual = filterCommandCandidates(query, candidates)
    expect(actual).toEqual(legacyFilterCommands(query, full))
    expect(details).toHaveBeenCalledTimes(flattenGroups(actual).length)
    expect(details.mock.calls.length).toBeLessThanOrEqual(11)
  }
})

it('updates visible titles while preserving the six opening recents', () => {
  const rows = Array.from({ length: 12 }, (_, n) => ({ id: `task:${n}`, title: `Task ${n}` }))
  const build = vi.fn((row: typeof rows[number]): PaletteCommand => ({
    id: row.id, group: 'recent', label: row.title, run() {},
  }))
  const candidates: PaletteCandidate[] = rows.slice(0, 6).map(row => ({
    id: row.id, group: 'recent', search: () => ({ label: row.title }), build: () => build(row),
  }))
  const first = flattenGroups(filterCommandCandidates('', candidates))
  rows[2]!.title = 'Renamed visible task'
  build.mockClear()
  const next = flattenGroups(filterCommandCandidates('', candidates))
  expect(next.map(row => row.id)).toEqual(first.map(row => row.id))
  expect(next[2]!.label).toBe('Renamed visible task')
  expect(build).toHaveBeenCalledTimes(6)
})
