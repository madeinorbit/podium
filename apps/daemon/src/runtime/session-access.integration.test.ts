/**
 * A SESSION'S CREDENTIAL REACHES EVERY PROCESS IT STARTS, AND NOTHING STARTS
 * WITHOUT IT (credential management §8; epic plan Task 5, acceptance 5 and 6).
 *
 * Real processes under the real podium-host, with the fixture harness:
 *
 *  - the second turn of a per-turn (headless) session: the first turn's frame
 *    carried the access, the second carries none, and the daemon's store
 *    supplies it to the turn child through the daemon's own env recipe;
 *  - an engine start for a session, through `SessionEngineScope.startEngine`,
 *    whose family strip list names the very variable delivered;
 *  - a daemon restart: a new store over the same markers holds no secret, so an
 *    engine start waits for the server's refresh, runs with it once it lands,
 *    and never runs when it does not come.
 *
 * The terminal session's case is `scripts/managed-account-spawn.integration.test.ts`.
 * Integration lane: needs the podium-host binary. Planted secrets are fake.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearTestManifests, harnessContext } from '@podium/harness'
import { acknowledgeHostedTurn, runHostedHeadlessTurn } from '@podium/harness/driver/host'
import { testBoundCommand } from '@podium/harness/driver/testing'
import { asSessionId } from '@podium/model'
import { createDurableProcess, liveHostSocket } from '@podium/process/durable'
import type { AccessField, BuiltinHarnessKind } from '@podium/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deliveryOverlay, memoryMarkers, SessionAccessStore } from '../control/access'
import { headlessTurnChildEnv } from '../control/session-env.js'
import { createSessionEngineScope } from '../session/engines.js'
import { SessionRegistry } from '../session/registry.js'
import {
  FIXTURE_AGENT,
  fixtureSnapshot,
  registerFixtureHarness,
  restartTurn,
} from '../test-support/headless-turn-restart.shared.js'

/** Obviously fake. */
const PLANTED = 'sk-FAKE-planted-integration-secret-0005'
const VARIABLE = 'FIXTURE_API_KEY'

/** A turn child: records the delivered variable as it saw it, answers at once. */
const TURN_SCRIPT = `#!/bin/sh
printf '%s\\n' "\${${VARIABLE}-unset}" >> "$FIXTURE_KEY_RECEIPT"
for last; do :; done
printf 'fixture answer: %s\\n' "$last"
`

/** An engine: records the delivered variable, then stays up like a server. */
const ENGINE_SCRIPT = `#!/bin/sh
printf '%s\\n' "\${${VARIABLE}-unset}" > "$ENGINE_RECEIPT"
sleep 60
`

let root = ''
let hostSockets = ''
let turnStand = ''
let engineStand = ''
const savedEnv: Record<string, string | undefined> = {}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean | Promise<boolean>, ms: number, what: string) {
  const deadline = Date.now() + ms
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await wait(50)
  }
}

function shortSockRoot(tag: string): string {
  for (const base of ['/tmp', '/var/tmp', tmpdir()]) {
    try {
      return mkdtempSync(join(base, tag))
    } catch {
      // Next candidate.
    }
  }
  throw new Error('no writable tmp base for podium-host sockets')
}

const accessFor = (sessionId: string): AccessField => ({
  credentialId: `cred_00000000-0000-4000-8000-${sessionId.slice(-12).padStart(12, '0')}`,
  delivery: { kind: 'env', variable: VARIABLE, secret: PLANTED },
})

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-access-'))
  mkdirSync(join(root, 'bin'), { recursive: true })
  for (const key of [
    'HOME',
    'PODIUM_STATE_DIR',
    'PODIUM_HOST_SOCKET_DIR',
    'PODIUM_INSTANCE',
    'PODIUM_NO_SCOPE',
    VARIABLE,
  ]) {
    savedEnv[key] = process.env[key]
  }
  hostSockets = shortSockRoot('pod-acc-hs-')
  process.env.HOME = join(root, 'home')
  mkdirSync(process.env.HOME, { recursive: true })
  process.env.PODIUM_STATE_DIR = join(root, 'state')
  process.env.PODIUM_HOST_SOCKET_DIR = hostSockets
  process.env.PODIUM_INSTANCE = 'access'
  process.env.PODIUM_NO_SCOPE = '1'
  // The daemon's own environment holds no credential: what a child sees came from the store.
  delete process.env[VARIABLE]
  turnStand = join(root, 'bin', 'fixture-agent')
  writeFileSync(turnStand, TURN_SCRIPT)
  chmodSync(turnStand, 0o755)
  engineStand = join(root, 'bin', 'fixture-engine')
  writeFileSync(engineStand, ENGINE_SCRIPT)
  chmodSync(engineStand, 0o755)
  registerFixtureHarness()
})

