/**
 * THE BINARY FOLLOWS THE HOME (POD-7270, managed installs §4.2 and §6.1).
 *
 * The table: the four machine states of §4.2 against the three kinds of
 * home a context can be built for. A context in the person's own folder never
 * holds Podium's install; a home Podium made holds Podium's when there is one,
 * else the person's.
 *
 * Then the per-home callers, with both installs present: the model probe, the
 * sign-out command and the Codex daemon stop for a home Podium made run
 * Podium's executable. (A home's login and quota reads run no executable at
 * all: they read the home's files and the provider's API.)
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HarnessContext,
  ResolvedHarnessExecutable,
  ResolvedHarnessInventory,
} from '@podium/harness'
import { asSessionId, type BuiltinHarnessKind, type SessionId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryMarkers, SessionAccessStore } from '../control/access'
import type { DaemonContext } from '../control/context'
import { managementContextFor } from '../harness-management'
import {
  buildSessionHarnessContext,
  driverHarnessContextFrom,
  sessionHomeSide,
} from '../session-harness-context'
import { testHarnessSnapshot } from '../test-support/harness-snapshot'
import { homeModelProbe } from './probes'
import { HomeRegistry } from './registry'
import { signOutOfHome } from './sign-out'
import { homeExecutable, stopHome } from './stop'

/** Two homes Podium made for credentials, as the inventory task left them. The
 *  Podium home proper (`homes/podium/<harness>`, a passed-in credential on a
 *  machine with a managed install) is covered in `podium-home.test.ts`. */
const PASSED_IN = 'cred_eeeeeeee-0000-4000-8000-0000000000c1'
const SIGNED_IN = 'cred_ffffffff-0000-4000-8000-0000000000c2'

const PERSON_CODEX = '/usr/local/bin/codex'
const MANAGED_CODEX = '/state/harnesses/codex/1-0.167.2/codex'

let root: string
let homes: HomeRegistry

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-managed-homes-'))
  homes = new HomeRegistry({ root: join(root, 'state', 'homes') })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

type MachineState = 'only-person' | 'none' | 'only-managed' | 'both'

/** One machine state as an inventory snapshot for Codex. */
function snapshotFor(state: MachineState): ResolvedHarnessInventory {
  const base = testHarnessSnapshot({}, 1, {})
  const person = new Map(base.executables)
  const managed = new Map<BuiltinHarnessKind, ResolvedHarnessExecutable>()
  person.delete('codex')
  if (state === 'only-person' || state === 'both')
    person.set('codex', { kind: 'codex', path: PERSON_CODEX, version: '0.160.0', generation: 1 })
  if (state === 'only-managed' || state === 'both')
    managed.set('codex', {
      kind: 'codex',
      path: MANAGED_CODEX,
      version: '0.167.2',
      generation: 1,
      release: 1,
    })
  return { ...base, executables: person, managed }
}

type HomeKind = 'person-folder' | 'podium-home' | 'sign-in-folder'

/** A session whose access puts it in that kind of home. */
async function sessionIn(access: SessionAccessStore, kind: HomeKind): Promise<SessionId> {
  const sessionId = asSessionId(`s-${kind}`)
  if (kind === 'person-folder') return sessionId
  const credentialId = kind === 'podium-home' ? PASSED_IN : SIGNED_IN
  const { home } = await homes.ensure(credentialId, 'codex')
  access.remember(
    sessionId,
    { credentialId, delivery: { kind: 'home', homeId: home.homeId } },
    'codex',
  )
  return sessionId
}

function contextSource(access: SessionAccessStore, snapshot: ResolvedHarnessInventory) {
  return {
    homeDir: join(root, 'person'),
    access,
    homes,
    harnessRuntime: { current: async () => snapshot },
  } as unknown as DaemonContext
}

