import { describe, expect, it } from 'vitest'
import { ACCESS_CARRYING_CONTROL_TYPES, ControlMessage } from './control'
import { DaemonMessage } from './daemon'
import {
  CredentialRemoveRequestMessage,
  CredentialRemoveResultMessage,
  DEFAULT_HOME_ID,
  HOME_HARNESSES,
  HomeEnsureRequestMessage,
  HomeEnsureResultMessage,
  HomeRemoveRequestMessage,
  HomeRemoveResultMessage,
  homeIdFor,
  parseHomeId,
} from './homes'

const CRED = 'cred_0b6f6f5e-2d43-4f7a-9d55-6a1f7c3e0e11'

describe('home ids', () => {
  it('round-trips a credential and harness', () => {
    const id = homeIdFor(CRED, 'codex')
    expect(id).toBe(`${CRED}:codex`)
    expect(parseHomeId(id)).toEqual({ credentialId: CRED, harness: 'codex' })
  })

  it('names no Podium home for the default directory', () => {
    expect(parseHomeId(DEFAULT_HOME_ID)).toBeNull()
  })

  it('refuses ids that could leave the homes directory or name a harness without homes', () => {
    for (const bad of [
      '../x:codex',
      'cred_../..:codex',
      `${CRED}:grok`,
      `${CRED}:codex:extra`,
      `${CRED}/codex`,
      'cred_:codex',
      `${CRED}:`,
    ]) {
      expect(parseHomeId(bad), bad).toBeNull()
    }
    expect(() => homeIdFor('../x', 'codex')).toThrow()
  })

  it('holds homes for the two harnesses that name their directory by a variable', () => {
    expect([...HOME_HARNESSES]).toEqual(['claude-code', 'codex'])
  })
})

describe('home messages', () => {
  it('parse as control and daemon frames', () => {
    const ensure = {
      type: 'homeEnsureRequest',
      requestId: 'r1',
      credentialId: CRED,
      harness: 'claude-code',
    }
    const remove = { type: 'homeRemoveRequest', requestId: 'r2', homeId: homeIdFor(CRED, 'codex') }
    const credentialRemove = {
      type: 'credentialRemoveRequest',
      requestId: 'r3',
      harness: 'codex',
      fingerprint: 'fp',
    }
    expect(HomeEnsureRequestMessage.parse(ensure)).toEqual(ensure)
    expect(ControlMessage.parse(ensure)).toEqual(ensure)
    expect(ControlMessage.parse(remove)).toEqual(remove)
    expect(ControlMessage.parse(credentialRemove)).toEqual(credentialRemove)
    expect(HomeRemoveRequestMessage.parse(remove)).toEqual(remove)
    expect(CredentialRemoveRequestMessage.parse(credentialRemove)).toEqual(credentialRemove)

    const ensured = {
      type: 'homeEnsureResult',
      requestId: 'r1',
      ok: true,
      homeId: homeIdFor(CRED, 'claude-code'),
      created: true,
    }
    const refused = { type: 'homeEnsureResult', requestId: 'r1', ok: false, error: 'no' }
    const removed = {
      type: 'homeRemoveResult',
      requestId: 'r2',
      ok: true,
      removed: true,
      freedBytes: 12,
    }
    const changed = { type: 'credentialRemoveResult', requestId: 'r3', outcome: 'changed' }
    expect(HomeEnsureResultMessage.parse(ensured)).toEqual(ensured)
    expect(HomeEnsureResultMessage.parse(refused)).toEqual(refused)
    expect(HomeRemoveResultMessage.parse(removed)).toEqual(removed)
    expect(CredentialRemoveResultMessage.parse(changed)).toEqual(changed)
    for (const frame of [ensured, refused, removed, changed]) {
      expect(DaemonMessage.parse(frame)).toEqual(frame)
    }
  })

  it('refuses a harness without homes and a hostile credential id', () => {
    expect(() =>
      HomeEnsureRequestMessage.parse({
        type: 'homeEnsureRequest',
        requestId: 'r',
        credentialId: CRED,
        harness: 'grok',
      }),
    ).toThrow()
    expect(() =>
      HomeEnsureRequestMessage.parse({
        type: 'homeEnsureRequest',
        requestId: 'r',
        credentialId: '../../etc',
        harness: 'codex',
      }),
    ).toThrow()
  })

  it('never carries a secret, so none is excluded from logging by type', () => {
    for (const type of ['homeEnsureRequest', 'homeRemoveRequest', 'credentialRemoveRequest']) {
      expect(ACCESS_CARRYING_CONTROL_TYPES.has(type as never)).toBe(false)
    }
  })
})
