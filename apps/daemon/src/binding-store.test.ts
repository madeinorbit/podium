import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asAgentIdentityId,
  asIssueId,
  asMachineId,
  asSessionId,
  asUserId,
  FIRST_ADMIN_USER_ID,
} from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BINDING_STORE_SCHEMA_VERSION,
  BindingStore,
  type BindingStoreAuthoritySnapshotError,
  BindingStoreVersionError,
  type LegacyBindingMigrationError,
  SESSION_BINDING_SCHEMA_VERSION,
} from './binding-store'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'podium-binding-store-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const machine = asMachineId('machine-a')
const alice = asUserId('user:alice')
const bob = asUserId('user:bob')

function requiredBinding<T>(value: T | null): T {
  if (value === null) throw new Error('expected binding to exist')
  return value
}

describe('BindingStore schema lifecycle', () => {
  it('opens an empty store at its own current version', async () => {
    const root = await tempRoot()
    const dir = join(root, 'runtime', 'session-bindings')
    const store = await BindingStore.open({ dir })

    expect(store.schemaVersion).toBe(BINDING_STORE_SCHEMA_VERSION)
    expect(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))).toMatchObject({
      schemaVersion: BINDING_STORE_SCHEMA_VERSION,
      legacyMigration: null,
    })
    expect(await readdir(join(dir, 'bindings'))).toEqual([])
  })

  it('migrates a mid-version manifest forward and preserves unknown fields', async () => {
    const root = await tempRoot()
    const dir = join(root, 'runtime', 'session-bindings')
    await mkdir(join(dir, 'bindings'), { recursive: true })
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({ schemaVersion: 1, createdAt: '2026-01-01T00:00:00.000Z', futureNote: 7 }),
    )

    await BindingStore.open({ dir })

    expect(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))).toEqual({
      schemaVersion: BINDING_STORE_SCHEMA_VERSION,
      createdAt: '2026-01-01T00:00:00.000Z',
      futureNote: 7,
      legacyMigration: null,
    })
  })

  it('refuses a future record for the version reason without rewriting or degrading it', async () => {
    const root = await tempRoot()
    const dir = join(root, 'runtime', 'session-bindings')
    const store = await BindingStore.open({ dir })
    const sessionId = asSessionId('future-session')
    const path = store.pathFor(sessionId)
    const bytes = '{"schemaVersion":999,"sessionId":"future-session","future":"opaque"}\n'
    await writeFile(path, bytes)

    await expect(store.read(sessionId)).rejects.toEqual(
      expect.objectContaining<Partial<BindingStoreVersionError>>({
        name: 'BindingStoreVersionError',
        found: 999,
        supported: SESSION_BINDING_SCHEMA_VERSION,
      }),
    )
    expect(await readFile(path, 'utf8')).toBe(bytes)
    await expect(store.bindingsForOwner(alice)).rejects.toBeInstanceOf(BindingStoreVersionError)
  })
})

