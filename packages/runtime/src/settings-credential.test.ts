import { expect, it } from 'vitest'
import { credentialEnv, normalizeSettings, resolveRole } from './settings'

it('maps an anthropic api key to ANTHROPIC_API_KEY', () => {
  expect(credentialEnv({ provider: 'anthropic', kind: 'api-key', credential: 'sk-ant-1' })).toEqual(
    {
      ANTHROPIC_API_KEY: 'sk-ant-1',
    },
  )
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

/** decodeAccount: 'claude-oauth' is not an ApiProvider name. Parsing it as one
 *  fails and silently falls back to 'openrouter' — so the Claude subscription
 *  would resolve to an OpenRouter backend. */
it('decodes the Claude subscription account as ANTHROPIC, not the openrouter fallback', () => {
  const settings = normalizeSettings({
    roles: { background: { accountId: 'managed:claude-oauth', model: 'auto', effort: 'auto' } },
  })
  const role = resolveRole(settings, 'background')
  expect(role.provider).toBe('anthropic')
  expect(role.accountId).toBe('managed:claude-oauth')
})

/** The #216 coding shape the picker now writes: a managed credential plus the
 *  harness it runs on. `harness` must force harness execution, and the accountId
 *  must survive — that id is what resolveAccountEnv() looks the credential up by. */
it('resolves a managed coding account + harness into a harness run on that credential', () => {
  const settings = normalizeSettings({
    roles: {
      coding: {
        accountId: 'managed:claude-oauth',
        harness: 'claude-code',
        model: 'auto',
        effort: 'auto',
      },
    },
  })
  const role = resolveRole(settings, 'coding')
  expect(role.execution).toBe('harness')
  expect(role.harness).toBe('claude-code')
  expect(role.accountId).toBe('managed:claude-oauth')
})
