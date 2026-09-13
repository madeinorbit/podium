import { ISSUE_PRIVATE_EXECUTION_KEYS, firstAdminMemberId } from '@podium/model'
import type { IssueExecutionProjection, IssueWire, SessionMeta, SharedIssueWire } from '@podium/model'
import type { MetadataChange, ServerMessage } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { attachTestClient } from './test-support/client-transport'
import { openTestStore } from './test-support/open-test-store'

// The split fan-out + catch-up seam (docs/spec/oplog-read-path.md §2.3-2.5):
// delta-cap clients receive per-entity metadataDelta batches, legacy clients keep
// the full-list snapshots byte-for-byte, and sync.changesSince converges a stale
// cursor onto the same state a fresh snapshot would give.
describe('SessionRegistry metadata deltas', () => {
  const registries: SessionRegistry[] = []
  afterEach(async () => {
    for (const r of registries.splice(0)) await r.dispose()
  })

  async function makeRegistry(): Promise<SessionRegistry> {
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    registries.push(registry)
    return registry
  }

  async function makeLegacyRegistry(): Promise<SessionRegistry> {
    const registry = await SessionRegistry.create(await openTestStore(':memory:'), undefined, { instanceId: 'default' })
    registries.push(registry)
    return registry
  }

  async function client(registry: SessionRegistry, caps?: string[]): Promise<{ inbox: ServerMessage[] }> {
    const inbox: ServerMessage[] = []
    const id = attachTestClient(registry.clientGateway, (msg) => inbox.push(msg))
    await registry.clientGateway.routeClientFrame(id, {
      type: 'hello',
      wireVersion: 2,
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      ...(caps ? { caps } : {}),
    })
    await expect.poll(() => inbox.some((m) => m.type === 'feedBootstrap' && m.last)).toBe(true)
    return { inbox }
  }

  const deltas = (inbox: ServerMessage[]): MetadataChange[] =>
    inbox.flatMap((message) => {
      if (message.type === 'metadataDelta') return message.changes
      if (message.type !== 'feedDelta') return []
      return message.changes
        .filter((change) => change.op !== 'evict')
        .map((change) => ({ ...change, id: change.entityId }) as MetadataChange)
    })

  /** Emission is coalesced at microtask level since #256 (one ordered pipe);
   *  flush deterministically before reading a delta client's inbox. */
  const flush = (registry: SessionRegistry): void => registry.modules.funnel.flushDeltas()

  /** FLUSH, THEN READ — and why a bare `length` read is not safe here [PDM-405].
   *
   *  One issue write declares THREE rows in its own commit span (`issue`,
   *  `issueProjection`, and B4's owner-scoped `issueExecution` sidecar), and an
   *  event the write appends publishes a FOURTH on a LATER span, through
   *  `IssueEventFeedPublisher`. So a create's rows reach a client in two
   *  batches, and any read that stops on a COUNT can latch on the first batch
   *  and report a prefix as though it were the whole contract. Polling the
   *  sorted ENTITY LIST instead fails on a short read AND on a long one, which
   *  is the property the count never had. */
  const entitiesAfter = (
    registry: SessionRegistry,
    inbox: ServerMessage[],
    from: number,
  ): string[] => {
    flush(registry)
    return deltas(inbox.slice(from))
      .map((change) => change.entity)
      .sort()
  }

  it('sends canonical per-entity deltas regardless of the retired metadataDelta cap', async () => {
    const registry = await makeLegacyRegistry()
    const legacy = await client(registry)
    const delta = await client(registry, ['metadataDelta'])
    const legacyBefore = legacy.inbox.length
    const deltaBefore = delta.inbox.length

    await registry.issues.create({ repoPath: '/r', title: 'first', startNow: false })
    flush(registry)

    // FOUR ROWS ON A CREATE, ACROSS TWO BATCHES — and the count is the half of
    // this test that went stale [PDM-405]. The write's own commit span declares
    // `issue`, `issueProjection` and the owner-scoped `issueExecution` sidecar
    // [B4, PDM-136]; the `issue.created` event the create appends publishes
    // `issueEvent` on a SECOND span, through `IssueEventFeedPublisher`.
    //
    // This test used to poll for THREE rows, which was the whole contract before
    // the sidecar existed. After B4 the three it waited for were the commit
    // span's three, the poll latched the instant they landed, and the read that
    // followed ran BEFORE the event batch — so `issueEvent` looked as if it had
    // been displaced by `issueExecution` when in truth nothing had happened to
    // it at all. Polling the sorted entity list is what removes the barrier: it
    // fails on a missing row and on an extra one alike.
    const expected = ['issue', 'issueEvent', 'issueExecution', 'issueProjection']
    await expect.poll(() => entitiesAfter(registry, legacy.inbox, legacyBefore)).toEqual(expected)
    await expect.poll(() => entitiesAfter(registry, delta.inbox, deltaBefore)).toEqual(expected)

    // Wire v2 is canonical; the retired cap no longer selects a second entity path.
    const legacyNew = legacy.inbox.slice(legacyBefore)
    expect(legacyNew.some((m) => m.type === 'feedDelta')).toBe(true)
    expect(legacyNew.some((m) => m.type === 'metadataDelta')).toBe(false)

    // Both clients receive the same scoped feed; capabilities do not widen it.
    const deltaNew = delta.inbox.slice(deltaBefore)
    expect(deltaNew.some((m) => m.type === 'issuesChanged')).toBe(false)
    const changes = deltas(deltaNew)
    const residue = changes.find((change) => change.entity === 'issue')
    expect(residue).toMatchObject({ entity: 'issue', op: 'upsert' })
    expect((residue?.value as IssueWire).title).toBe('first')
    // The event row is the create's own, not some unrelated feed traffic that
    // happened to arrive inside the window — a list assertion alone would accept
    // either, and then this test would still pass with `issue.created` dropped
    // from the feed vocabulary.
    const event = changes.find((change) => change.entity === 'issueEvent')
    expect(event?.value).toMatchObject({ kind: 'issue.created', subject: residue?.id })
  })

  it('a single-issue update touches one canonical row and never rebuilds the bystander (#22)', async () => {
    const registry = await makeRegistry()
    const w = await registry.issues.create({ repoPath: '/r', title: 'solo', startNow: false })
    await registry.issues.create({ repoPath: '/r', title: 'bystander', startNow: false })
    flush(registry) // drain the setup writes' pending batch before the clients attach
    const legacy = await client(registry)
    const delta = await client(registry, ['metadataDelta'])
    const legacyBefore = legacy.inbox.length
    const deltaBefore = delta.inbox.length

    // ---- LEG A: a write that moves NO private execution key -----------------
    //
    // TWO rows, and the SIDECAR'S ABSENCE IS THE CONTRACT, not a lost update
    // [PDM-405]. `notes` is a shared field; it moves none of
    // `ISSUE_PRIVATE_EXECUTION_KEYS`, so `toExecutionWire` of the new projection
    // is byte-identical to the row the ledger already holds and the ledger drops
    // no-op upserts (`Ledger.commit`). The producer declared the sidecar on this
    // write exactly as it does on every write — the ledger is what decided there
    // was nothing to say.
    //
    // AND THE `issueExecution` THIS LIST NAMED WAS NEVER TRUE HERE. B4
    // (303531aff) added it to both of this test's kind lists and left the
    // `toBe(2)` poll two lines above them untouched — a list of three beside a
    // count of two, in one test, which is the tell that the edit was not re-run.
    // So the stale half was the ENTITY LIST and not the count: two was always
    // the right number for a notes edit, before B4 and after it. (The other
    // failing assertion, on the create path, B4 never touched at all.)
    //
    // Leg B below is what keeps this leg honest, because "two rows, no sidecar"
    // is also what a producer that had stopped emitting the sidecar ENTIRELY
    // would look like.
    await registry.issues.update(w.id, { notes: 'self-contained edit' })
    flush(registry)

    const unchangedHalf = ['issue', 'issueProjection']
    await expect
      .poll(() => entitiesAfter(registry, legacy.inbox, legacyBefore))
      .toEqual(unchangedHalf)
    await expect
      .poll(() => entitiesAfter(registry, delta.inbox, deltaBefore))
      .toEqual(unchangedHalf)

    const legacyNew = legacy.inbox.slice(legacyBefore)
    expect(legacyNew.map((m) => m.type)).toEqual(['feedDelta'])
    const legacyChanges = deltas(legacyNew)
    expect(legacyChanges.every((change) => change.id === w.id)).toBe(true)
    // The cap-advertising peer observes the same canonical rows.
    const changes = deltas(delta.inbox.slice(deltaBefore))
    expect(changes.every((change) => change.id === w.id && change.op === 'upsert')).toBe(true)
    const residue = changes.find((change) => change.entity === 'issue')
    expect((residue as { value: SharedIssueWire }).value.notes).toBe('self-contained edit')

    // ---- LEG B: the counterfactual — a write that DOES move one -------------
    //
    // The same update seam, one private key changed, and now the sidecar rides.
    // Without this leg, leg A's two-row assertion would pass just as happily
    // against a build whose sidecar producer had been deleted, and the whole
    // "private half" guarantee would rest on a test that cannot tell carriage
    // from silence.
    const legacyMoved = legacy.inbox.length
    const deltaMoved = delta.inbox.length
    await registry.issues.update(w.id, { worktreePath: '/wt/solo' })
    flush(registry)

    const movedHalf = ['issue', 'issueExecution', 'issueProjection']
    await expect.poll(() => entitiesAfter(registry, legacy.inbox, legacyMoved)).toEqual(movedHalf)
    await expect.poll(() => entitiesAfter(registry, delta.inbox, deltaMoved)).toEqual(movedHalf)

    // Still one issue's rows: moving a private key does not rebuild the
    // bystander either (#22 holds for both halves, not just the shared one).
    const movedChanges = deltas(delta.inbox.slice(deltaMoved))
    expect(movedChanges.every((change) => change.id === w.id && change.op === 'upsert')).toBe(true)

    // OWNER-SIDE CARRIAGE: the moved key reaches the owner ON THE SIDECAR.
    const sidecar = movedChanges.find((change) => change.entity === 'issueExecution')
    const execution = sidecar?.value as IssueExecutionProjection
    expect(execution.issueId).toBe(w.id)
    expect(execution.worktreePath).toBe('/wt/solo')

    // AND IT IS THE PRIVATE HALF, NOT A SECOND COPY OF THE PROJECTION. The
    // permitted set is the MODEL's own key list rather than a retyped one, so a
    // fifth private key added to `ISSUE_PRIVATE_EXECUTION_KEYS` arrives here
    // with no edit. A sidecar that started carrying a SHARED field (`notes`,
    // `title`) — which would make the split pointless while every other
    // assertion above still passed — fails here, and the diff NAMES the key it
    // should not be carrying rather than reporting a bare false.
    //
    // SUBSET, not equality: a private key whose value is absent (this issue has
    // no `coordinatorSessionId` and no `startedBySession`) does not survive the
    // wire as a key, so an equality assertion would be pinning which of the four
    // happen to be set on this fixture rather than the omission property. The
    // other direction — that the sidecar is not empty — is the `worktreePath`
    // assertion immediately above.
    const permitted = new Set<string>(['issueId', ...ISSUE_PRIVATE_EXECUTION_KEYS])
    expect(Object.keys(execution).filter((key) => !permitted.has(key))).toEqual([])
  })

  it('streams session upserts through the same seam', async () => {
    const registry = await makeRegistry()
    const delta = await readyClient(registry, ['metadataDelta'])
    const before = delta.inbox.length
    const { sessionId } = await registry.modules.sessions.createSession({ ownerUserId: firstAdminMemberId(), agentKind: 'shell', cwd: '/w' })
    flush(registry)
    await vi.waitFor(() => {
      expect(deltas(delta.inbox.slice(before)).some((c) => c.entity === 'session' && c.id === sessionId)).toBe(true)
    })
    const changes = deltas(delta.inbox.slice(before)).filter((c) => c.entity === 'session')
    expect(changes.length).toBeGreaterThanOrEqual(1)
    expect(changes[0]).toMatchObject({ entity: 'session', id: sessionId, op: 'upsert' })
    expect((changes[0]?.value as SessionMeta).cwd).toBe('/w')
  })

  it('batches carry seq of the last change and stay in order', async () => {
    const registry = await makeRegistry()
    const delta = await client(registry, ['metadataDelta'])
    await registry.issues.create({ repoPath: '/r', title: 'a', startNow: false })
    await registry.issues.create({ repoPath: '/r', title: 'b', startNow: false })
    flush(registry)
    await expect.poll(() => deltas(delta.inbox).filter((c) => c.entity === 'issueEvent').length).toBe(2)
    const batches = delta.inbox.filter((m) => m.type === 'feedDelta')
    expect(batches.length).toBeGreaterThan(0)
    let prev = 0
    for (const b of batches) {
      expect(b.changes.at(-1)?.seq).toBe(b.seq)
      for (const c of b.changes) {
        expect(c.seq).toBeGreaterThan(prev)
        prev = c.seq
      }
    }
  })

  it('changesSince: snapshot on null cursor, delta after, snapshot-equivalent replay', async () => {
    const registry = await makeRegistry()
    await registry.issues.create({ repoPath: '/r', title: 'a', startNow: false })

    const boot = await registry.modules.sessions.syncChangesSince(null)
    expect(boot.kind).toBe('snapshot')
    if (boot.kind !== 'snapshot') return
    expect(boot.issues.map((i) => i.title)).toEqual(['a'])

    const created = await registry.issues.create({ repoPath: '/r', title: 'b', startNow: false })
    await registry.issues.close(created.id, 'wontfix')
    await registry.modules.sessions.createSession({ ownerUserId: firstAdminMemberId(), agentKind: 'shell', cwd: '/w' })

    const catchUp = await registry.modules.sessions.syncChangesSince(boot.cursor)
    expect(catchUp.kind).toBe('delta')
    if (catchUp.kind !== 'delta') return

    // Replay the delta over the boot snapshot -> must equal a fresh snapshot.
    const fold = <T>(list: T[], key: (t: T) => string, entity: MetadataChange['entity']): T[] => {
      const m = new Map(list.map((t) => [key(t), t]))
      for (const c of catchUp.changes) {
        if (c.entity !== entity) continue
        if (c.op === 'remove') m.delete(c.id)
        else m.set(c.id, c.value as T)
      }
      return [...m.values()]
    }
    const fresh = await registry.modules.sessions.syncChangesSince(null)
    if (fresh.kind !== 'snapshot') throw new Error('expected snapshot')
    const byId = <T>(l: T[], key: (t: T) => string) =>
      [...l].sort((x, y) => key(x).localeCompare(key(y)))
    expect(
      byId(
        fold(boot.issues, (i) => i.id, 'issue'),
        (i) => i.id,
      ),
    ).toEqual(byId(fresh.issues, (i) => i.id))
    expect(
      byId(
        fold(boot.sessions, (s) => s.sessionId, 'session'),
        (s) => s.sessionId,
      ),
    ).toEqual(byId(fresh.sessions, (s) => s.sessionId))
    expect(catchUp.cursor).toBe(fresh.cursor)
  })

  // POD-333: tuck-away used to be a per-browser ui-state key, so a second open
  // client never learned about a dismissal and a reconnecting one came back
  // showing the row live again. Now it is an issue field and rides this seam.
  it('a tuck reaches other live clients and heals a reconnecting one', async () => {
    const registry = await makeRegistry()
    const w = await registry.issues.create({ repoPath: '/r', title: 'finished', startNow: false })
    await registry.issues.close(w.id)
    flush(registry)

    // The cursor a client held while it was away — nothing tucked yet.
    const away = await registry.modules.sessions.syncChangesSince(null)
    if (away.kind !== 'snapshot') throw new Error('expected snapshot')
    expect(away.issues.find((i) => i.id === w.id)?.tuckedAt ?? null).toBeNull()

    // A SECOND client is watching while the first one tucks.
    const other = await client(registry, ['metadataDelta'])
    const before = other.inbox.length
    await registry.issues.setIssueTucked(w.id, true)
    flush(registry)

    await expect.poll(() => deltas(other.inbox.slice(before)).filter((c) => c.entity === 'issue').length).toBe(1)
    const seen = deltas(other.inbox.slice(before)).filter((c) => c.entity === 'issue')
    expect(seen).toHaveLength(1)
    expect((seen[0] as { value: SharedIssueWire }).value.tuckedAt).toBeTruthy()

    // And the client that was disconnected converges through catch-up rather
    // than painting the stale un-tucked row from its own storage.
    const healed = await registry.modules.sessions.syncChangesSince(away.cursor)
    expect(healed.kind).toBe('delta')
    if (healed.kind !== 'delta') return
    const change = healed.changes.find((c) => c.entity === 'issue' && c.id === w.id)
    expect((change as { value: SharedIssueWire } | undefined)?.value.tuckedAt).toBeTruthy()
  })

  it('a pre-hello client receives no entity world until it announces an eviction-capable wire', async () => {
    const registry = await makeRegistry()
    const inbox: ServerMessage[] = []
    attachTestClient(registry.clientGateway, (msg) => inbox.push(msg)) // no hello at all
    // Attachment still sends control-plane snapshots asynchronously.
    await expect.poll(() => inbox.some((m) => m.type === 'approvalsChanged')
      && inbox.some((m) => m.type === 'machinesChanged')).toBe(true)
    expect(inbox.some((message) => message.type === 'feedBootstrap')).toBe(false)
    const before = inbox.length
    await registry.issues.create({ repoPath: '/r', title: 'x', startNow: false })
    flush(registry)
    expect(inbox.some((m) => m.type === 'metadataDelta')).toBe(false)
    expect(inbox).toHaveLength(before)
  })
})

// Observe session publication only after hello has delivered the final bootstrap chunk.
async function readyClient(registry: SessionRegistry, caps: string[]) {
  const inbox: ServerMessage[] = []
  const id = attachTestClient(registry.clientGateway, (message) => inbox.push(message))
  await registry.clientGateway.routeClientFrame(id, {
    type: 'hello',
    clientId: '',
    wireVersion: 2,
    viewport: { cols: 80, rows: 24, dpr: 1 },
    caps,
  })
  await vi.waitFor(() => {
    expect(inbox.some((message) => message.type === 'feedBootstrap' && message.last)).toBe(true)
  })
  return { inbox }
}
