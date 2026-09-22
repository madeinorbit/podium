import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_MANIFESTS,
  assertDeclinedReasonsValid,
  clearTestManifests,
  HARNESS_KINDS,
  manifestFor,
  registerTestManifest,
} from '../../registry.js'
import { declaredValue } from '../../manifest.js'
import { transcriptSourceFromGrammar } from '../../store/store.js'
import { fixtureManifest } from './index.js'
import { fixtureChainPaths, fixtureSessionPath } from './transcript.js'

/**
 * THE FIXTURE HARNESS, PROVING A SEVENTH MANIFEST LANDS CLEANLY (POD-4474,
 * spec §7: adapters/<name>/ plus one registry line).
 *
 * Every assertion below reads through the registered manifest — the same
 * `manifestFor` dispatch the daemon's control handlers land on — never the
 * imported object directly, except the registration itself. The daemon-side
 * route test (apps/daemon) takes the same manifest through the real
 * server→daemon frames; this file proves the manifest is worth routing to.
 */

const RECORDS = [
  { v: 1, id: 'u1', ts: '2026-09-22T03:00:00.000Z', role: 'user', text: 'hello fixture' },
  {
    v: 1,
    id: 'a1',
    ts: '2026-09-22T03:00:01.000Z',
    role: 'agent',
    text: 'hello back',
    model: 'fixture-model-1',
  },
]

describe('fixture harness registration', () => {
  let unregister: (() => void) | undefined

  beforeEach(() => {
    // BEFORE: no seventh harness — an unregistered fixture degrades exactly
    // like an unknown CLI, never like a shipped one.
    expect(manifestFor('fixture')).toBeUndefined()
  })

  afterEach(() => {
    unregister?.()
    clearTestManifests()
    expect(manifestFor('fixture')).toBeUndefined()
  })

  it('registers with one line and resolves through manifestFor, then releases', () => {
    // THE SETUP'S RETURN IS THE ASSERTION (POD-4474 review trap): a setup
    // that silently installs nothing would read as "integration broken" with
    // zero events. Here the registration itself returns the release, and the
    // lookup answers before and after.
    unregister = registerTestManifest(fixtureManifest)
    expect(typeof unregister).toBe('function')
    expect(manifestFor('fixture')).toBe(fixtureManifest)
    // The closed set is untouched: totality, HARNESS_KINDS and the matrix
    // never see the double.
    expect(Object.keys(AGENT_MANIFESTS)).toHaveLength(6)
    expect([...HARNESS_KINDS]).toHaveLength(6)
  })

  it('declines with real reasons, never placeholders', () => {
    expect(() => assertDeclinedReasonsValid({ fixture: fixtureManifest })).not.toThrow()
  })
})

