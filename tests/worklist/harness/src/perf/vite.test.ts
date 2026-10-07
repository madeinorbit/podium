import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { instrumentProductWork } from './vite'

const root = new URL('../../../../../', import.meta.url)

it.each([
  ['packages/client-graph/src/issue-board-source.ts', 'function facts(', 'function renamedFacts('],
  ['packages/client-graph/src/issue-board-layout.ts', 'const matching = keyedComputed(', 'const renamedMatching = keyedComputed('],
  ['packages/client-graph/src/header-views.ts', 'function createHeaderViews(', 'function renamedHeaderViews('],
  ['packages/client-graph/src/header-session.ts', 'export function headerWorkingSession(', 'export function renamedWorkingSession('],
  ['apps/web/src/features/machines/HostIndicators.tsx', 'memo(function PoolMachineReadout(', 'memo(function RenamedMachineReadout('],
])('observes the actual source and loudly refuses a renamed seam: %s', (relative, anchor, rename) => {
  const file = fileURLToPath(new URL(relative, root))
  const source = readFileSync(file, 'utf8')
  expect(instrumentProductWork(source, file)).toMatch(/__(?:countIssueBoard|measureHeader)/)
  const planted = source.replace(anchor, rename)
  expect(planted).not.toBe(source)
  expect(() => instrumentProductWork(planted, file)).toThrow(/work measurement boundary/)
})

it('exposes lazy computed owners only in measurement builds and refuses a missing naming seam', () => {
  const file = fileURLToPath(new URL('packages/mobx-helpers/src/lazy.ts', root))
  const source = readFileSync(file, 'utf8')
  const measured = instrumentProductWork(source, file)!
  expect(measured).toContain('context: this,')
  expect(source).not.toContain('context: this,')
  const planted = source.replace("name: debugName(() => `${this.constructor?.name ?? 'Object'}.${name}`)", 'name: undefined')
  expect(planted).not.toBe(source)
  expect(() => instrumentProductWork(planted, file)).toThrow(/work measurement boundary/)
})
