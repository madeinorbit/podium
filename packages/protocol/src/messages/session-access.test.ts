import { describe, expect, it } from 'vitest'
import {
  ACCESS_CARRYING_CONTROL_TYPES,
  ControlMessage,
  carriesAccess,
  carriesSecret,
  SECRET_CARRYING_CONTROL_TYPES,
} from './control.js'
import { DaemonMessage, daemonFrameCarriesSecret, SECRET_CARRYING_DAEMON_TYPES } from './daemon.js'
import { AccessField, CAP_SESSION_ACCESS, SessionAccessRefreshMessage } from './session-access.js'
import { SpawnMessage } from './terminal.js'

const PLANTED = 'sk-test-planted-not-a-real-key'

const envAccess = {
  credentialId: 'cred_00000000-0000-4000-8000-000000000005',
  delivery: { kind: 'env', variable: 'ANTHROPIC_API_KEY', secret: PLANTED },
} as const

/** Every arm of the control union, with the keys of its object shape. */
function controlArms(): { type: string; keys: string[] }[] {
  return armsOf(ControlMessage.options)
}

/** Every arm of the daemon-to-server union, with the keys of its object shape. */
function daemonArms(): { type: string; keys: string[] }[] {
  return armsOf(DaemonMessage.options)
}

function armsOf(options: readonly { shape: unknown }[]): { type: string; keys: string[] }[] {
  return options.map((option) => {
    const shape = option.shape as Record<string, unknown> & { type: { value: string } }
    return { type: shape.type.value, keys: Object.keys(shape) }
  })
}

/** A key that holds a secret: an access, the vault's data key, or login-file bundles. */
const SECRET_KEYS = ['access', 'vaultDataKey', 'bundles']

describe('AccessField', () => {
  it('round-trips an env delivery and a home delivery', () => {
    expect(AccessField.parse(envAccess)).toEqual(envAccess)
    const home = { credentialId: envAccess.credentialId, delivery: { kind: 'home', homeId: 'h1' } }
    expect(AccessField.parse(home)).toEqual(home)
  })

  it('refuses an env delivery without its secret or variable', () => {
    expect(
      AccessField.safeParse({ ...envAccess, delivery: { kind: 'env', variable: 'X' } }).success,
    ).toBe(false)
    expect(
      AccessField.safeParse({ ...envAccess, delivery: { kind: 'env', secret: PLANTED } }).success,
    ).toBe(false)
  })

  it('names the capability a daemon offers', () => {
    expect(CAP_SESSION_ACCESS).toBe('session.access.v1')
  })
})

describe('messages that carry access', () => {
  it('a spawn frame carries it, and one without it still parses', () => {
    const base = {
      type: 'spawn',
      sessionId: '00000000-0000-4000-8000-000000000001',
      agentKind: 'claude-code',
      cwd: '/w',
      geometry: { cols: 80, rows: 24 },
    }
    expect(SpawnMessage.parse({ ...base, access: envAccess }).access).toEqual(envAccess)
    expect(SpawnMessage.parse(base).access).toBeUndefined()
  })

  it('sessionAccessRefresh is a control frame', () => {
    const refresh = {
      type: 'sessionAccessRefresh',
      sessionId: '00000000-0000-4000-8000-000000000001',
      access: envAccess,
    }
    expect(SessionAccessRefreshMessage.parse(refresh)).toEqual(refresh)
    expect(ControlMessage.parse(refresh)).toEqual(refresh)
  })

  it('the headless turn request carries access and no longer an env', () => {
    const arm = controlArms().find((a) => a.type === 'runtimeSendRequest')
    expect(arm?.keys).toContain('access')
    expect(arm?.keys).not.toContain('env')
  })

  it('the excluded-from-logging list is exactly the control types whose shape has access', () => {
    const withAccess = controlArms()
      .filter((arm) => arm.keys.includes('access'))
      .map((arm) => arm.type)
      .sort()
    // Canary: the derivation finds the spawn frame, so an empty list would mean something.
    expect(withAccess).toContain('spawn')
    expect([...ACCESS_CARRYING_CONTROL_TYPES].sort()).toEqual(withAccess)
    for (const type of withAccess) expect(carriesAccess(type)).toBe(true)
    expect(carriesAccess('kill')).toBe(false)
    expect(carriesAccess('not-a-type')).toBe(false)
  })

  it('the never-logged list is exactly the control types whose shape has access, a vault key or login bundles', () => {
    const withSecret = controlArms()
      .filter((arm) => arm.keys.some((key) => SECRET_KEYS.includes(key)))
      .map((arm) => arm.type)
      .sort()
    // Canaries: the derivation finds every kind of carrier.
    expect(withSecret).toContain('spawn')
    expect(withSecret).toContain('serverTransferPromoteRequest')
    expect(withSecret).toContain('credentialInstallRequest')
    expect([...SECRET_CARRYING_CONTROL_TYPES].sort()).toEqual(withSecret)
    for (const type of withSecret) expect(carriesSecret(type)).toBe(true)
    expect(carriesSecret('serverTransferAbortRequest')).toBe(false)
    expect(carriesSecret('not-a-type')).toBe(false)
  })

  it('the daemon frames never logged are exactly those whose shape has a secret key', () => {
    const withSecret = daemonArms()
      .filter((arm) => arm.keys.some((key) => SECRET_KEYS.includes(key)))
      .map((arm) => arm.type)
      .sort()
    // Canary: the login-file export is found, so an empty list would mean something.
    expect(withSecret).toContain('credentialExportResult')
    expect([...SECRET_CARRYING_DAEMON_TYPES].sort()).toEqual(withSecret)
    for (const type of withSecret) expect(daemonFrameCarriesSecret(type)).toBe(true)
    expect(daemonFrameCarriesSecret('credentialInstallResult')).toBe(false)
    expect(daemonFrameCarriesSecret('not-a-type')).toBe(false)
  })
})
