import { expect, it } from 'vitest'
import { SpawnMessage } from './terminal'

const base = {
  type: 'spawn' as const,
  sessionId: 's1',
  agentKind: 'claude-code' as const,
  cwd: '/tmp',
  geometry: { cols: 80, rows: 24 },
}

it('accepts an env map', () => {
  const parsed = SpawnMessage.parse({ ...base, env: { ANTHROPIC_API_KEY: 'sk-1' } })
  expect(parsed.env).toEqual({ ANTHROPIC_API_KEY: 'sk-1' })
})

it('treats env as optional — an old server omitting it still parses', () => {
  expect(SpawnMessage.parse(base).env).toBeUndefined()
})

it('rejects a non-string env value', () => {
  expect(SpawnMessage.safeParse({ ...base, env: { A: 1 } }).success).toBe(false)
})

it('accepts attributed machine instructions separately from the initial prompt', () => {
  const parsed = SpawnMessage.parse({
    ...base,
    initialPrompt: 'human task',
    instructions: [{ source: 'podium:workflow', content: 'hidden workflow context' }],
  })
  expect(parsed.initialPrompt).toBe('human task')
  expect(parsed.instructions).toEqual([
    { source: 'podium:workflow', content: 'hidden workflow context' },
  ])
})

it('rejects blank instruction sources or content', () => {
  expect(
    SpawnMessage.safeParse({ ...base, instructions: [{ source: '', content: 'rules' }] }).success,
  ).toBe(false)
  expect(
    SpawnMessage.safeParse({ ...base, instructions: [{ source: 'workflow', content: '' }] })
      .success,
  ).toBe(false)
})