describe('BindingStore records', () => {
  it('persists alias history with observed-at time instead of replacing the current value', async () => {
    const root = await tempRoot()
    const store = await BindingStore.open({ dir: join(root, 'store') })
    const sessionId = asSessionId('pane-history')
    await store.ensureBinding({
      sessionId,
      agentKind: 'codex',
      claimantMachineId: machine,
      delegation: {
        actor: asAgentIdentityId('agent-history'),
        onBehalfOf: alice,
        grantedScope: { kind: 'subtree', rootId: asIssueId('issue-a') },
        parentBindingId: null,
      },
    })
    await store.observe({
      sessionId,
      channel: 'resume-ref',
      nativeKind: 'codex-thread',
      value: 'thread-old',
      confidence: 'exact',
      source: 'native-hook',
      observedAt: '2026-07-31T10:00:00.000Z',
    })
    await store.observe({
      sessionId,
      channel: 'resume-ref',
      nativeKind: 'codex-thread',
      value: 'thread-old',
      confidence: 'exact',
      source: 'native-hook',
      observedAt: '2026-07-31T10:00:01.000Z',
      pendingServerAck: { nativeKind: 'codex-thread', value: 'thread-old' },
    })
    await store.observe({
      sessionId,
      channel: 'resume-ref',
      nativeKind: 'codex-thread',
      value: 'thread-new',
      confidence: 'exact',
      source: 'native-hook',
      observedAt: '2026-07-31T10:05:00.000Z',
    })

    const binding = await store.read(sessionId)
    expect(binding?.observations.map((entry) => [entry.value, entry.observedAt])).toEqual([
      ['thread-old', '2026-07-31T10:00:00.000Z'],
      ['thread-new', '2026-07-31T10:05:00.000Z'],
    ])
    expect(binding?.observations[0]?.pendingServerAck).toEqual({
      nativeKind: 'codex-thread',
      value: 'thread-old',
    })
    expect(binding?.observations[1]?.supersedes).toBe(binding?.observations[0]?.observationId)
    expect(binding).not.toHaveProperty('currentResume')
    expect(binding).not.toHaveProperty('resumeValue')
  })

  it('keeps delegation history and exposes rows only through an owner-scoped read', async () => {
    const root = await tempRoot()
    const store = await BindingStore.open({ dir: join(root, 'store') })
    const aliceSession = asSessionId('alice-session')
    const bobSession = asSessionId('bob-session')
    await store.ensureBinding({
      sessionId: aliceSession,
      agentKind: 'claude-code',
      claimantMachineId: machine,
      delegation: {
        actor: asAgentIdentityId('agent-alice'),
        onBehalfOf: alice,
        grantedScope: { kind: 'subtree', rootId: asIssueId('issue-a') },
        parentBindingId: null,
      },
    })
    await store.ensureBinding({
      sessionId: bobSession,
      agentKind: 'grok',
      claimantMachineId: machine,
      delegation: {
        actor: asAgentIdentityId('agent-bob'),
        onBehalfOf: bob,
        grantedScope: { kind: 'subtree', rootId: asIssueId('issue-b') },
        parentBindingId: aliceSession,
      },
    })
    await store.ensureBinding({
      sessionId: aliceSession,
      agentKind: 'claude-code',
      claimantMachineId: machine,
      delegation: {
        actor: asAgentIdentityId('agent-alice'),
        onBehalfOf: alice,
        grantedScope: { kind: 'owned', userId: alice },
        parentBindingId: null,
      },
    })

    expect((await store.bindingsForOwner(alice)).map((row) => row.sessionId)).toEqual([
      aliceSession,
    ])
    expect((await store.bindingsForOwner(bob)).map((row) => row.sessionId)).toEqual([bobSession])
    expect((await store.read(aliceSession))?.delegationHistory).toHaveLength(2)
    expect(
      store.currentDelegation(requiredBinding(await store.read(bobSession)))?.parentBindingId,
    ).toBe(aliceSession)

    await store.retire(aliceSession, '2026-07-31T11:00:00.000Z')
    expect(store.currentDelegation(requiredBinding(await store.read(aliceSession)))).toBeNull()
    expect(await store.bindingsForOwner(alice)).toEqual([])
  })

  it('persists only the declared delegation scope operand, never a rights snapshot', async () => {
    const root = await tempRoot()
    const store = await BindingStore.open({ dir: join(root, 'store') })
    const sessionId = asSessionId('schema-audit')
    await store.ensureBinding({
      sessionId,
      agentKind: 'shell',
      claimantMachineId: machine,
      delegation: {
        actor: asAgentIdentityId('agent-audit'),
        onBehalfOf: alice,
        grantedScope: { kind: 'owned', userId: alice },
        parentBindingId: null,
      },
    })
    const persisted = JSON.parse(await readFile(store.pathFor(sessionId), 'utf8')) as unknown
    const authorityKey =
      /capabilit|effectiveright|rights?|permission|privileg|entitlement|grant|role|acl/i
    const found: string[] = []
    const walk = (value: unknown, path = ''): void => {
      if (Array.isArray(value)) {
        value.forEach((entry) => {
          walk(entry, `${path}[]`)
        })
        return
      }
      if (!value || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${key}` : key
        if (authorityKey.test(key)) found.push(childPath)
        walk(child, childPath)
      }
    }
    walk(persisted)

    // `grantedScope` is the declared spawn-time operand. Any second match is a
    // cached authorization result and must make this exact pin fail.
    expect(found).toEqual(['delegationHistory[].grantedScope'])
  })

  it('fails closed on a planted authority snapshot without rewriting its bytes', async () => {
    const root = await tempRoot()
    const store = await BindingStore.open({ dir: join(root, 'store') })
    const sessionId = asSessionId('snapshot-rejected')
    await store.ensureBinding({
      sessionId,
      agentKind: 'shell',
      claimantMachineId: machine,
    })
    const path = store.pathFor(sessionId)
    const record = JSON.parse(await readFile(path, 'utf8'))
    record.effectiveRights = ['write']
    const bytes = `${JSON.stringify(record)}\n`
    await writeFile(path, bytes)

    await expect(store.read(sessionId)).rejects.toEqual(
      expect.objectContaining<Partial<BindingStoreAuthoritySnapshotError>>({
        name: 'BindingStoreAuthoritySnapshotError',
        paths: ['effectiveRights'],
      }),
    )
    expect(await readFile(path, 'utf8')).toBe(bytes)
  })

  it('round-trips unknown record and observation fields on rewrite', async () => {
    const root = await tempRoot()
    const store = await BindingStore.open({ dir: join(root, 'store') })
    const sessionId = asSessionId('round-trip')
    await store.ensureBinding({
      sessionId,
      agentKind: 'codex',
      claimantMachineId: machine,
    })
    const path = store.pathFor(sessionId)
    const record = JSON.parse(await readFile(path, 'utf8'))
    record.futureTopLevel = { retained: true }
    record.observations.push({
      observationId: 'future-observation',
      channel: 'resume-ref',
      value: 'future-thread',
      nativeKind: 'codex-thread',
      confidence: 'exact',
      source: 'native-hook',
      observedAt: '2026-01-01T00:00:00.000Z',
      recordedAt: '2026-01-01T00:00:00.000Z',
      supersedes: null,
      futureNested: 'retained',
    })
    await writeFile(path, JSON.stringify(record))

    await store.ensureBinding({
      sessionId,
      agentKind: 'codex',
      claimantMachineId: machine,
      observationGeneration: 2,
    })

    const rewritten = JSON.parse(await readFile(path, 'utf8'))
    expect(rewritten.futureTopLevel).toEqual({ retained: true })
    expect(rewritten.observations[0].futureNested).toBe('retained')
  })
})

describe('legacy daemon-state migration', () => {
  it('migrates the full real-directory inventory once and retains every unacked receipt', async () => {
    const stateDir = await tempRoot()
    const receiptDir = join(stateDir, 'runtime', 'codex-identity-receipts')
    const storeDir = join(stateDir, 'runtime', 'session-bindings')
    await mkdir(receiptDir, { recursive: true })
    await writeFile(
      join(stateDir, 'daemon.json'),
      JSON.stringify({ machineId: 'machine-real', token: 'not-a-binding-fact' }),
    )
    const receipt = join(receiptDir, 'codex-pane.json')
    const claim = join(receiptDir, 'claimed-pane.json.123.11111111-1111-4111-8111-111111111111.ack')
    await writeFile(
      receipt,
      JSON.stringify({ session_id: 'thread-live', hook_event_name: 'PodiumProcessBinding' }),
    )
    await writeFile(
      claim,
      JSON.stringify({ session_id: 'thread-claimed', hook_event_name: 'SessionStart' }),
    )
    const receiptBytes = await readFile(receipt)
    const claimBytes = await readFile(claim)
    const receiptMode = (await stat(receipt)).mode
    const now = () => '2026-07-31T12:00:00.000Z'
    const store = await BindingStore.open({
      dir: storeDir,
      legacyStateDir: stateDir,
      codexReceiptDir: receiptDir,
      singleOperatorUserId: FIRST_ADMIN_USER_ID,
      now,
      legacyBindings: [
        {
          sessionId: asSessionId('observed-pane'),
          agentKind: 'claude-code',
          observationGeneration: 9,
          control: {
            durableLabel: 'podium-observed-pane',
            cwd: '/repo/worktree',
            resume: { kind: 'claude-session', value: 'claude-native' },
          },
          observer: {
            providerSessionId: 'claude-native',
            resumeKind: 'claude-session',
            pathHint: '/home/u/.claude/thread.jsonl',
          },
          adapter: {
            nativeId: 'claude-native',
            resumeKind: 'claude-session',
            transcriptPath: '/home/u/.claude/thread.jsonl',
            cwd: '/repo/worktree/apps/daemon',
            worktreePin: '/repo/worktree',
          },
        },
      ],
    })

    expect(store.legacyMigration?.inventory).toEqual({
      sessionObservers: 1,
      controlSessions: 1,
      adapterPins: 1,
      daemonIdentityFiles: 1,
      codexReceipts: 1,
      codexReceiptClaims: 1,
    })
    const observed = await store.read(asSessionId('observed-pane'))
    expect(observed?.claimantMachineId).toBe('machine-real')
    expect(store.currentDelegation(requiredBinding(observed))?.onBehalfOf).toBe(FIRST_ADMIN_USER_ID)
    expect(observed?.observations.map((entry) => entry.channel)).toEqual([
      'durable-label',
      'cwd',
      'resume-ref',
      'provider-session',
      'transcript-path',
      'provider-session',
      'transcript-path',
      'cwd',
      'worktree-pin',
    ])
    const codex = await store.read(asSessionId('codex-pane'))
    expect(codex?.observations[0]).toMatchObject({
      channel: 'process-ownership',
      value: 'thread-live',
      pendingServerAck: { nativeKind: 'codex-thread', value: 'thread-live' },
    })
    expect(JSON.stringify(codex)).not.toContain('not-a-binding-fact')
    const claimed = await store.read(asSessionId('claimed-pane'))
    expect(claimed?.observations[0]).toMatchObject({
      channel: 'resume-ref',
      value: 'thread-claimed',
      pendingServerAck: { nativeKind: 'codex-thread', value: 'thread-claimed' },
    })
    expect(await readFile(receipt)).toEqual(receiptBytes)
    expect((await stat(receipt)).mode).toBe(receiptMode)
    expect(await readFile(claim)).toEqual(claimBytes)

    // The completed marker makes the lift one-shot. New legacy facts and a new
    // receipt on a later open are left for the normal runtime/POD-737 path.
    await writeFile(
      join(receiptDir, 'later-pane.json'),
      JSON.stringify({ session_id: 'thread-later', hook_event_name: 'SessionStart' }),
    )
    const reopened = await BindingStore.open({
      dir: storeDir,
      legacyStateDir: stateDir,
      codexReceiptDir: receiptDir,
      singleOperatorUserId: FIRST_ADMIN_USER_ID,
      now,
      legacyBindings: [{ sessionId: asSessionId('later-snapshot'), agentKind: 'grok' }],
    })
    expect(await reopened.read(asSessionId('later-pane'))).toBeNull()
    expect(await reopened.read(asSessionId('later-snapshot'))).toBeNull()
  })

  it('fails loudly before writing a placeholder owner when POD-1075 identity is absent', async () => {
    const stateDir = await tempRoot()
    const receiptDir = join(stateDir, 'runtime', 'codex-identity-receipts')
    const storeDir = join(stateDir, 'runtime', 'session-bindings')
    await mkdir(receiptDir, { recursive: true })
    await writeFile(join(stateDir, 'daemon.json'), JSON.stringify({ machineId: 'machine-real' }))
    await writeFile(
      join(receiptDir, 'pane.json'),
      JSON.stringify({ session_id: 'native', hook_event_name: 'SessionStart' }),
    )

    await expect(
      BindingStore.open({
        dir: storeDir,
        legacyStateDir: stateDir,
        codexReceiptDir: receiptDir,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LegacyBindingMigrationError>>({
        name: 'LegacyBindingMigrationError',
        message: expect.stringContaining('POD-1075 first-admin UserId'),
      }),
    )
    expect(await readdir(join(storeDir, 'bindings'))).toEqual([])
    expect(await readFile(join(receiptDir, 'pane.json'), 'utf8')).toContain('native')
  })
})
