import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asAgentIdentityId,
  asIssueId,
  asMachineId,
  asSessionId,
  asUserId,
  SOLE_USER_ID,
} from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'

const SINGLE_OPERATOR = asUserId(SOLE_USER_ID)
const serverDelegation = (
  id: string,
  owner = SINGLE_OPERATOR,
): import('@podium/model').SessionDelegation => ({
  actor: asAgentIdentityId(id),
  onBehalfOf: owner,
  grantedScope: { kind: 'none' },
  parentBindingId: null,
  revision: 1,
})
import {
  BINDING_STORE_SCHEMA_VERSION,
  BindingStore,
  type BindingStoreAuthoritySnapshotError,
  BindingStoreVersionError,
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
      codexReceiptFold: null,
    })
    expect(await readdir(join(dir, 'bindings'))).toEqual([])
  })

  // The trap that orphaned a live fleet (POD-1647): the first open after the
  // upgrade found every legacy source cold, recorded an all-zero migration, and
  // — because open() only checks `legacyMigration !== null` — could never look
  // again. An empty run must leave the door open.
  it('an empty legacy migration does not spend the one-time marker', async () => {
    const root = await tempRoot()
    const dir = join(root, 'runtime', 'session-bindings')
    const stateDir = join(root, 'state')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'machine.json'), JSON.stringify({ version: 1, importedFiles: {}, machineId: 'machine-real' }))

    const first = await BindingStore.open({ dir, legacyStateDir: stateDir })
    expect(first.legacyMigration).toBeNull()
    expect(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))).toMatchObject({
      legacyMigration: null,
    })

    // A later boot that DOES have something to migrate is still able to run.
    const second = await BindingStore.open({
      dir,
      legacyStateDir: stateDir,
      legacyDelegationForSession: (id) => serverDelegation(id),
      legacyBindings: [
        {
          sessionId: asSessionId('late-arrival'),
          agentKind: 'claude-code',
          control: { durableLabel: 'podium-late-arrival', cwd: '/repo' },
        },
      ],
    })
    expect(second.legacyMigration?.inventory.controlSessions).toBe(1)
    expect(await second.read(asSessionId('late-arrival'))).not.toBeNull()
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
      codexReceiptFold: null,
    })
  })

  it('refuses a future store manifest without rewriting it', async () => {
    const root = await tempRoot()
    const dir = join(root, 'runtime', 'session-bindings')
    await mkdir(join(dir, 'bindings'), { recursive: true })
    const path = join(dir, 'manifest.json')
    const bytes = '{"schemaVersion":999,"createdAt":"2026-01-01T00:00:00.000Z"}\n'
    await writeFile(path, bytes)

    await expect(BindingStore.open({ dir })).rejects.toEqual(
      expect.objectContaining<Partial<BindingStoreVersionError>>({
        name: 'BindingStoreVersionError',
        found: 999,
        supported: BINDING_STORE_SCHEMA_VERSION,
      }),
    )
    expect(await readFile(path, 'utf8')).toBe(bytes)
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
        revision: 1,
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
        revision: 1,
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
        revision: 1,
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
        revision: 1,
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
    expect((await store.read(aliceSession))?.delegationHistory).toEqual([])
    expect(
      store.currentDelegation(requiredBinding(await store.read(bobSession)))?.parentBindingId,
    ).toBe(aliceSession)

    await store.transition({
      event: 'retire',
      transitionId: `retire:${aliceSession}`,
      sessionId: aliceSession,
      retiredAt: '2026-07-31T11:00:00.000Z',
    })
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
        revision: 1,
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
    expect(found).toEqual(['delegation.grantedScope'])
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

  it('keeps receipt replay and exact-value ack owner-scoped inside observation history', async () => {
    const root = await tempRoot()
    const store = await BindingStore.open({ dir: join(root, 'runtime', 'session-bindings') })
    const aliceSession = asSessionId('alice-receipt')
    const bobSession = asSessionId('bob-receipt')
    for (const [sessionId, owner, actor] of [
      [aliceSession, alice, 'agent-alice'],
      [bobSession, bob, 'agent-bob'],
    ] as const) {
      await store.ensureBinding({
        sessionId,
        agentKind: 'codex',
        claimantMachineId: machine,
        delegation: {
          revision: 1,
          actor: asAgentIdentityId(actor),
          onBehalfOf: owner,
          grantedScope: { kind: 'owned', userId: owner },
          parentBindingId: null,
        },
      })
      await store.recordPendingCodexReceipt(
        sessionId,
        `${owner}-thread`,
        sessionId === aliceSession ? 'process' : 'native-hook',
      )
    }

    expect(await store.pendingReceiptsForOwner(alice)).toEqual([
      { sessionId: aliceSession, nativeKind: 'codex-thread', value: `${alice}-thread` },
    ])
    expect(await store.pendingReceiptsForOwner(bob)).toEqual([
      { sessionId: bobSession, nativeKind: 'codex-thread', value: `${bob}-thread` },
    ])
    expect(await store.ownersWithPendingReceipts()).toEqual([alice, bob])

    expect(
      await store.acknowledgePendingReceipt(bob, aliceSession, {
        kind: 'codex-thread',
        value: `${alice}-thread`,
      }),
    ).toBe(false)
    expect(await store.pendingReceiptsForOwner(alice)).toHaveLength(1)
    expect(
      await store.acknowledgePendingReceipt(alice, aliceSession, {
        kind: 'codex-thread',
        value: 'stale-thread',
      }),
    ).toBe(false)
    expect(
      await store.acknowledgePendingReceipt(alice, aliceSession, {
        kind: 'codex-thread',
        value: `${alice}-thread`,
      }, (await store.read(aliceSession))?.observations[0]?.receipt),
    ).toBe(true)
    expect(await store.pendingReceiptsForOwner(alice)).toEqual([])

    const bobBinding = requiredBinding(await store.read(bobSession))
    expect(bobBinding.observations[0]).toMatchObject({
      channel: 'resume-ref',
      source: 'native-hook',
      pendingServerAck: { nativeKind: 'codex-thread', value: `${bob}-thread` },
    })
    const receipt = bobBinding.observations[0]?.pendingServerAck as Record<string, unknown>
    expect(Object.keys(receipt).sort()).toEqual(['nativeKind', 'value'])
    expect(receipt).not.toHaveProperty('actor')
    expect(receipt).not.toHaveProperty('onBehalfOf')
    expect(receipt).not.toHaveProperty('capability')
    expect(receipt).not.toHaveProperty('rights')
    expect(receipt).not.toHaveProperty('permission')
  })

  it('isolates identical session receipts in separate instance runtime stores', async () => {
    const root = await tempRoot()
    const sessionId = asSessionId('same-session')
    const makeInstance = async (instance: string, owner: typeof alice, nativeId: string) => {
      const store = await BindingStore.open({
        dir: join(root, 'instances', instance, 'runtime', 'session-bindings'),
      })
      await store.ensureBinding({
        sessionId,
        agentKind: 'codex',
        claimantMachineId: machine,
        delegation: {
          revision: 1,
          actor: asAgentIdentityId(`agent-${instance}`),
          onBehalfOf: owner,
          grantedScope: { kind: 'owned', userId: owner },
          parentBindingId: null,
        },
      })
      await store.recordPendingCodexReceipt(sessionId, nativeId, 'process')
      return store
    }
    const first = await makeInstance('one', alice, 'thread-one')
    const second = await makeInstance('two', bob as typeof alice, 'thread-two')

    expect(await first.pendingReceiptsForOwner(alice)).toEqual([
      { sessionId, nativeKind: 'codex-thread', value: 'thread-one' },
    ])
    expect(await first.pendingReceiptsForOwner(bob)).toEqual([])
    expect(await second.pendingReceiptsForOwner(bob)).toEqual([
      { sessionId, nativeKind: 'codex-thread', value: 'thread-two' },
    ])
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
      join(stateDir, 'machine.json'),
      JSON.stringify({ version: 1, importedFiles: {}, machineId: 'machine-real', token: 'not-a-binding-fact' }),
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
    const now = () => '2026-07-31T12:00:00.000Z'
    const legacyBindings = [
      {
        sessionId: asSessionId('observed-pane'),
        agentKind: 'claude-code' as const,
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
    ]
    // This is the non-vacuity pin: zero rows migrated from zero source rows is
    // not evidence that a migration moves state.
    expect(legacyBindings.length).toBeGreaterThan(0)
    expect((await readdir(receiptDir)).length).toBeGreaterThan(0)

    const store = await BindingStore.open({
      dir: storeDir,
      legacyStateDir: stateDir,
      codexReceiptDir: receiptDir,
      legacyDelegationForSession: (id) => serverDelegation(id),
      now,
      legacyBindings,
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
    expect(observed?.attemptId).toBe('podium-observed-pane')
    expect(store.currentDelegation(requiredBinding(observed))?.onBehalfOf).toBe(SINGLE_OPERATOR)
    expect(observed?.observations.map((entry) => entry.channel)).toEqual([
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
    expect(store.codexReceiptFold?.inventory).toEqual({ receipts: 1, claims: 1 })
    await expect(access(receiptDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(
      (await readdir(join(storeDir, 'bindings'))).filter((name) => name.endsWith('.json')),
    ).toHaveLength(3)

    // The completed marker makes the initial lift one-shot. A late receipt from
    // an old, still-running hook is drained without re-running other migration.
    await mkdir(receiptDir, { recursive: true })
    await writeFile(
      join(receiptDir, 'later-pane.json'),
      JSON.stringify({ session_id: 'thread-later', hook_event_name: 'SessionStart' }),
    )
    const reopened = await BindingStore.open({
      dir: storeDir,
      legacyStateDir: stateDir,
      codexReceiptDir: receiptDir,
      legacyDelegationForSession: (id) => serverDelegation(id),
      now,
      legacyBindings: [{ sessionId: asSessionId('later-snapshot'), agentKind: 'grok' }],
    })
    expect(await reopened.read(asSessionId('later-pane'))).toMatchObject({
      observations: [
        expect.objectContaining({
          value: 'thread-later',
          pendingServerAck: { nativeKind: 'codex-thread', value: 'thread-later' },
        }),
      ],
    })
    expect(await reopened.read(asSessionId('later-snapshot'))).toBeNull()
    await expect(access(receiptDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a superseded ack claim as history without replaying it over a newer receipt', async () => {
    const stateDir = await tempRoot()
    const receiptDir = join(stateDir, 'runtime', 'codex-identity-receipts')
    const storeDir = join(stateDir, 'runtime', 'session-bindings')
    await mkdir(receiptDir, { recursive: true })
    await writeFile(join(stateDir, 'machine.json'), JSON.stringify({ version: 1, importedFiles: {}, machineId: 'machine-real' }))
    await writeFile(
      join(receiptDir, 'same-pane.json.123.11111111-1111-4111-8111-111111111111.ack'),
      JSON.stringify({ session_id: 'thread-old', hook_event_name: 'SessionStart' }),
    )
    await writeFile(
      join(receiptDir, 'same-pane.json'),
      JSON.stringify({ session_id: 'thread-new', hook_event_name: 'SessionStart' }),
    )

    const store = await BindingStore.open({
      dir: storeDir,
      legacyStateDir: stateDir,
      codexReceiptDir: receiptDir,
      legacyDelegationForSession: (id) => serverDelegation(id),
    })

    const binding = requiredBinding(await store.read(asSessionId('same-pane')))
    expect(binding.observations.find((entry) => entry.value === 'thread-old')).not.toHaveProperty(
      'pendingServerAck',
    )
    expect(binding.observations.find((entry) => entry.value === 'thread-new')).toMatchObject({
      pendingServerAck: { nativeKind: 'codex-thread', value: 'thread-new' },
    })
    expect(await store.pendingReceiptsForOwner(SINGLE_OPERATOR)).toEqual([
      {
        sessionId: 'same-pane',
        nativeKind: 'codex-thread',
        value: 'thread-new',
      },
    ])
    await expect(access(receiptDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('quarantines an unresolved receipt without writing a placeholder owner', async () => {
    const stateDir = await tempRoot()
    const receiptDir = join(stateDir, 'runtime', 'codex-identity-receipts')
    const storeDir = join(stateDir, 'runtime', 'session-bindings')
    await mkdir(receiptDir, { recursive: true })
    await writeFile(join(stateDir, 'machine.json'), JSON.stringify({ version: 1, importedFiles: {}, machineId: 'machine-real' }))
    await writeFile(
      join(receiptDir, 'pane.json'),
      JSON.stringify({ session_id: 'native', hook_event_name: 'SessionStart' }),
    )

    const store = await BindingStore.open({
      dir: storeDir,
      legacyStateDir: stateDir,
      codexReceiptDir: receiptDir,
    })
    expect(store.quarantinedCount).toBe(1)
    expect(await readdir(join(storeDir, 'bindings'))).toEqual([])
    expect(await readFile(join(receiptDir, 'pane.json'), 'utf8')).toContain('native')
  })
})

describe('server-resolved legacy owners', () => {
  it('repairs persisted retired owners without changing modern owners or native evidence', async () => {
    const root = await tempRoot()
    const store = await BindingStore.open({ dir: root })
    for (const [id, owner] of [
      ['old', 'user:sole'],
      ['modern', 'mem_other'],
    ] as const) {
      await store.ensureBinding({
        sessionId: asSessionId(id),
        agentKind: 'codex',
        claimantMachineId: asMachineId('machine'),
        delegation: {
          revision: 1,
          actor: asAgentIdentityId(id),
          onBehalfOf: asUserId(owner),
          grantedScope: { kind: 'all' },
          parentBindingId: null,
        },
      })
    }
    const old = await store.read(asSessionId('old'))
    const modern = await store.read(asSessionId('modern'))
    await store.recoverLegacyState({
      dir: root,
      legacyDelegationForSession: (id) =>
        id === 'old' ? serverDelegation(id, asUserId('mem_rekeyed')) : undefined,
    })
    const repaired = await store.read(asSessionId('old'))
    expect(repaired?.delegation?.onBehalfOf).toBe('mem_rekeyed')
    expect(repaired?.observations).toEqual(old?.observations)
    expect(await store.read(asSessionId('modern'))).toEqual(modern)
    const reopened = await BindingStore.open({ dir: root })
    expect(await reopened.read(asSessionId('old'))).toEqual(repaired)
  })

  it('preserves a receipt when the server cannot establish its owner, then recovers on reconnect', async () => {
    const root = await tempRoot()
    const receipts = join(root, 'receipts')
    await mkdir(receipts)
    await writeFile(join(root, 'machine.json'), JSON.stringify({ version: 1, importedFiles: {}, machineId: 'machine' }))
    const receipt = join(receipts, 'orphan.json')
    await writeFile(
      receipt,
      JSON.stringify({ session_id: 'thread', hook_event_name: 'PodiumProcessBinding' }),
    )
    const store = await BindingStore.open({ dir: join(root, 'bindings') })
    const options = { dir: store.dir, legacyStateDir: root, codexReceiptDir: receipts }
    await expect(
      store.recoverLegacyState({ ...options, legacyDelegationForSession: () => undefined }),
    ).resolves.toBeUndefined()
    expect(store.quarantinedCount).toBe(1)
    expect(await store.read(asSessionId('orphan'))).toBeNull()
    expect(await readFile(receipt, 'utf8')).toContain('thread')
    await store.inventory(receipts)
    store.confirmInventory(asMachineId('machine'), {
      orphan: {
        owner: 'mem_owner',
        machineId: 'machine',
        closed: false,
        delegation: serverDelegation('orphan', asUserId('mem_owner')),
      },
    })
    await store.recoverLegacyState({
      ...options,
      legacyDelegationForSession: (id) => serverDelegation(id, asUserId('mem_owner')),
    })
    expect((await store.read(asSessionId('orphan')))?.delegation?.onBehalfOf).toBe('mem_owner')
    await expect(access(receipt)).rejects.toThrow()
  })
})

describe('connect inventory isolation', () => {
  it('confirms one binding while retaining unknown, moved, and live closed bindings', async () => {
    const root = await tempRoot()
    const store = await BindingStore.open({ dir: root })
    const receipts = join(root, 'receipts')
    for (const id of ['good', 'unknown', 'moved', 'closed']) {
      await store.ensureBinding({
        sessionId: asSessionId(id),
        agentKind: 'codex',
        claimantMachineId: machine,
        delegation: {
          revision: 1,
          actor: asAgentIdentityId(id),
          onBehalfOf: alice,
          grantedScope: { kind: 'all' },
          parentBindingId: null,
        },
      })
    }
    // Interrupted atomic-write residue is not a binding and cannot be adopted.
    await writeFile(join(root, 'bindings', 'inert.json.123.dead.tmp'), 'user:sole')
    expect(await store.inventory(receipts)).toEqual(['closed', 'good', 'moved', 'unknown'])
    store.confirmInventory(machine, {
      good: {
        owner: alice,
        machineId: machine,
        closed: false,
        delegation: serverDelegation('good', asUserId(alice)),
      },
      unknown: { owner: null, machineId: null, closed: false },
      moved: {
        owner: alice,
        machineId: 'elsewhere',
        closed: false,
        delegation: serverDelegation('moved', asUserId(alice)),
      },
      closed: { owner: alice, machineId: machine, closed: true },
    })
    expect(store.isQuarantined(asSessionId('good'))).toBe(false)
    expect(store.quarantinedCount).toBe(3)
    await store.reapQuarantined(async () => true, receipts)
    expect(await store.read(asSessionId('closed'))).not.toBeNull()
    await store.reapQuarantined(async () => false, receipts)
    expect(await store.read(asSessionId('closed'))).toBeNull()
    expect(await store.read(asSessionId('unknown'))).not.toBeNull()
    expect(await store.read(asSessionId('moved'))).not.toBeNull()
    expect(store.quarantinedCount).toBe(2)
    await store.inventory(receipts)
    store.confirmInventory(machine, undefined)
    expect(store.quarantinedCount).toBe(0)
    expect(store.isQuarantined(asSessionId('unknown'))).toBe(false)
  })
})

it('folds a confirmed receipt using handshake placement without a legacy identity file', async () => {
  const root = await tempRoot()
  const receipts = join(root, 'receipts')
  await mkdir(receipts)
  for (const id of ['healthy', 'orphan']) {
    await writeFile(
      join(receipts, `${id}.json`),
      JSON.stringify({
        session_id: `native-${id}`,
        hook_event_name: 'PodiumProcessBinding',
      }),
    )
  }
  const store = await BindingStore.open({ dir: join(root, 'bindings') })
  expect(await store.inventory(receipts)).toEqual(['healthy', 'orphan'])
  store.confirmInventory(machine, {
    healthy: {
      owner: alice,
      machineId: machine,
      closed: false,
      delegation: serverDelegation('healthy', asUserId(alice)),
    },
    orphan: { owner: null, machineId: null, closed: false },
  })
  await store.recoverLegacyState({
    dir: store.dir,
    legacyStateDir: root,
    codexReceiptDir: receipts,
    legacyDelegationForSession: (id) =>
      id === 'healthy' ? serverDelegation(id, alice) : undefined,
  })
  expect((await store.read(asSessionId('healthy')))?.claimantMachineId).toBe(machine)
  expect(store.isQuarantined(asSessionId('healthy'))).toBe(false)
  expect(store.quarantinedCount).toBe(1)
  expect(await store.read(asSessionId('orphan'))).toBeNull()
  expect(await readFile(join(receipts, 'orphan.json'), 'utf8')).toContain('native-orphan')
  expect(await store.pendingReceiptsForOwner(alice)).toEqual([
    { sessionId: 'healthy', nativeKind: 'codex-thread', value: 'native-healthy' },
  ])
})


it('replays the latest exact receipt after reopen and fences duplicate acknowledgements by incarnation', async () => {
  const dir = join(await tempRoot(), 'bindings')
  let store = await BindingStore.open({ dir })
  const sessionId = asSessionId('receipt-incarnation')
  const ensure = (generation: number) => store.ensureBinding({ sessionId, agentKind: 'codex',
    claimantMachineId: machine, observationGeneration: generation, attemptId: `attempt-${generation}`,
    delegation: serverDelegation('actor', alice) })
  await ensure(1)
  await store.recordPendingCodexReceipt(sessionId, 'native-a', 'native-hook')
  const first = (await store.read(sessionId))!.observations.at(-1)!.receipt!
  await store.recordPendingCodexReceipt(sessionId, 'native-b', 'native-hook')
  store = await BindingStore.open({ dir })
  const frames: import('@podium/protocol/daemon').DaemonMessage[] = []
  expect(await store.replayPendingReceiptsForOwner(alice, (frame) => frames.push(frame))).toBe(1)
  expect(frames).toMatchObject([{ type: 'sessionResumeRef', resume: { value: 'native-b' },
    confidence: 'exact', ackRequested: true, receipt: { ownerId: alice, attemptId: 'attempt-1' } }])
  const current = (await store.read(sessionId))!.observations.at(-1)!.receipt!
  const resume = { kind: 'codex-thread', value: 'native-b' }
  expect(await store.acknowledgePendingReceipt(alice, sessionId, resume, first)).toBe(false)
  expect(await store.acknowledgePendingReceipt(bob, sessionId, resume, current)).toBe(false)
  expect(await store.acknowledgePendingReceipt(alice, sessionId, resume, current)).toBe(true)
  expect(await store.acknowledgePendingReceipt(alice, sessionId, resume, current)).toBe(false)
  await ensure(2)
  await store.recordPendingCodexReceipt(sessionId, 'native-b', 'native-hook')
  expect(await store.acknowledgePendingReceipt(alice, sessionId, resume, current)).toBe(false)
  frames.length = 0
  await store.replayPendingReceiptsForOwner(alice, (frame) => frames.push(frame))
  expect(frames).toMatchObject([{ receipt: { attemptId: 'attempt-2', observerGeneration: 2 } }])
})


it('keeps hook and process evidence without replaying superseded same-value receipts', async () => {
  const store = await BindingStore.open({ dir: join(await tempRoot(), 'bindings') })
  const sessionId = asSessionId('shared-native-discovery')
  await store.ensureBinding({ sessionId, agentKind: 'codex', claimantMachineId: machine,
    delegation: serverDelegation('actor', alice) })
  await store.recordPendingCodexReceipt(sessionId, 'native', 'process')
  await store.recordPendingCodexReceipt(sessionId, 'native', 'native-hook')
  const binding = (await store.read(sessionId))!
  expect(binding.state).toBe('bound')
  expect(binding.observations.map((entry) => entry.source)).toEqual(['process', 'native-hook'])
  await store.acknowledgePendingReceipt(alice, sessionId, { kind: 'codex-thread', value: 'native' },
    binding.observations.at(-1)!.receipt)
  expect(await store.pendingReceiptsForOwner(alice)).toEqual([])
  expect(await store.replayPendingReceiptForSession(sessionId, () => { throw new Error('unexpected replay') })).toBe(0)
})


it('issues a new receipt after a machine move even when native identity and incarnation match', async () => {
  const store = await BindingStore.open({ dir: join(await tempRoot(), 'bindings') })
  const sessionId = asSessionId('machine-receipt')
  const input = { sessionId, agentKind: 'codex' as const, claimantMachineId: machine,
    delegation: serverDelegation('actor', alice) }
  await store.ensureBinding(input)
  await store.recordPendingCodexReceipt(sessionId, 'native', 'native-hook')
  const old = (await store.read(sessionId))!.observations.at(-1)!.receipt!
  const moved = asMachineId('machine-b')
  await store.ensureBinding({ ...input, claimantMachineId: moved })
  const resume = { kind: 'codex-thread', value: 'native' }
  expect(await store.acknowledgePendingReceipt(alice, sessionId, resume, old)).toBe(false)
  await store.recordPendingCodexReceipt(sessionId, 'native', 'native-hook')
  const current = (await store.read(sessionId))!.observations.at(-1)!.receipt!
  expect(current.machineId).toBe(moved)
  expect(current.id).not.toBe(old.id)
  expect(await store.acknowledgePendingReceipt(alice, sessionId, resume, current)).toBe(true)
})

describe('pending receipt fencing (POD-4299)', () => {
  it('skips a pending receipt fenced by owner change', async () => {
    const store = await BindingStore.open({ dir: join(await tempRoot(), 'bindings') })
    const sessionId = asSessionId('fenced-owner')
    await store.ensureBinding({ sessionId, agentKind: 'codex', claimantMachineId: machine,
      attemptId: 'attempt-1', observationGeneration: 1, delegation: serverDelegation('actor', alice) })
    await store.recordPendingCodexReceipt(sessionId, 'native-owner', 'native-hook')
    // Positive control: the receipt is pending before the owner moves.
    expect(await store.pendingReceiptsForOwner(alice)).toEqual([
      { sessionId, nativeKind: 'codex-thread', value: 'native-owner' },
    ])
    await store.ensureBinding({ sessionId, agentKind: 'codex', claimantMachineId: machine,
      attemptId: 'attempt-1', observationGeneration: 1, delegation: serverDelegation('actor', bob) })
    const binding = requiredBinding(await store.read(sessionId))
    // The superseded evidence stays on disk; only its replay is fenced.
    expect(binding.observations).toHaveLength(1)
    expect(binding.observations[0]!.pendingServerAck).toEqual({ nativeKind: 'codex-thread', value: 'native-owner' })
    expect(binding.observations[0]!.receipt?.ownerId).toBe(alice)
    // The stale receipt must be skipped for the new owner, not acknowledged.
    expect(await store.pendingReceiptsForOwner(bob)).toEqual([])
    expect(await store.pendingReceiptsForOwner(alice)).toEqual([])
    expect(await store.replayPendingReceiptsForOwner(bob, () => { throw new Error('stale receipt replayed') })).toBe(0)
  })

  it('skips a pending receipt fenced by attempt change', async () => {
    const store = await BindingStore.open({ dir: join(await tempRoot(), 'bindings') })
    const sessionId = asSessionId('fenced-attempt')
    await store.ensureBinding({ sessionId, agentKind: 'codex', claimantMachineId: machine,
      attemptId: 'attempt-1', observationGeneration: 1, delegation: serverDelegation('actor', alice) })
    await store.recordPendingCodexReceipt(sessionId, 'native-attempt', 'native-hook')
    expect(await store.pendingReceiptsForOwner(alice)).toEqual([
      { sessionId, nativeKind: 'codex-thread', value: 'native-attempt' },
    ])
    await store.ensureBinding({ sessionId, agentKind: 'codex', claimantMachineId: machine,
      attemptId: 'attempt-2', observationGeneration: 1, delegation: serverDelegation('actor', alice) })
    const binding = requiredBinding(await store.read(sessionId))
    expect(binding.observations).toHaveLength(1)
    expect(binding.observations[0]!.pendingServerAck).toEqual({ nativeKind: 'codex-thread', value: 'native-attempt' })
    expect(await store.pendingReceiptsForOwner(alice)).toEqual([])
    expect(await store.replayPendingReceiptsForOwner(alice, () => { throw new Error('stale receipt replayed') })).toBe(0)
  })

  it('skips a pending receipt fenced by observation-generation change', async () => {
    const store = await BindingStore.open({ dir: join(await tempRoot(), 'bindings') })
    const sessionId = asSessionId('fenced-generation')
    await store.ensureBinding({ sessionId, agentKind: 'codex', claimantMachineId: machine,
      attemptId: 'attempt-1', observationGeneration: 1, delegation: serverDelegation('actor', alice) })
    await store.recordPendingCodexReceipt(sessionId, 'native-generation', 'native-hook')
    expect(await store.pendingReceiptsForOwner(alice)).toEqual([
      { sessionId, nativeKind: 'codex-thread', value: 'native-generation' },
    ])
    await store.ensureBinding({ sessionId, agentKind: 'codex', claimantMachineId: machine,
      attemptId: 'attempt-1', observationGeneration: 2, delegation: serverDelegation('actor', alice) })
    const binding = requiredBinding(await store.read(sessionId))
    expect(binding.observations).toHaveLength(1)
    expect(binding.observations[0]!.pendingServerAck).toEqual({ nativeKind: 'codex-thread', value: 'native-generation' })
    expect(await store.pendingReceiptsForOwner(alice)).toEqual([])
    expect(await store.replayPendingReceiptsForOwner(alice, () => { throw new Error('stale receipt replayed') })).toBe(0)
  })

  it('preserves superseded evidence without replaying it over a newer binding', async () => {
    const store = await BindingStore.open({ dir: join(await tempRoot(), 'bindings') })
    const sessionId = asSessionId('fenced-superseded')
    await store.ensureBinding({ sessionId, agentKind: 'codex', claimantMachineId: machine,
      attemptId: 'attempt-1', observationGeneration: 1, delegation: serverDelegation('actor', alice) })
    await store.recordPendingCodexReceipt(sessionId, 'native-old', 'native-hook')
    await store.recordPendingCodexReceipt(sessionId, 'native-new', 'native-hook')
    const binding = requiredBinding(await store.read(sessionId))
    // Both observations stay on disk with their pending state intact.
    expect(binding.observations.map((entry) => entry.value)).toEqual(['native-old', 'native-new'])
    expect(binding.observations[0]!.pendingServerAck).toEqual({ nativeKind: 'codex-thread', value: 'native-old' })
    expect(binding.observations[1]!.pendingServerAck).toEqual({ nativeKind: 'codex-thread', value: 'native-new' })
    // Only the latest observation replays; the superseded one is never replayed over it.
    expect(await store.pendingReceiptsForOwner(alice)).toEqual([
      { sessionId, nativeKind: 'codex-thread', value: 'native-new' },
    ])
    const frames: import('@podium/protocol/daemon').DaemonMessage[] = []
    expect(await store.replayPendingReceiptsForOwner(alice, (frame) => frames.push(frame))).toBe(1)
    expect(frames).toMatchObject([{ resume: { value: 'native-new' } }])
  })
})
