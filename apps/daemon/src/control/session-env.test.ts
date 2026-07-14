import { expect, it } from 'vitest'
import { spawnEnv } from './session'

it('passes a managed credential through to the spawn env', () => {
  const env = spawnEnv({
    sessionEnv: { ANTHROPIC_API_KEY: 'sk-1' },
    podiumEnv: { PODIUM_SESSION_ID: 's1' },
  })
  expect(env.ANTHROPIC_API_KEY).toBe('sk-1')
  expect(env.PODIUM_SESSION_ID).toBe('s1')
})

it('is a no-op when the server sends no env', () => {
  expect(spawnEnv({ podiumEnv: { PODIUM_SESSION_ID: 's1' } })).toEqual({
    PODIUM_SESSION_ID: 's1',
  })
})

it("podium's own bindings win a collision — a credential cannot shadow the relay", () => {
  const env = spawnEnv({
    sessionEnv: { PODIUM_SESSION_ID: 'evil' },
    podiumEnv: { PODIUM_SESSION_ID: 's1' },
  })
  expect(env.PODIUM_SESSION_ID).toBe('s1')
})