describe('the binary follows the home: four machine states × three home kinds (§4.2)', () => {
  const expected: Record<MachineState, Record<HomeKind, 'external' | 'managed' | 'refused'>> = {
    'only-person': {
      'person-folder': 'external',
      'podium-home': 'external',
      'sign-in-folder': 'external',
    },
    none: { 'person-folder': 'refused', 'podium-home': 'refused', 'sign-in-folder': 'refused' },
    'only-managed': {
      'person-folder': 'refused',
      'podium-home': 'managed',
      'sign-in-folder': 'managed',
    },
    both: { 'person-folder': 'external', 'podium-home': 'managed', 'sign-in-folder': 'managed' },
  }
  const cases = Object.entries(expected).flatMap(([state, row]) =>
    Object.entries(row).map(([home, outcome]) => ({
      state: state as MachineState,
      home: home as HomeKind,
      outcome,
    })),
  )

  it.each(cases)('$state, $home → $outcome', async ({ state, home, outcome }) => {
    const access = new SessionAccessStore({ markers: memoryMarkers() })
    const sessionId = await sessionIn(access, home)
    const snapshot = snapshotFor(state)
    const ctx = contextSource(access, snapshot)
    const builds: Array<() => Promise<HarnessContext> | HarnessContext> = [
      () => driverHarnessContextFrom(ctx, snapshot, 'codex', undefined, sessionId),
      () => buildSessionHarnessContext(ctx, 'codex', sessionId),
    ]
    for (const build of builds) {
      if (outcome === 'refused') {
        await expect(Promise.resolve().then(build)).rejects.toThrow(/codex/)
        continue
      }
      const context = await build()
      expect(context.installation.provenance).toBe(outcome)
      expect(context.installation.executable).toBe(
        outcome === 'managed' ? MANAGED_CODEX : PERSON_CODEX,
      )
      // The home the context runs in matches the side it got.
      expect(context.harnessHome !== undefined).toBe(home !== 'person-folder')
      if (home === 'person-folder') expect(context.installation.provenance).not.toBe('managed')
    }
    expect(sessionHomeSide(ctx, sessionId, 'codex')).toBe(
      home === 'person-folder' ? 'person' : 'podium',
    )
  })
})

describe('per-home commands run the home’s install when both are present (§6.1)', () => {
  /** A fake Codex that logs which install ran, with what, in which home. */
  function fakeCodex(name: string, log: string): string {
    const bin = join(root, name)
    mkdirSync(bin, { recursive: true })
    const path = join(bin, 'codex')
    writeFileSync(path, `#!/bin/sh\necho "${name} $* home=$CODEX_HOME" >> "${log}"\n`)
    chmodSync(path, 0o755)
    return path
  }

  it('the home model probe runs Podium’s Codex in the home', async () => {
    const { home } = await homes.ensure(SIGNED_IN, 'codex')
    const snapshot = testHarnessSnapshot({ codex: PERSON_CODEX }, 1, { codex: MANAGED_CODEX })
    const account = { home: join(root, 'person'), machineEnv: {}, snapshot }
    const ran: Array<{ executable: string; dir: string | undefined }> = []
    await homeModelProbe([home], {
      account: { home: account.home, env: {} },
      context: (kind, side) => managementContextFor(account, kind as BuiltinHarnessKind, side),
      probeAgent: async (_kind, context) => {
        ran.push({ executable: context.installation.executable, dir: context.env.CODEX_HOME })
        return []
      },
    })
    expect(ran).toEqual([{ executable: MANAGED_CODEX, dir: home.dir }])
    // The person's own folder still probes the person's install.
    expect(managementContextFor(account, 'codex')?.installation.executable).toBe(PERSON_CODEX)
  })

  it('the sign-out runs Podium’s Codex in the home', async () => {
    const log = join(root, 'calls.log')
    const person = fakeCodex('person', log)
    const managed = fakeCodex('managed', log)
    const { home } = await homes.ensure(SIGNED_IN, 'codex')
    const snapshot = testHarnessSnapshot({ codex: person }, 1, { codex: managed })
    const ctx = {
      homeDir: join(root, 'person'),
      harnessRuntime: { current: async () => snapshot },
    } as unknown as DaemonContext
    expect(await signOutOfHome(ctx, home)).toEqual({ ok: true })
    expect(readFileSync(log, 'utf8').trim()).toBe(`managed logout home=${home.dir}`)
  })

  it('the Codex daemon stop before a home is removed runs Podium’s Codex', async () => {
    const { home } = await homes.ensure(SIGNED_IN, 'codex')
    const snapshot = testHarnessSnapshot({ codex: PERSON_CODEX }, 1, { codex: MANAGED_CODEX })
    const runs: Array<{ command: string; args: readonly string[]; home: string | undefined }> = []
    await stopHome(home, {
      sessionsIn: () => [],
      stopSession: async () => undefined,
      codexExecutable: (target) => homeExecutable(snapshot, target),
      commandEnv: () => ({}),
      run: async (command, args, env) => {
        runs.push({ command, args, home: env.CODEX_HOME })
      },
      listProcesses: async () => [],
      signal: () => {},
      sleep: async () => {},
    })
    expect(runs).toEqual([
      { command: MANAGED_CODEX, args: ['app-server', 'daemon', 'stop'], home: home.dir },
    ])
    // Without Podium's install, the person's Codex stops the home, as before.
    expect(homeExecutable(testHarnessSnapshot({ codex: PERSON_CODEX }), home)).toBe(PERSON_CODEX)
  })
})
