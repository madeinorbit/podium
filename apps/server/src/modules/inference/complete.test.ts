/**
 * DIRECT INFERENCE THROUGH CREDENTIALS (credential management spec §9, epic
 * plan Task 12).
 *
 * Every call here goes through a real store and vault: the credential is
 * chosen, the resolver decides, and only the provider call reads the secret.
 * The provider is a fake `fetch` that records what it received. Planted
 * secrets are obviously fake, and each search for one first proves it can find
 * it (a canary).
 */

import { asUserId, type CredentialId, type UserId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { captureLogs } from '../../test-support/capture-logs'
import { openTestStore } from '../../test-support/open-test-store'
import { ACCESS_REFUSAL_MESSAGES } from '../credentials/access'
import { sealCredentialSecret } from '../credentials/vault'
import { CredentialRefusal } from '../sessions/launch-config'
import {
  type CompleteDeps,
  complete,
  INFERENCE_USAGE_MESSAGE,
  InferenceNotConfigured,
} from './complete'

const OWNER = asUserId('user:inference-owner')
const OTHER = asUserId('user:inference-other')
const NOW = '2026-11-13T00:00:00.000Z'

let store: SessionStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

async function open(): Promise<SessionStore> {
  store = await openTestStore(':memory:')
  return store
}

/** Obviously fake, distinct per provider and per credential. */
const planted = (provider: string, which: 'chosen' | 'other') =>
  `sk-FAKE-${provider}-${which}-planted-0000`

async function keyCredential(
  s: SessionStore,
  type: string,
  secret: string,
  opts: { owner?: UserId; label?: string; legacyKey?: string } = {},
): Promise<CredentialId> {
  const record = await s.credentials.insert({
    ownerUserId: opts.owner ?? OWNER,
    label: opts.label ?? `${type} ${secret.slice(-12)}`,
    type,
    ...(opts.legacyKey ? { legacyKey: opts.legacyKey } : {}),
  })
  expect(await sealCredentialSecret(s, record, secret, 0)).toBe(1)
  return record.id
}

interface Received {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** A provider that answers every call and records what it received. */
function fakeProvider(answer: (url: string) => { status?: number; body: unknown } = defaultAnswer) {
  const received: Received[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    received.push({
      url: u,
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    const a = answer(u)
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 })
  }) as typeof fetch
  return { received, fetchImpl }
}

function defaultAnswer(url: string): { body: unknown } {
  return url.includes('anthropic')
    ? {
        body: {
          content: [{ type: 'text', text: 'anthropic says hi' }],
          usage: { input_tokens: 11, output_tokens: 7 },
        },
      }
    : {
        body: {
          choices: [{ message: { content: 'chat says hi' } }],
          usage: { prompt_tokens: 13, completion_tokens: 5 },
        },
      }
}

const deps = (s: SessionStore, fetchImpl: typeof fetch, extra: Partial<CompleteDeps> = {}) =>
  ({ store: s, fetch: fetchImpl, ...extra }) satisfies CompleteDeps

const messages = [{ role: 'user' as const, content: 'hello' }]

const HTTP_ROUTES = [
  {
    type: 'anthropic.api-key',
    provider: 'anthropic',
    url: 'https://api.anthropic.com/v1/messages',
    header: (secret: string) => ['x-api-key', secret] as const,
  },
  {
    type: 'openai.api-key',
    provider: 'openai',
    url: 'https://api.openai.com/v1/chat/completions',
    header: (secret: string) => ['authorization', `Bearer ${secret}`] as const,
  },
  {
    type: 'openrouter.api-key',
    provider: 'openrouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    header: (secret: string) => ['authorization', `Bearer ${secret}`] as const,
  },
]

describe('complete: http routes', () => {
  it.each(
    HTTP_ROUTES,
  )('$type: the provider receives the chosen credential’s secret and not the other one', async ({
    type,
    provider,
    url,
    header,
  }) => {
    const s = await open()
    const chosen = await keyCredential(s, type, planted(provider, 'chosen'), {
      label: 'Second key',
    })
    await keyCredential(s, type, planted(provider, 'other'), { label: 'First key' })
    const { received, fetchImpl } = fakeProvider()

    const result = await complete(deps(s, fetchImpl), {
      credentialId: chosen,
      model: 'some-model',
      messages,
      actingUserId: OWNER,
    })

    expect(received).toHaveLength(1)
    const [name, value] = header(planted(provider, 'chosen'))
    expect(received[0]!.url).toBe(url)
    expect(received[0]!.headers[name]).toBe(value)
    expect(received[0]!.body.model).toBe('some-model')
    const wire = JSON.stringify(received)
    // Canary: the search finds the chosen secret where it is.
    expect(wire).toContain(planted(provider, 'chosen'))
    expect(wire).not.toContain(planted(provider, 'other'))
    expect(result.servedBy).toBe(chosen)
    expect(result.label).toBe('Second key')
    expect(result.text).toMatch(/says hi/)
    expect(JSON.stringify(result)).not.toContain(planted(provider, 'chosen'))
  })

  it('a ChatGPT plan credential is not configured where no keeper is bound', async () => {
    const s = await open()
    const plan = await keyCredential(s, 'openai.chatgpt-plan', planted('plan', 'chosen'))
    const { received, fetchImpl } = fakeProvider()
    await expect(
      complete(deps(s, fetchImpl), {
        credentialId: plan,
        model: 'm',
        messages,
        actingUserId: OWNER,
      }),
    ).rejects.toBeInstanceOf(InferenceNotConfigured)
    expect(received).toHaveLength(0)
  })

  it('a model of auto is not sent to a provider', async () => {
    const s = await open()
    const id = await keyCredential(s, 'anthropic.api-key', planted('anthropic', 'chosen'))
    const { received, fetchImpl } = fakeProvider()
    await expect(
      complete(deps(s, fetchImpl), {
        credentialId: id,
        model: 'auto',
        messages,
        actingUserId: OWNER,
      }),
    ).rejects.toBeInstanceOf(InferenceNotConfigured)
    expect(received).toHaveLength(0)
  })
})

describe('complete: refusals', () => {
  it('a credential the acting person may not use is refused with not-yours', async () => {
    const s = await open()
    const theirs = await keyCredential(s, 'anthropic.api-key', planted('anthropic', 'other'), {
      owner: OTHER,
    })
    const { received, fetchImpl } = fakeProvider()
    const call = complete(deps(s, fetchImpl), {
      credentialId: theirs,
      model: 'm',
      messages,
      actingUserId: OWNER,
    })
    await expect(call).rejects.toBeInstanceOf(CredentialRefusal)
    await expect(call).rejects.toMatchObject({
      refusal: 'not-yours',
      message: ACCESS_REFUSAL_MESSAGES['not-yours'],
    })
    expect(received).toHaveLength(0)
  })

  it('a credential with no direct-inference route is refused with wrong-type', async () => {
    const s = await open()
    const token = await keyCredential(s, 'anthropic.claude-token', planted('token', 'chosen'))
    const { received, fetchImpl } = fakeProvider()
    await expect(
      complete(deps(s, fetchImpl), {
        credentialId: token,
        model: 'm',
        messages,
        actingUserId: OWNER,
      }),
    ).rejects.toMatchObject({ refusal: 'wrong-type' })
    expect(received).toHaveLength(0)
  })

  // S5 (Claude Code's one-shot mode) has not been measured, so the route is
  // not declared (epic plan Task 12, item 3, the "S5 failed" variant).
  it('a Claude subscription login is refused with wrong-type: no harness one-shot route', async () => {
    const s = await open()
    const login = await s.credentials.insert({
      ownerUserId: OWNER,
      label: 'Claude login',
      type: 'anthropic.claude-login',
      identity: { fingerprint: 'fp-claude' },
    })
    const { received, fetchImpl } = fakeProvider()
    await expect(
      complete(deps(s, fetchImpl), {
        credentialId: login.id,
        model: 'm',
        messages,
        actingUserId: OWNER,
      }),
    ).rejects.toMatchObject({ refusal: 'wrong-type' })
    expect(received).toHaveLength(0)
  })
})

async function setRole(
  s: SessionStore,
  user: UserId,
  values: Record<string, unknown>,
): Promise<void> {
  await s.settings.applyPreferencePatch(user, values, NOW)
}

describe('complete: a role names a credential', () => {
  it('reads the role’s credentialId', async () => {
    const s = await open()
    const id = await keyCredential(s, 'anthropic.api-key', planted('anthropic', 'chosen'))
    await setRole(s, OWNER, {
      'roles.background.credentialId': id,
      'roles.background.model': 'claude-x',
    })
    const { received, fetchImpl } = fakeProvider()
    const result = await complete(deps(s, fetchImpl), {
      role: 'background',
      messages,
      actingUserId: OWNER,
    })
    expect(result.servedBy).toBe(id)
    expect(received[0]!.body.model).toBe('claude-x')
  })

  it('when both credentialId and the old accountId are set, credentialId wins', async () => {
    const s = await open()
    const chosen = await keyCredential(s, 'anthropic.api-key', planted('anthropic', 'chosen'))
    await keyCredential(s, 'openrouter.api-key', planted('openrouter', 'other'), {
      legacyKey: 'managed:openrouter',
    })
    await setRole(s, OWNER, {
      'roles.background.credentialId': chosen,
      'roles.background.accountId': 'managed:openrouter',
      'roles.background.model': 'claude-x',
    })
    const { received, fetchImpl } = fakeProvider()
    const result = await complete(deps(s, fetchImpl), {
      role: 'background',
      messages,
      actingUserId: OWNER,
    })
    expect(result.servedBy).toBe(chosen)
    expect(JSON.stringify(received)).not.toContain(planted('openrouter', 'other'))
  })

  it('an old accountId resolves to the credential imported from it', async () => {
    const s = await open()
    const imported = await keyCredential(s, 'anthropic.api-key', planted('anthropic', 'chosen'), {
      legacyKey: 'managed:anthropic',
    })
    await setRole(s, OWNER, {
      'roles.background.accountId': 'managed:anthropic',
      'roles.background.model': 'claude-x',
    })
    const { fetchImpl } = fakeProvider()
    const result = await complete(deps(s, fetchImpl), {
      role: 'background',
      messages,
      actingUserId: OWNER,
    })
    expect(result.servedBy).toBe(imported)
  })

  it('untouched role settings after the upgrade use the imported OpenRouter key', async () => {
    const s = await open()
    const imported = await keyCredential(s, 'openrouter.api-key', planted('openrouter', 'chosen'), {
      legacyKey: 'managed:openrouter',
    })
    const { received, fetchImpl } = fakeProvider()
    const result = await complete(deps(s, fetchImpl), {
      role: 'background',
      messages,
      actingUserId: OWNER,
    })
    expect(result.servedBy).toBe(imported)
    expect(received[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    // The background role's stored default model.
    expect(received[0]!.body.model).toBe('google/gemini-2.5-flash')
  })

  it('a role with no credential and nothing imported is not configured, and records no refusal', async () => {
    const s = await open()
    const { received, fetchImpl } = fakeProvider()
    await expect(
      complete(deps(s, fetchImpl), { role: 'background', messages, actingUserId: OWNER }),
    ).rejects.toBeInstanceOf(InferenceNotConfigured)
    expect(received).toHaveLength(0)
    const refusals = (await s.settingsAudit.list(100)).filter(
      (row) => row.command === 'credentials.refuse',
    )
    expect(refusals).toEqual([])
  })

  it('a harness login named by its old id without a fingerprint is no credential', async () => {
    const s = await open()
    await setRole(s, OWNER, { 'roles.background.accountId': 'native:claude-code' })
    const { fetchImpl } = fakeProvider()
    await expect(
      complete(deps(s, fetchImpl), { role: 'background', messages, actingUserId: OWNER }),
    ).rejects.toBeInstanceOf(InferenceNotConfigured)
  })

  it('an old accountId naming a key that no longer exists is refused with not-found', async () => {
    const s = await open()
    await setRole(s, OWNER, { 'roles.background.accountId': 'managed:openai' })
    const { received, fetchImpl } = fakeProvider()
    await expect(
      complete(deps(s, fetchImpl), { role: 'background', messages, actingUserId: OWNER }),
    ).rejects.toMatchObject({ refusal: 'not-found' })
    expect(received).toHaveLength(0)
  })

  it('a role credential the acting person may not use is refused with not-yours', async () => {
    const s = await open()
    const theirs = await keyCredential(s, 'anthropic.api-key', planted('anthropic', 'other'), {
      owner: OTHER,
    })
    await setRole(s, OWNER, {
      'roles.background.credentialId': theirs,
      'roles.background.model': 'claude-x',
    })
    const { received, fetchImpl } = fakeProvider()
    await expect(
      complete(deps(s, fetchImpl), { role: 'background', messages, actingUserId: OWNER }),
    ).rejects.toMatchObject({ refusal: 'not-yours' })
    expect(received).toHaveLength(0)
  })
})

describe('complete: the usage log line and the secret', () => {
  it('one info line per call carries the credential id, label, the call role, model, route and tokens', async () => {
    const s = await open()
    const id = await keyCredential(s, 'anthropic.api-key', planted('anthropic', 'chosen'), {
      label: 'Team key',
    })
    await setRole(s, OWNER, {
      'roles.background.credentialId': id,
      'roles.background.model': 'claude-x',
    })
    const { fetchImpl } = fakeProvider()
    const logs = captureLogs()
    try {
      await complete(deps(s, fetchImpl), { role: 'background', messages, actingUserId: OWNER })
      const usage = logs.records.filter((r) => r.msg === INFERENCE_USAGE_MESSAGE)
      expect(usage).toHaveLength(1)
      expect(usage[0]).toMatchObject({
        level: 'info',
        servedBy: id,
        label: 'Team key',
        actingUserId: OWNER,
        inferenceRole: 'background',
        model: 'claude-x',
        route: 'http:anthropic-messages',
        inputTokens: 11,
        outputTokens: 7,
      })
    } finally {
      logs.restore()
    }
  })

  it('the planted key is in no log line and no error, on success and on a provider error that echoes it', async () => {
    const s = await open()
    const secret = planted('openai', 'chosen')
    const id = await keyCredential(s, 'openai.api-key', secret)
    const ok = fakeProvider()
    const echo = fakeProvider(() => ({
      status: 401,
      body: { error: { message: `Incorrect API key provided: ${secret}` } },
    }))
    const logs = captureLogs()
    let failure: unknown
    try {
      await complete(deps(s, ok.fetchImpl), {
        credentialId: id,
        model: 'm',
        messages,
        actingUserId: OWNER,
      })
      failure = await complete(deps(s, echo.fetchImpl), {
        credentialId: id,
        model: 'm',
        messages,
        actingUserId: OWNER,
      }).catch((err: unknown) => err)
    } finally {
      logs.restore()
    }
    // Canary: the key reached the fake provider, so a search can see it.
    expect(JSON.stringify(ok.received)).toContain(secret)
    expect(logs.records.length).toBeGreaterThan(0)
    expect(logs.text()).not.toContain(secret)
    expect(JSON.stringify(logs.records)).not.toContain(secret)
    expect(failure).toBeInstanceOf(Error)
    const err = failure as Error
    expect(err.message).toContain('401')
    expect(err.message).toContain('[redacted]')
    expect(`${err.message}\n${err.stack ?? ''}`).not.toContain(secret)
  })
})

describe('complete: a provider that rejects the credential or reports a limit (Task 13)', () => {
  async function failing(status: number) {
    const s = await open()
    const id = await keyCredential(s, 'anthropic.api-key', planted('anthropic', 'chosen'))
    const { fetchImpl } = fakeProvider(() => ({
      status,
      body: { error: { type: 'authentication_error', message: 'invalid x-api-key' } },
    }))
    const reported: unknown[] = []
    const run = complete(
      {
        ...deps(s, fetchImpl),
        onCredentialFailure: async (failure) => {
          reported.push(failure)
        },
      },
      { credentialId: id, model: 'some-model', messages, actingUserId: OWNER },
    )
    await expect(run).rejects.toThrow(new RegExp(`${status}`))
    return { id, reported }
  }

  it('a 401 is reported as rejected, for the acting person, without the key', async () => {
    const { id, reported } = await failing(401)
    expect(reported).toEqual([
      expect.objectContaining({ credentialId: id, failure: 'rejected', actorUserId: OWNER }),
    ])
    expect(JSON.stringify(reported)).toContain('invalid x-api-key')
    expect(JSON.stringify(reported)).not.toContain(planted('anthropic', 'chosen'))
  })

  it('a 429 is reported as a limit', async () => {
    const { reported } = await failing(429)
    expect(reported).toEqual([expect.objectContaining({ failure: 'limit' })])
  })

  it('a server error says nothing about the credential', async () => {
    const { reported } = await failing(500)
    expect(reported).toEqual([])
  })
})
