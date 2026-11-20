/**
 * The binary follows the home (POD-7270, managed installs §4.2 and §6.1): a
 * context in the person's own folder holds the person's install and never
 * Podium's; one for a home Podium made holds Podium's when there is one.
 * Every installation says which it is.
 */
import type { CommandEnvironment } from '@podium/runtime/command-environment'
import { describe, expect, it } from 'vitest'
import type { HarnessExecutableSnapshot } from './executable-runtime.js'
import {
  harnessChildEnv,
  harnessContext,
  harnessDriverContext,
  harnessInstallation,
  harnessInstallationFor,
  installationAtPath,
  withHarnessHome,
} from './harness-context.js'
import type { ResolvedHarnessExecutable } from './inventory/build-inventory.js'

const HOME = '/accounts/alice'
const PODIUM_HOME = { id: 'cred_1:codex', dir: '/state/homes/cred_1/codex' }

const EXTERNAL: ResolvedHarnessExecutable = {
  kind: 'codex',
  path: '/usr/local/bin/codex',
  version: 'codex-cli 0.160.0',
  generation: 3,
}
const MANAGED: ResolvedHarnessExecutable = {
  kind: 'codex',
  path: '/state/harnesses/codex/2-0.167.2/codex',
  version: 'codex-cli 0.167.2',
  generation: 3,
  release: 2,
}

function snapshot(
  external: ResolvedHarnessExecutable[],
  managed: ResolvedHarnessExecutable[],
): HarnessExecutableSnapshot {
  const commandEnvironment: CommandEnvironment = {
    env: { PATH: '/usr/bin:/bin', HOME: '/home/operator' },
    pathEntries: ['/usr/bin', '/bin'],
    source: 'inherited',
    generation: 3,
    machineHome: '/home/operator',
    loginShell: '/bin/sh',
    resolve: () => undefined,
  }
  return {
    executables: new Map(external.map((e) => [e.kind, e])),
    managed: new Map(managed.map((e) => [e.kind, e])),
    commandEnvironment,
  }
}

describe('installation provenance', () => {
  it('marks the person’s install external and Podium’s managed', () => {
    const both = snapshot([EXTERNAL], [MANAGED])
    expect(harnessInstallation(both, 'codex')).toEqual({
      kind: 'codex',
      executable: EXTERNAL.path,
      version: EXTERNAL.version,
      generation: 3,
      provenance: 'external',
    })
    expect(harnessInstallation(both, 'codex', 'podium')).toEqual({
      kind: 'codex',
      executable: MANAGED.path,
      version: MANAGED.version,
      generation: 3,
      provenance: 'managed',
    })
  })

  it('gives the person’s folder only the person’s install, never Podium’s', () => {
    const onlyManaged = snapshot([], [MANAGED])
    expect(harnessInstallationFor(onlyManaged, 'codex', 'person')).toBeUndefined()
    expect(() => harnessContext(onlyManaged, 'codex', HOME)).toThrow(
      /has only Podium's install .* never runs in your own codex folder/,
    )
  })

  it('gives a home Podium made Podium’s install when present, else the person’s', () => {
    expect(harnessInstallation(snapshot([EXTERNAL], []), 'codex', 'podium').provenance).toBe(
      'external',
    )
    expect(harnessInstallation(snapshot([], [MANAGED]), 'codex', 'podium').executable).toBe(
      MANAGED.path,
    )
    expect(() => harnessInstallation(snapshot([], []), 'codex', 'podium')).toThrow(/not installed/)
  })

  it('keeps the side through a driver context that runs the harness’s own binary', () => {
    const context = harnessDriverContext(
      snapshot([EXTERNAL], [MANAGED]),
      'codex',
      HOME,
      'codex-app-server',
      'podium',
    )
    expect(context.installation.provenance).toBe('managed')
  })

  it('names a pinned path’s provenance by the managed release it is', () => {
    const both = snapshot([EXTERNAL], [MANAGED])
    expect(installationAtPath(both, 'codex', MANAGED.path)).toMatchObject({
      provenance: 'managed',
      version: MANAGED.version,
    })
    expect(installationAtPath(both, 'codex', '/elsewhere/codex')).toMatchObject({
      provenance: 'external',
      version: EXTERNAL.version,
    })
  })
})

describe('the child env refuses Podium’s install in the person’s folder (M9)', () => {
  it('refuses a managed installation with no Podium home', () => {
    const context = harnessContext(snapshot([EXTERNAL], [MANAGED]), 'codex', HOME, 'podium')
    expect(() => harnessChildEnv(context, {})).toThrow(/runs only in a home Podium made/)
  })

  it('runs a managed installation in a home Podium made', () => {
    const context = withHarnessHome(
      harnessContext(snapshot([EXTERNAL], [MANAGED]), 'codex', HOME, 'podium'),
      PODIUM_HOME,
    )
    expect(context.installation.executable).toBe(MANAGED.path)
    expect(harnessChildEnv(context, {}).env.CODEX_HOME).toBe(PODIUM_HOME.dir)
  })
})