describe('fixture harness mechanisms (through the registered manifest)', () => {
  let home: string
  let unregister: () => void

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'fixture-harness-'))
    unregister = registerTestManifest(fixtureManifest)
  })

  afterEach(async () => {
    unregister()
    clearTestManifests()
    await rm(home, { recursive: true, force: true })
  })

  const manifest = () => {
    const found = manifestFor('fixture')
    if (!found) throw new Error('fixture manifest did not register')
    return found
  }

  it('selects the terminal driver and builds launch/exec/headless argv', () => {
    const runtime = manifest().runtime
    expect(runtime.terminal.driverId).toBe('generic-pty')
    expect(runtime.select({ auth: 'unknown', platform: 'linux', available: [] })).toBe(
      'generic-pty',
    )
    expect(
      runtime.select({ auth: 'unknown', platform: 'linux', available: ['generic-pty'] }),
    ).toBe('generic-pty')
    const launch = manifest().launch({ cwd: '/work', initialPrompt: '- list files' })
    expect(launch.cmd).toBe('fixture-agent')
    // The POD-1317 `--` boundary: an option-looking prompt rides verbatim.
    expect(launch.args.slice(-2)).toEqual(['--', '- list files'])
    const exec = declaredValue(manifest().exec)?.({ prompt: 'do it' })
    expect(exec?.cmd).toBe('fixture-agent')
    const headless = declaredValue(manifest().headless)
    expect(headless?.driver).toBe('resume-exec')
    const built = declaredValue(headless!.buildExec)?.({ prompt: 'do it', sessionId: 's1' })
    expect(built?.args).toContain('s1')
  })

  it('chains and reads its file transcript with model and colour facts', async () => {
    const resumeValue = 'sess-1'
    await mkdir(join(home, '.fixture', 'sessions'), { recursive: true })
    await writeFile(
      fixtureSessionPath(home, resumeValue),
      RECORDS.map((record) => JSON.stringify(record)).join('\n'),
    )
    // No resume value names no conversation — the file-harness contract.
    expect(await fixtureChainPaths({ cwd: '/work', homeDir: home })).toEqual([])
    const chained = await fixtureChainPaths({ cwd: '/work', resumeValue, homeDir: home })
    expect(chained).toHaveLength(1)

    // The Store read, through the manifest's transcript section — the same
    // two lines the daemon's transcript route dispatches on.
    const transcript = declaredValue(manifest().transcript)
    if (!transcript) throw new Error('fixture transcript declined')
    const source = await transcriptSourceFromGrammar(transcript, {
      cwd: '/work',
      resumeValue,
      homeDir: home,
    })
    const slice = await source.readSlice({ direction: 'before', limit: 10 })
    expect(slice.items.map((item) => [item.role, item.text])).toEqual([
      ['user', 'hello fixture'],
      ['assistant', 'hello back'],
    ])
    const runtimeReader = declaredValue(transcript.recordRuntime)
    expect(runtimeReader?.(RECORDS[1])).toEqual({ model: 'fixture-model-1' })
    expect(declaredValue(transcript.recordColor)?.(RECORDS[1])).toBe('#7c6cf0')
  })

  it('detects login from its auth file: in, out, unknown', async () => {
    const inventory = manifest().inventory
    expect(inventory.detectLogin(home)).toEqual({ state: 'out' })
    await mkdir(join(home, '.fixture'), { recursive: true })
    await writeFile(join(home, '.fixture', 'auth.json'), JSON.stringify({ account: 'tester' }))
    expect(inventory.detectLogin(home)).toEqual({ state: 'in', account: 'tester' })
    const identity = declaredValue(inventory.loginIdentity)?.(home)
    expect(identity?.fingerprint).toBe('fixture:tester')
    await writeFile(join(home, '.fixture', 'auth.json'), '{malformed')
    expect(inventory.detectLogin(home)).toEqual({ state: 'unknown' })
    expect(inventory.foreignCredentialEnv).toEqual(['FIXTURE_API_KEY'])
  })

  it('translates its own phase markers and nothing else', async () => {
    const state = declaredValue(manifest().state)
    if (!state) throw new Error('fixture state declined')
    expect(await state.translate({ fixture: true, phase: 'working' })).toHaveLength(1)
    const done = await state.translate({ fixture: true, phase: 'idle' })
    expect(done[0]).toMatchObject({ kind: 'turn_completed' })
    // Another harness's payload shape is not state here.
    expect(await state.translate({ hook_event_name: 'SessionStart' })).toEqual([])
    expect(await state.translate(undefined)).toEqual([])
    expect(await state.bootEvents?.({ cwd: '/work' })).toHaveLength(1)
  })

  it('discovers the session it chains', async () => {
    await mkdir(join(home, '.fixture', 'sessions'), { recursive: true })
    await writeFile(
      fixtureSessionPath(home, 'sess-9'),
      JSON.stringify(RECORDS[0]),
    )
    const provider = manifest().discovery
    const scanned = await provider.scanRoot(join(home, '.fixture'))
    expect(scanned.conversations.map((conversation) => conversation.id)).toEqual(['sess-9'])
    const loaded = await provider.loadConversation(scanned.conversations[0]!)
    expect(loaded.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'hello fixture'],
    ])
  })

  it('observes by binding the resume value and tailing its chain file', async () => {
    await mkdir(join(home, '.fixture', 'sessions'), { recursive: true })
    await writeFile(
      fixtureSessionPath(home, 'sess-2'),
      JSON.stringify(RECORDS[0]),
    )
    const observer = declaredValue(manifest().observer)
    if (!observer) throw new Error('fixture observer declined')
    const seen: { resume?: string; tails: string[] } = { tails: [] }
    const observation = observer(
      { cwd: '/work', resumeValue: 'sess-2', homeDir: home },
      {
        tailFile: (path) => {
          seen.tails.push(path)
        },
        onResumeValue: (value) => {
          seen.resume = value
        },
        onTitle: () => {},
        onStateEvents: () => {},
        onObservation: () => {},
        onExactProviderRebind: () => {},
        onTranscriptItems: () => {},
      },
    )
    // The tail bootstrap is async: flush it before asserting the setup's effect.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen.resume).toBe('sess-2')
    expect(seen.tails).toEqual([fixtureSessionPath(home, 'sess-2')])
    observation.stop()
  })

  it('exports its transcript for handoff from the same path it chains', async () => {
    await mkdir(join(home, '.fixture', 'sessions'), { recursive: true })
    await writeFile(fixtureSessionPath(home, 'sess-3'), JSON.stringify(RECORDS[0]))
    const handoff = declaredValue(manifest().handoffTranscript)
    if (!handoff) throw new Error('fixture handoff declined')
    const placed = handoff.transcriptPlacement({
      cwd: '/work',
      homeDir: home,
      resumeValue: 'sess-3',
      filename: 'sess-3.jsonl',
    })
    const exported = await handoff.transcriptForExport({
      cwd: '/work',
      homeDir: home,
      resumeValue: 'sess-3',
    })
    expect(exported.path).toBe(placed)
    await expect(
      handoff.transcriptForExport({ cwd: '/work', homeDir: home, resumeValue: 'missing' }),
    ).rejects.toThrow('Fixture transcript not found')
  })
})
