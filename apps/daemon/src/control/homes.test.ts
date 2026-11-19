// THE HOME REQUESTS ON THE DAEMON (credential management §8 cleanup and §10
// homes; epic plan Task 8, acceptance 1 and 8, and Task 13's removal of a
// propagated login file).

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fingerprintForLoginIdentity } from '@podium/harness'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HomeRegistry } from '../homes/registry'
import type { DaemonContext } from './context'
import { homeHandlers } from './homes'

const CRED = 'cred_eeeeeeee-0000-4000-8000-000000000005'
/** Obviously fake logins: an address under `.invalid` and no real token. */
const PERSON_A = 'person-a@example.invalid'
const PERSON_B = 'person-b@example.invalid'

let root: string
let person: string
let sent: DaemonMessage[]
let removed: string[]

function context(): DaemonContext {
  return {
    send: (frame: DaemonMessage) => void sent.push(frame),
    homeDir: person,
    homes: new HomeRegistry({
      root: join(root, 'homes'),
      beforeRemove: async (home) => void removed.push(home.homeId),
    }),
  } as unknown as DaemonContext
}

async function reply<T extends DaemonMessage['type']>(
  type: T,
): Promise<Extract<DaemonMessage, { type: T }>> {
  const start = Date.now()
  for (;;) {
    const frame = sent.find((candidate) => candidate.type === type)
    if (frame) return frame as Extract<DaemonMessage, { type: T }>
    if (Date.now() - start > 5_000) throw new Error(`no ${type}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** A Claude Code login in the person's own directory, as propagation leaves it. */
function plantClaudeLogin(email: string): string {
  mkdirSync(join(person, '.claude'), { recursive: true })
  const file = join(person, '.claude', '.credentials.json')
  writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'FAKE-not-a-token' } }))
  writeFileSync(
    join(person, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email } }),
  )
  return file
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-home-handlers-'))
  person = join(root, 'person')
  mkdirSync(person)
  sent = []
  removed = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('homeEnsureRequest', () => {
  it('twice for one credential and harness answers the same owner-only home (acceptance 1)', async () => {
    const ctx = context()
    homeHandlers.homeEnsureRequest(ctx, {
      type: 'homeEnsureRequest',
      requestId: 'e1',
      credentialId: CRED,
      harness: 'codex',
    })
    const first = await reply('homeEnsureResult')
    sent = []
    homeHandlers.homeEnsureRequest(ctx, {
      type: 'homeEnsureRequest',
      requestId: 'e2',
      credentialId: CRED,
      harness: 'codex',
    })
    const second = await reply('homeEnsureResult')
    expect(first).toEqual({
      type: 'homeEnsureResult',
      requestId: 'e1',
      ok: true,
      homeId: `${CRED}:codex`,
      created: true,
    })
    expect(second).toMatchObject({
      requestId: 'e2',
      ok: true,
      homeId: `${CRED}:codex`,
      created: false,
    })
    const dir = join(root, 'homes', CRED, 'codex')
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('answers not ok on a daemon built without homes', async () => {
    const ctx = { ...context(), homes: undefined } as unknown as DaemonContext
    homeHandlers.homeEnsureRequest(ctx, {
      type: 'homeEnsureRequest',
      requestId: 'e3',
      credentialId: CRED,
      harness: 'claude-code',
    })
    expect(await reply('homeEnsureResult')).toMatchObject({ requestId: 'e3', ok: false })
  })
})

describe('homeRemoveRequest', () => {
  it('stops what runs in the home, then deletes it (acceptance 8)', async () => {
    const ctx = context()
    const { home } = await (ctx.homes as HomeRegistry).ensure(CRED, 'claude-code')
    writeFileSync(join(home.dir, 'blob'), Buffer.alloc(2048))
    homeHandlers.homeRemoveRequest(ctx, {
      type: 'homeRemoveRequest',
      requestId: 'r1',
      homeId: home.homeId,
    })
    const result = await reply('homeRemoveResult')
    expect(result).toMatchObject({ requestId: 'r1', ok: true, removed: true })
    expect(result.freedBytes).toBeGreaterThanOrEqual(2048)
    expect(removed).toEqual([home.homeId])
    expect(existsSync(home.dir)).toBe(false)
  })

  it('refuses the default home and leaves the person’s directory alone (acceptance 8)', async () => {
    const file = plantClaudeLogin(PERSON_A)
    homeHandlers.homeRemoveRequest(context(), {
      type: 'homeRemoveRequest',
      requestId: 'r2',
      homeId: 'default',
    })
    const result = await reply('homeRemoveResult')
    expect(result).toMatchObject({ requestId: 'r2', ok: false })
    expect(String(result.error)).toMatch(/default/)
    expect(existsSync(file)).toBe(true)
    expect(removed).toEqual([])
  })

  it('confirms a home that is already gone', async () => {
    homeHandlers.homeRemoveRequest(context(), {
      type: 'homeRemoveRequest',
      requestId: 'r3',
      homeId: `${CRED}:codex`,
    })
    expect(await reply('homeRemoveResult')).toMatchObject({ ok: true, removed: false })
  })
})

describe('credentialRemoveRequest (a login file propagation copied)', () => {
  it('removes the login file when its fingerprint still matches', async () => {
    const file = plantClaudeLogin(PERSON_A)
    homeHandlers.credentialRemoveRequest(context(), {
      type: 'credentialRemoveRequest',
      requestId: 'c1',
      harness: 'claude-code',
      fingerprint: fingerprintForLoginIdentity(PERSON_A),
    })
    expect(await reply('credentialRemoveResult')).toEqual({
      type: 'credentialRemoveResult',
      requestId: 'c1',
      outcome: 'removed',
    })
    expect(existsSync(file)).toBe(false)
    // Only the allowlisted login file: the person's state file stays.
    expect(existsSync(join(person, '.claude.json'))).toBe(true)
  })

  it('leaves a login whose fingerprint changed in place and reports it', async () => {
    const file = plantClaudeLogin(PERSON_B)
    const before = readFileSync(file, 'utf8')
    homeHandlers.credentialRemoveRequest(context(), {
      type: 'credentialRemoveRequest',
      requestId: 'c2',
      harness: 'claude-code',
      fingerprint: fingerprintForLoginIdentity(PERSON_A),
    })
    expect(await reply('credentialRemoveResult')).toMatchObject({
      requestId: 'c2',
      outcome: 'changed',
    })
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('reports a login file that is not there as absent', async () => {
    homeHandlers.credentialRemoveRequest(context(), {
      type: 'credentialRemoveRequest',
      requestId: 'c3',
      harness: 'codex',
      fingerprint: 'f'.repeat(64),
    })
    expect(await reply('credentialRemoveResult')).toMatchObject({
      requestId: 'c3',
      outcome: 'absent',
    })
  })

  it('never reads a Podium home: a matching login there is not the propagated file', async () => {
    const ctx = context()
    const { home } = await (ctx.homes as HomeRegistry).ensure(CRED, 'claude-code')
    const inHome = join(home.dir, '.credentials.json')
    writeFileSync(inHome, '{"claudeAiOauth":{"accessToken":"FAKE"}}')
    writeFileSync(
      join(home.dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: PERSON_A } }),
    )
    homeHandlers.credentialRemoveRequest(ctx, {
      type: 'credentialRemoveRequest',
      requestId: 'c4',
      harness: 'claude-code',
      fingerprint: fingerprintForLoginIdentity(PERSON_A),
    })
    expect(await reply('credentialRemoveResult')).toMatchObject({ outcome: 'absent' })
    expect(existsSync(inHome)).toBe(true)
  })
})
