import { expect, it } from 'vitest'
import { normalizeSettings, resolveRole } from './settings'

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

/** The #216 coding shape the picker wrote before credentials: a managed account
 *  plus the harness it runs on. `harness` must force harness execution, and the
 *  accountId must survive — the 2027-02 legacy reader resolves it to a credential. */
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

/** The shape every pick writes since credentials: a harness and no account id.
 *  The harness decides; the role keeps its default account id for old readers. */
it('a harness picked with no account id runs that harness', () => {
  const settings = normalizeSettings({
    roles: { coding: { accountId: '', harness: 'codex', model: 'auto', effort: 'auto' } },
  })
  const role = resolveRole(settings, 'coding')
  expect(role.execution).toBe('harness')
  expect(role.harness).toBe('codex')
})

it('a background role picked on Codex with no account id calls the ChatGPT Responses API', () => {
  const settings = normalizeSettings({
    roles: { background: { accountId: '', harness: 'codex', model: 'auto', effort: 'auto' } },
  })
  expect(resolveRole(settings, 'background')).toMatchObject({
    execution: 'api',
    harness: 'codex',
    provider: 'codex',
  })
})

it('a saved native account id still decides over a stale harness', () => {
  const settings = normalizeSettings({
    roles: {
      coding: { accountId: 'native:claude-code', harness: 'codex', model: 'auto', effort: 'auto' },
    },
  })
  expect(resolveRole(settings, 'coding').harness).toBe('claude-code')
})
