/**
 * A SESSION'S CREDENTIAL ON THE DAEMON (credential management §8 "Memory
 * only"; epic plan Task 5, acceptance 6 and 8).
 *
 * The secret lives in this store's memory for the session's life. What reaches
 * disk is a marker that says a credential is required, never the secret, so a
 * restarted daemon knows to wait for the server's refresh instead of starting
 * a process on the machine's own login.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import type { AccessField } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type AccessMarker,
  AccessNotArrivedError,
  deliveryOverlay,
  type MarkerJournal,
  SessionAccessStore,
  withLeadingArgs,
} from './access'

const SESSION = asSessionId('00000000-0000-4000-8000-0000000000d5')
/** Obviously fake. */
const PLANTED = 'sk-FAKE-planted-daemon-secret-0005'

const envAccess: AccessField = {
  credentialId: 'cred_00000000-0000-4000-8000-0000000000d5',
  delivery: { kind: 'env', variable: 'ANTHROPIC_API_KEY', secret: PLANTED },
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A marker journal on a real directory, as the state dir holds it. */
function fileMarkers(dir: string): MarkerJournal {
  const path = (sessionId: string) => join(dir, `${encodeURIComponent(sessionId)}.json`)
  return {
    read(sessionId) {
      try {
        return JSON.parse(readFileSync(path(sessionId), 'utf8')) as AccessMarker
      } catch {
        return undefined
      }
    },
    write(entry) {
      writeFileSync(path(entry.sessionId), JSON.stringify(entry))
    },
    clear(sessionId) {
      rmSync(path(sessionId), { force: true })
    },
  }
}

function markerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'session-access-'))
  dirs.push(dir)
  return dir
}

function onDisk(dir: string): string {
  return readdirSync(dir)
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n')
}

describe('SessionAccessStore', () => {
  it('keeps the secret in memory and only a secret-free marker on disk', () => {
    const dir = markerDir()
    const store = new SessionAccessStore({ markers: fileMarkers(dir) })
    store.remember(SESSION, envAccess, 'claude-code')
    expect(store.current(SESSION)).toEqual(envAccess)
    const written = onDisk(dir)
    // Canary: the marker is there and names the credential.
    expect(written).toContain(envAccess.credentialId)
    expect(written).not.toContain(PLANTED)
    expect(written).not.toContain(Buffer.from(PLANTED).toString('base64'))
  })

  it('forgets memory and marker when the session ends', () => {
    const dir = markerDir()
    const store = new SessionAccessStore({ markers: fileMarkers(dir) })
    store.remember(SESSION, envAccess, 'claude-code')
    store.forget(SESSION)
    expect(store.current(SESSION)).toBeUndefined()
    expect(readdirSync(dir)).toEqual([])
  })

  it('a session with no credential needs none: awaitAccess resolves at once', async () => {
    const store = new SessionAccessStore({ markers: fileMarkers(markerDir()), waitMs: 10_000 })
    expect(await store.awaitAccess(SESSION)).toBeUndefined()
  })

  it('after a restart, a turn waits for the refresh and gets the credential (acceptance 6)', async () => {
    const dir = markerDir()
    new SessionAccessStore({ markers: fileMarkers(dir) }).remember(SESSION, envAccess, 'codex')
    // A new daemon process: memory is empty, the marker survived.
    const restarted = new SessionAccessStore({ markers: fileMarkers(dir), waitMs: 5_000 })
    expect(restarted.current(SESSION)).toBeUndefined()
    const waiting = restarted.awaitAccess(SESSION)
    restarted.remember(SESSION, envAccess)
    expect(await waiting).toEqual(envAccess)
    // The agent kind came back from the marker.
    expect(restarted.agentKindOf(SESSION)).toBe('codex')
  })

  it('after a restart with no refresh, the turn fails readably; it never runs without it (acceptance 6)', async () => {
    const dir = markerDir()
    new SessionAccessStore({ markers: fileMarkers(dir) }).remember(SESSION, envAccess, 'codex')
    const restarted = new SessionAccessStore({ markers: fileMarkers(dir), waitMs: 20 })
    const failed = restarted.awaitAccess(SESSION)
    await expect(failed).rejects.toBeInstanceOf(AccessNotArrivedError)
    await expect(failed).rejects.toThrow(/credential/i)
  })

  it('a session that ends while a turn waits fails that turn, never runs it bare', async () => {
    const dir = markerDir()
    new SessionAccessStore({ markers: fileMarkers(dir) }).remember(SESSION, envAccess, 'codex')
    const restarted = new SessionAccessStore({ markers: fileMarkers(dir), waitMs: 5_000 })
    const waiting = restarted.awaitAccess(SESSION)
    restarted.forget(SESSION)
    await expect(waiting).rejects.toBeInstanceOf(AccessNotArrivedError)
  })

  it('the default home needs no marker', () => {
    const dir = markerDir()
    const store = new SessionAccessStore({ markers: fileMarkers(dir) })
    store.remember(SESSION, {
      credentialId: envAccess.credentialId,
      delivery: { kind: 'home', homeId: 'default' },
    })
    expect(readdirSync(dir)).toEqual([])
  })

  it('clearMemory (daemon shutdown) keeps the markers', () => {
    const dir = markerDir()
    const store = new SessionAccessStore({ markers: fileMarkers(dir) })
    store.remember(SESSION, envAccess, 'claude-code')
    store.clearMemory()
    expect(store.current(SESSION)).toBeUndefined()
    expect(readdirSync(dir)).toHaveLength(1)
  })
})

