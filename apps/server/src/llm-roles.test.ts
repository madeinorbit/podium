import { asAccountId, asUserId, type UserId } from '@podium/model'
import { normalizeSettings, type PodiumSettings } from '@podium/runtime'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { LlmClient, LlmMessage } from './llm'
import { LlmConfigError } from './llm-error'
import { completeForRole, jsonSchema, oneShotApiKey, resolveOneShotBackend } from './llm-roles'
import {
  AccountsRepository,
  type ManagedAccountWrite,
  SHARED_WITH_EVERYONE,
} from './store/accounts'
import { openMigratedTestDatabase } from './test-support/migrated-database'
import { stageASeam } from './test-support/stage-a-seam'

const settings = (patch: Partial<PodiumSettings> = {}): PodiumSettings =>
  normalizeSettings({
    workLlm: { kind: 'api', provider: 'openrouter', model: 'bg-model' },
    superagent: { kind: 'api', provider: 'anthropic', model: 'sa-model' },
    apiKeys: { openrouter: 'or-key', anthropic: 'an-key', openai: '' },
    ...patch,
  })

/** The provider-key resolver `completeForRole` now requires (POD-419) — the
 *  material lives in the server-only keyed store, not in `settings.apiKeys`. */
const apiKey = ({ provider }: { provider: string }): string | undefined =>
  ({ openrouter: 'or-key', anthropic: 'an-key' })[provider]

/** A fake llmClient factory: records what it was built with, returns fixed text. */
function fakeLlm(text: string) {
  const calls: { model: string; messages: LlmMessage[] }[] = []
  const factory = ((backend: { model: string }): LlmClient => ({
    label: `fake · ${backend.model}`,
    complete: async (messages: LlmMessage[]) => {
      calls.push({ model: backend.model, messages })
      return { text, toolCalls: [] }
    },
  })) as unknown as Parameters<typeof completeForRole>[0]['llm']
  return { factory, calls }
}

describe('resolveOneShotBackend', () => {
  it('maps background→workLlm and superagent→superagent', () => {
    const s = settings()
    expect(resolveOneShotBackend(s, 'background').model).toBe('bg-model')
    expect(resolveOneShotBackend(s, 'superagent').model).toBe('sa-model')
  })
})

describe('completeForRole', () => {
  it('resolves the role backend, calls the client, returns raw text by default', async () => {
    const { factory, calls } = fakeLlm('hello world')
    const r = await completeForRole(
      { settings: settings(), apiKey: apiKey, llm: factory },
      { role: 'background', messages: [{ role: 'user', content: 'hi' }] },
    )
    expect(r.data).toBe('hello world')
    expect(r.text).toBe('hello world')
    expect(calls[0]!.model).toBe('bg-model') // used the workLlm backend
  })

  it('parses into structured data when given parse', async () => {
    const { factory } = fakeLlm('the title is:\n```json\n{"title":"Fix login"}\n```')
    const r = await completeForRole(
      { settings: settings(), apiKey: apiKey, llm: factory },
      {
        role: 'background',
        messages: [{ role: 'user', content: 'name it' }],
        parse: jsonSchema(z.object({ title: z.string() })),
      },
    )
    expect(r.data).toEqual({ title: 'Fix login' })
  })

  it('returns null data (not a throw) when the model output cannot be parsed', async () => {
    const { factory } = fakeLlm('no json here, sorry')
    const r = await completeForRole(
      { settings: settings(), apiKey: apiKey, llm: factory },
      {
        role: 'background',
        messages: [{ role: 'user', content: 'x' }],
        parse: jsonSchema(z.object({ title: z.string() })),
      },
    )
    expect(r.data).toBeNull()
  })
})

describe('jsonSchema', () => {
  const parse = jsonSchema(z.object({ a: z.number() }))
  it('extracts a braced object from surrounding prose', () => {
    expect(parse('sure: {"a": 1} done')).toEqual({ a: 1 })
  })
  it('extracts a fenced json block', () => {
    expect(parse('```json\n{"a": 2}\n```')).toEqual({ a: 2 })
  })
  it('returns null on schema mismatch', () => {
    expect(parse('{"a": "not a number"}')).toBeNull()
  })
  it('returns null when no object is present', () => {
    expect(parse('plain text')).toBeNull()
  })
})

