import { harnessChildEnv, harnessContext, harnessHomeVariable } from '@podium/harness'
import { asSessionId, BUILTIN_HARNESS_KINDS } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { inSessionHome } from '../session-harness-context'
import { testHarnessSnapshot } from '../test-support/harness-snapshot'

const kinds = BUILTIN_HARNESS_KINDS.filter((kind) => !harnessHomeVariable(kind))
describe('section 4.7 default-folder managed launches', () => {
  it.each(
    kinds,
  )('%s selects the managed binary on a machine without a personal install', (kind) => {
    const base = testHarnessSnapshot({ [kind]: `/personal/${kind}` })
    const snapshot = {
      ...base,
      managed: new Map([
        [
          kind,
          {
            kind,
            path: `/state/harnesses/${kind}/1-current/tool`,
            version: '2.0.0',
            generation: 1,
            release: 1,
          },
        ],
      ]),
    }
    const context = inSessionHome(
      {},
      undefined,
      kind,
      (side) => harnessContext(snapshot, kind, '/account', side),
      { managedInstall: () => true, externalInstall: () => false },
    )
    expect(context.installation.provenance).toBe('managed')
    expect(context.harnessHome).toBeUndefined()
    expect(() => harnessChildEnv(context, { wiringEnv: {} })).not.toThrow()
  })
  it.each(
    kinds,
  )('%s keeps an own-login session on the personal binary if both appear later', (kind) => {
    const snapshot = testHarnessSnapshot({ [kind]: `/personal/${kind}` })
    const context = inSessionHome(
      {},
      asSessionId('own-login'),
      kind,
      (side) => harnessContext(snapshot, kind, '/account', side),
      { managedInstall: () => true, externalInstall: () => true },
    )
    expect(context.installation.provenance).toBe('external')
  })
})