afterAll(() => {
  clearTestManifests()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
  if (hostSockets) rmSync(hostSockets, { recursive: true, force: true })
})

function newDir(tag: string) {
  const unique = `${tag}${Math.random().toString(36).slice(2, 7)}`
  const dir = join(root, unique)
  mkdirSync(join(dir, 'agent-home'), { recursive: true })
  mkdirSync(join(dir, 'work'), { recursive: true })
  return { unique, dir }
}

describe('the second turn of a per-turn session runs with the credential (acceptance 5)', () => {
  it('both turn children see the variable; only the first frame carried it', async () => {
    const { unique, dir } = newDir('t')
    const sessionId = asSessionId(`a${unique}`)
    const receipt = join(dir, 'key-receipt')
    const snapshot = fixtureSnapshot(turnStand)
    const store = new SessionAccessStore({ markers: memoryMarkers() })
    const engines = createSessionEngineScope(createDurableProcess(), {
      sessions: new SessionRegistry(),
      access: store,
    })

    const runTurn = async (turnId: string, frameAccess: AccessField | undefined) => {
      // What the daemon's runtimeSendRequest handler does with the frame.
      if (frameAccess) store.remember(sessionId, frameAccess, FIXTURE_AGENT)
      const credentialEnv = deliveryOverlay(FIXTURE_AGENT, await store.awaitAccess(sessionId)).env
      const turn = restartTurn({
        sessionId,
        turnId,
        cwd: join(dir, 'work'),
        agentHome: join(dir, 'agent-home'),
        files: {
          incarnations: join(dir, 'inc'),
          homeReceipt: join(dir, 'home'),
          release: '',
          done: '',
        },
        snapshot,
      })
      turn.spec.env = { ...turn.spec.env, FIXTURE_KEY_RECEIPT: receipt }
      // The daemon's own turn-child recipe (host-runtime's `turnChildEnv`).
      const handle = runHostedHeadlessTurn(
        {
          owner: engines,
          childEnv: (invocation) => {
            const { env, strip } = headlessTurnChildEnv({
              context: harnessContext(
                snapshot,
                FIXTURE_AGENT as BuiltinHarnessKind,
                turn.agentHome,
              ),
              credentialEnv,
              ...(turn.spec.env ? { instanceEnv: turn.spec.env } : {}),
              ...invocation,
            })
            return { env, stripEnv: strip }
          },
        },
        { spec: turn.spec, identity: turn.identity, snapshot, emit: () => {} },
      )
      try {
        expect((await handle.done).output).toBe('fixture answer: survive the restart')
      } finally {
        await acknowledgeHostedTurn(engines, turn.label, turn.identity)
        await waitFor(
          async () => (await liveHostSocket(turn.label)) === undefined,
          10_000,
          'host release',
        )
      }
    }

    await runTurn('turn-1', accessFor(sessionId))
    await runTurn('turn-2', undefined)
    expect(readFileSync(receipt, 'utf8').trim().split('\n')).toEqual([PLANTED, PLANTED])
  }, 240_000)
})

