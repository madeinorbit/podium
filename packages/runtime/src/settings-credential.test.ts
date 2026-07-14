import { expect, it } from 'vitest'
import { credentialEnv } from './settings'

it('maps an anthropic api key to ANTHROPIC_API_KEY', () => {
  expect(credentialEnv({ provider: 'anthropic', kind: 'api-key', credential: 'sk-ant-1' })).toEqual({
    ANTHROPIC_API_KEY: 'sk-ant-1',
  })
})

it('maps an openai api key to OPENAI_API_KEY', () => {
  expect(credentialEnv({ provider: 'openai', kind: 'api-key', credential: 'sk-1' })).toEqual({
    OPENAI_API_KEY: 'sk-1',
  })
})

it('maps an anthropic oauth token to CLAUDE_CODE_OAUTH_TOKEN', () => {
  expect(credentialEnv({ provider: 'anthropic', kind: 'oauth', credential: 'oat-1' })).toEqual({
    CLAUDE_CODE_OAUTH_TOKEN: 'oat-1',
  })
})

it('yields nothing for a provider with no env mapping', () => {
  expect(credentialEnv({ provider: 'xai', kind: 'api-key', credential: 'x' })).toEqual({})
})

it('yields nothing for an empty credential rather than exporting a blank var', () => {
  expect(credentialEnv({ provider: 'anthropic', kind: 'api-key', credential: '' })).toEqual({})
})