/**
 * The credential a one-shot role call spends (POD-469), with two members.
 *
 * Coding sessions resolve a managed key from the accounts table: the member's
 * own, then one explicitly shared with them. The one-shot (api) path used to
 * read only the instance's legacy keyed store, so a key connected in the
 * Accounts hub served coding sessions and silently not the background role.
 * These pin the one rule both paths now share, and that a one-shot call never
 * borrows another member's unshared key.
 */

const ADMIN = asUserId('user:admin')
const MEMBER = asUserId('user:member')
const OPENROUTER = asAccountId('managed:openrouter')
const CLAUDE_OAUTH = asAccountId('managed:claude-oauth')

let accounts: AccountsRepository

const ports = () => ({
  accounts,
})

const connect = async (
  ownerUserId: UserId,
  credential: string,
  accountKey = OPENROUTER,
  extra: Partial<ManagedAccountWrite> = {},
) =>
  await accounts.connect({
    ownerUserId,
    accountKey,
    provider: 'openrouter',
    kind: 'api-key',
    credential,
    identity: 'mask',
    scope: 'role',
    createdAt: 1,
    ...extra,
  })

beforeEach(() => {
  accounts = new AccountsRepository(stageASeam(openMigratedTestDatabase()))
})

describe('oneShotApiKey', () => {
  it("spends the acting member's own managed key", async () => {
    await connect(ADMIN, 'admin-key')
    expect(
      await oneShotApiKey(ports(), ADMIN, { provider: 'openrouter', accountId: OPENROUTER }),
    ).toBe('admin-key')
  })

  it("never borrows another member's unshared key", async () => {
    await connect(MEMBER, 'member-key')
    expect(
      await oneShotApiKey(ports(), ADMIN, { provider: 'openrouter', accountId: OPENROUTER }),
    ).toBeUndefined()
  })

  it('uses a key another member explicitly shares with the acting member', async () => {
    await connect(MEMBER, 'member-key')
    await accounts.share(MEMBER, OPENROUTER, [SHARED_WITH_EVERYONE])
    expect(
      await oneShotApiKey(ports(), ADMIN, { provider: 'openrouter', accountId: OPENROUTER }),
    ).toBe('member-key')
  })

  it('own key wins over an adopted workspace key shared with everyone', async () => {
    await connect(ADMIN, 'admin-key')
    await connect(
      MEMBER,
      'earlier-workspace-key',
      asAccountId('managed:openrouter:earlier-workspace'),
    )
    await accounts.share(MEMBER, asAccountId('managed:openrouter:earlier-workspace'), [
      SHARED_WITH_EVERYONE,
    ])
    expect(
      await oneShotApiKey(ports(), ADMIN, { provider: 'openrouter', accountId: OPENROUTER }),
    ).toBe('admin-key')
  })

  it('uses an adopted workspace key through ordinary account sharing', async () => {
    const earlier = asAccountId('managed:openrouter:earlier-workspace')
    await connect(MEMBER, 'earlier-key', earlier)
    await accounts.share(MEMBER, earlier, [SHARED_WITH_EVERYONE])
    expect(
      await oneShotApiKey(ports(), ADMIN, { provider: 'openrouter', accountId: OPENROUTER }),
    ).toBe('earlier-key')
    await accounts.share(MEMBER, earlier, [])
    expect(
      await oneShotApiKey(ports(), ADMIN, { provider: 'openrouter', accountId: OPENROUTER }),
    ).toBeUndefined()
  })

  it('an unconfigured subscription role does not spend an API key', async () => {
    expect(
      await oneShotApiKey(ports(), ADMIN, { provider: 'anthropic', accountId: CLAUDE_OAUTH }),
    ).toBeUndefined()
  })

  it('refuses a subscription token, which the one-shot client cannot send', async () => {
    await connect(ADMIN, 'sk-ant-oat', CLAUDE_OAUTH, { provider: 'anthropic', kind: 'oauth' })
    await expect(
      oneShotApiKey(ports(), ADMIN, { provider: 'anthropic', accountId: CLAUDE_OAUTH }),
    ).rejects.toBeInstanceOf(LlmConfigError)
  })

  it('a native (harness) account needs no key and reads none', async () => {
    await connect(ADMIN, 'admin-key')
    expect(
      await oneShotApiKey(ports(), ADMIN, {
        provider: 'codex',
        accountId: asAccountId('native:codex'),
      }),
    ).toBeUndefined()
  })
})