describe('an engine start for a session (acceptance 5, 6)', () => {
  async function startEngineFor(
    store: SessionAccessStore,
    sessionId: string,
    receipt: string,
  ): Promise<{
    started: Promise<unknown>
    label: string
    engines: ReturnType<typeof createSessionEngineScope>
  }> {
    const engines = createSessionEngineScope(createDurableProcess(), {
      sessions: new SessionRegistry(),
      access: store,
    })
    const label = `podium-${sessionId}`
    const started = engines.startEngine({
      sessionId: asSessionId(sessionId),
      label,
      command: testBoundCommand(engineStand, [], 'fixture' as BuiltinHarnessKind),
      cwd: root,
      env: { ENGINE_RECEIPT: receipt },
      // What every family passes: the harness's inherited-credential names,
      // here including the variable this session was given.
      stripEnv: [VARIABLE],
    })
    return { started, label, engines }
  }

  it('the engine process has the variable the family would have stripped', async () => {
    const { unique, dir } = newDir('e')
    const sessionId = `e${unique}`
    const receipt = join(dir, 'engine-receipt')
    const store = new SessionAccessStore({ markers: memoryMarkers() })
    store.remember(asSessionId(sessionId), accessFor(sessionId), FIXTURE_AGENT)
    const { started, label, engines } = await startEngineFor(store, sessionId, receipt)
    try {
      await started
      await waitFor(() => existsSync(receipt), 30_000, 'the engine to record its env')
      expect(readFileSync(receipt, 'utf8').trim()).toBe(PLANTED)
    } finally {
      await engines.destroyEngine(label, asSessionId(sessionId))
    }
  }, 120_000)

  it("a key only in the daemon's own environment is still stripped from an engine without a credential", async () => {
    const { unique, dir } = newDir('d')
    const sessionId = `d${unique}`
    const receipt = join(dir, 'engine-receipt')
    process.env[VARIABLE] = 'sk-FAKE-daemon-own-environment-0005'
    const { started, label, engines } = await startEngineFor(
      new SessionAccessStore({ markers: memoryMarkers() }),
      sessionId,
      receipt,
    )
    try {
      await started
      await waitFor(() => existsSync(receipt), 30_000, 'the engine to record its env')
      expect(readFileSync(receipt, 'utf8').trim()).toBe('unset')
    } finally {
      delete process.env[VARIABLE]
      await engines.destroyEngine(label, asSessionId(sessionId))
    }
  }, 120_000)

  it('after a restart, the engine waits for the refresh and then has the variable', async () => {
    const { unique, dir } = newDir('r')
    const sessionId = `r${unique}`
    const receipt = join(dir, 'engine-receipt')
    const markers = memoryMarkers()
    new SessionAccessStore({ markers }).remember(
      asSessionId(sessionId),
      accessFor(sessionId),
      FIXTURE_AGENT,
    )
    // The restarted daemon: same markers, empty memory.
    const restarted = new SessionAccessStore({ markers, waitMs: 30_000 })
    const { started, label, engines } = await startEngineFor(restarted, sessionId, receipt)
    try {
      await wait(500)
      expect(existsSync(receipt)).toBe(false)
      restarted.remember(asSessionId(sessionId), accessFor(sessionId))
      await started
      await waitFor(() => existsSync(receipt), 30_000, 'the engine to record its env')
      expect(readFileSync(receipt, 'utf8').trim()).toBe(PLANTED)
    } finally {
      await engines.destroyEngine(label, asSessionId(sessionId))
    }
  }, 120_000)

  it('after a restart with no refresh, no engine process ever starts', async () => {
    const { unique, dir } = newDir('n')
    const sessionId = `n${unique}`
    const receipt = join(dir, 'engine-receipt')
    const markers = memoryMarkers()
    new SessionAccessStore({ markers }).remember(
      asSessionId(sessionId),
      accessFor(sessionId),
      FIXTURE_AGENT,
    )
    const restarted = new SessionAccessStore({ markers, waitMs: 200 })
    const { started, label } = await startEngineFor(restarted, sessionId, receipt)
    await expect(started).rejects.toThrow(/credential/i)
    await wait(500)
    expect(existsSync(receipt)).toBe(false)
    expect(await liveHostSocket(label)).toBeUndefined()
  }, 60_000)
})