describe('deliveryOverlay', () => {
  it('a Claude Code env credential sets the variable and the subprocess scrub (acceptance 8)', () => {
    expect(deliveryOverlay('claude-code', envAccess)).toEqual({
      env: { ANTHROPIC_API_KEY: PLANTED, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' },
      args: [],
      keep: ['ANTHROPIC_API_KEY'],
    })
  })

  it('codex gets its exclude switch as leading arguments', () => {
    const overlay = deliveryOverlay('codex', {
      credentialId: envAccess.credentialId,
      delivery: { kind: 'env', variable: 'OPENAI_API_KEY', secret: PLANTED },
    })
    expect(overlay.env).toEqual({ OPENAI_API_KEY: PLANTED })
    expect(overlay.args[0]).toBe('-c')
    expect(overlay.args[1]).toContain('shell_environment_policy.exclude=')
    expect(overlay.args[1]).toContain('OPENAI_API_KEY')
    expect(withLeadingArgs({ cmd: 'codex', args: ['app-server'] }, overlay.args)).toEqual({
      cmd: 'codex',
      args: [...overlay.args, 'app-server'],
    })
  })

  it('a ChatGPT plan starts codex with the provider flags and the token in the env only (Task 15, acceptance 1)', () => {
    const token = 'tok-FAKE-planted-plan-access-0015'
    const overlay = deliveryOverlay('codex', {
      credentialId: envAccess.credentialId,
      delivery: { kind: 'env', variable: 'ACCESS_TOKEN', secret: token },
    })
    expect(overlay.env).toEqual({ ACCESS_TOKEN: token })
    expect(overlay.keep).toEqual(['ACCESS_TOKEN'])
    expect(overlay.args.slice(0, 2)).toEqual([
      '-c',
      expect.stringContaining('shell_environment_policy.exclude='),
    ])
    expect(overlay.args).toEqual(
      expect.arrayContaining([
        'model_provider="podium_chatgpt_plan"',
        'model_providers.podium_chatgpt_plan.env_key="ACCESS_TOKEN"',
        'model_providers.podium_chatgpt_plan.base_url="https://api.openai.com/v1"',
        'model_providers.podium_chatgpt_plan.requires_openai_auth=false',
      ]),
    )
    // Canary first: the search finds the planted token where it belongs.
    expect(JSON.stringify(overlay.env)).toContain(token)
    expect(JSON.stringify(overlay.args)).not.toContain(token)
    expect(overlay.args.every((arg) => !arg.includes('tok-FAKE'))).toBe(true)
  })

  it('an API key on codex adds no provider flags', () => {
    const overlay = deliveryOverlay('codex', {
      credentialId: envAccess.credentialId,
      delivery: { kind: 'env', variable: 'OPENAI_API_KEY', secret: PLANTED },
    })
    expect(overlay.args.join(' ')).not.toContain('model_provider')
  })

  it('no access, or a home delivery, adds nothing', () => {
    const none = { env: {}, args: [], keep: [] }
    expect(deliveryOverlay('claude-code', undefined)).toEqual(none)
    expect(
      deliveryOverlay('claude-code', {
        credentialId: envAccess.credentialId,
        delivery: { kind: 'home', homeId: 'default' },
      }),
    ).toEqual(none)
  })
})

describe('SessionAccessStore.homeIdOf (credential management §10)', () => {
  const CRED = 'cred_dddddddd-0000-4000-8000-000000000004'
  const homeAccess = (homeId: string): AccessField => ({
    credentialId: CRED,
    delivery: { kind: 'home', homeId },
  })

  it('names the home the session runs in, and none for the default directory or a secret', () => {
    const store = new SessionAccessStore({ markers: fileMarkers(markerDir()) })
    store.remember(SESSION, homeAccess(`${CRED}:codex`), 'codex')
    expect(store.homeIdOf(SESSION)).toBe(`${CRED}:codex`)
    store.remember(SESSION, homeAccess('default'), 'codex')
    expect(store.homeIdOf(SESSION)).toBeUndefined()
    store.remember(SESSION, envAccess, 'codex')
    expect(store.homeIdOf(SESSION)).toBeUndefined()
  })

  it('after a restart, names the same home from the marker alone', () => {
    const dir = markerDir()
    new SessionAccessStore({ markers: fileMarkers(dir) }).remember(
      SESSION,
      homeAccess(`${CRED}:claude-code`),
      'claude-code',
    )
    const restarted = new SessionAccessStore({ markers: fileMarkers(dir) })
    expect(restarted.current(SESSION)).toBeUndefined()
    expect(restarted.homeIdOf(SESSION)).toBe(`${CRED}:claude-code`)
  })

  it('a marker whose harness has no homes names a home that cannot exist, never the default', () => {
    const markers = fileMarkers(markerDir())
    markers.write({ sessionId: SESSION, credentialId: CRED, delivery: 'home', agentKind: 'grok' })
    const store = new SessionAccessStore({ markers })
    expect(store.homeIdOf(SESSION)).toBe(`${CRED}:grok`)
  })
})
