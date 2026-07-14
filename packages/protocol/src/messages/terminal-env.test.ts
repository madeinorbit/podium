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
