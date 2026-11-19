// ONE LOGIN PER HOME IN THE INVENTORY (credential management §10; epic plan
// Task 8, acceptance 5). Planted logins are obviously fake: `.invalid`
// addresses and no real token.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fingerprintForLoginIdentity } from '@podium/harness'
import type { Inventory } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withHomeLogins } from './logins'
import { HomeRegistry } from './registry'

const CRED_A = 'cred_aaaaaaaa-0000-4000-8000-0000000000a5'
const CRED_B = 'cred_bbbbbbbb-0000-4000-8000-0000000000b5'
const PERSON = 'person@example.invalid'
const SECOND = 'second-account@example.invalid'

let root: string
let person: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-home-logins-'))
  person = join(root, 'person')
  mkdirSync(person)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const inventory = (): Inventory =>
  ({
    os: 'linux',
    arch: 'x64',
    agents: [
      {
        kind: 'claude-code',
        installed: true,
        login: {
          state: 'in',
          account: PERSON,
          identity: { fingerprint: fingerprintForLoginIdentity(PERSON), email: PERSON },
        },
      },
      { kind: 'codex', installed: true, login: { state: 'out' } },
      { kind: 'opencode', installed: true, login: { state: 'unknown' } },
    ],
    tools: [],
  }) as unknown as Inventory

function claudeLoginIn(dir: string, email: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'FAKE-access',
        refreshToken: 'FAKE-refresh',
        expiresAt: Date.now() + 3_600_000,
      },
    }),
  )
  writeFileSync(
    join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email } }),
  )
}

describe('withHomeLogins', () => {
  it('reports default first, then one entry per home, each from its own directory (acceptance 5)', async () => {
    // The person's own login lives in the default places.
    claudeLoginIn(join(person, '.claude'), PERSON)
    writeFileSync(
      join(person, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: PERSON } }),
    )
    const homes = new HomeRegistry({ root: join(root, 'homes') })
    const a = (await homes.ensure(CRED_A, 'claude-code')).home
    const b = (await homes.ensure(CRED_B, 'claude-code')).home
    const c = (await homes.ensure(CRED_A, 'codex')).home
    claudeLoginIn(a.dir, SECOND)

    const out = withHomeLogins(inventory(), homes.list(), { home: person, env: { HOME: person } })
    const claude = out.agents.find((agent) => agent.kind === 'claude-code')
    expect(claude?.logins?.map((login) => login.homeId)).toEqual([
      'default',
      ...[a.homeId, b.homeId].sort(),
    ])
    const byId = new Map(claude?.logins?.map((login) => [login.homeId, login]))
    expect(byId.get('default')).toMatchObject({
      state: 'in',
      identity: { fingerprint: fingerprintForLoginIdentity(PERSON) },
    })
    // The home reports the account signed in there, never the person's.
    expect(byId.get(a.homeId)).toMatchObject({
      state: 'in',
      identity: { fingerprint: fingerprintForLoginIdentity(SECOND), email: SECOND },
    })
    expect(byId.get(b.homeId)?.state).toBe('out')
    expect(byId.get(b.homeId)?.identity).toBeUndefined()

    const codex = out.agents.find((agent) => agent.kind === 'codex')
    expect(codex?.logins?.map((login) => login.homeId)).toEqual(['default', c.homeId])
    // A fresh home holds no login: whatever the detector calls it, never `in`.
    expect(codex?.logins?.[1]?.state).not.toBe('in')
    // A harness without homes is reported as before.
    expect(out.agents.find((agent) => agent.kind === 'opencode')).not.toHaveProperty('logins')
    // The inventory's own `login` is untouched.
    expect(claude?.login).toEqual(inventory().agents[0]?.login)
  })

  it('with no homes, still names the default directory', () => {
    const out = withHomeLogins(inventory(), [], { home: person, env: {} })
    expect(out.agents.find((agent) => agent.kind === 'codex')?.logins).toEqual([
      { homeId: 'default', state: 'out' },
    ])
  })
})
