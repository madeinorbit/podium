/**
 * POD-4971 (step 5a of POD-4949) — MAIL ELIGIBILITY READS THE NORMALIZED RECORD.
 *
 * The relay's `oplog.appended` listener decides which issues to re-examine for
 * held mail. Until this step it listened only for the old record (`issue`,
 * IssueProjection); step 7 stops sending that record, and a listener still keyed on
 * it would then stop mail without an error anywhere. These two tests pin which
 * record is the trigger, over a real registry, by taking one of the two kinds
 * out of the bus before the listener sees it:
 *
 *   - ONLY the normalized record (`issueProjection`) reaches the listener: held
 *     mail is delivered. With the old trigger this fails.
 *   - ONLY the old record reaches it: the issue is not re-examined. This is the
 *     proof that nothing still depends on the old record.
 *
 * The scenario is the one issue-side change the trigger exists for: a session
 * already sits in a directory, unattached; the issue then takes that directory
 * as its worktree, so the session becomes the issue's member and the held mail
 * can go to it. No session row changes, so no session trigger can mask a
 * missing issue trigger.
 */

import type { SessionId } from '@podium/model'
import type { MetadataChange } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { attachHostDaemon } from './test-support/host-daemon'

const WORKTREE = '/repo/.worktrees/target'
const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const reg of registries.splice(0)) await reg.dispose()
})

type DurableSendRequest = Extract<ControlMessage, { type: 'runtimeDurableSendRequest' }>
const durableSends = (daemon: ControlMessage[], sessionId: SessionId): DurableSendRequest[] =>
  daemon.filter(
    (message): message is DurableSendRequest =>
      message.type === 'runtimeDurableSendRequest' && message.sessionId === sessionId,
  )

/** A registry whose bus drops one issue kind from every `oplog.appended`, so
 *  its listeners see the feed as a server sending only the other kind. */
async function heldIssueMail(dropped: MetadataChange['entity']) {
  const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  registries.push(reg)
  const daemon: ControlMessage[] = []
  await attachHostDaemon(reg, (message) => daemon.push(message), { repos: ['/repo'] })
  const issue = await reg.modules.issues.create({
    repoPath: '/repo',
    title: 'Mail target',
    startNow: false,
  })
  const { sessionId } = await reg.modules.sessions.createSession({
    agentKind: 'claude-code',
    cwd: WORKTREE,
  })
  await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: WORKTREE,
    agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 },
  })
  const sent = await reg.modules.messages.send(
    { kind: 'operator' },
    { to: { kind: 'issue', id: issue.id }, body: 'held until the issue owns the worktree' },
  )
  await reg.modules.messages.flushDeliveryTriggers()
  // Held: the issue has no member yet, so nothing went to the session.
  expect(durableSends(daemon, sessionId)).toEqual([])

  // Subscribed BEFORE the cause. Every batch that carried this issue, as it
  // reached the listeners, is recorded, so the negative test can tell "the
  // batch arrived and was ignored" from "the batch has not arrived yet".
  const seen: MetadataChange[][] = []
  const emit = reg.bus.emit.bind(reg.bus)
  vi.spyOn(reg.bus, 'emit').mockImplementation(((event: string, payload: unknown) => {
    if (event !== 'oplog.appended') return emit(event as never, payload as never)
    const { changes } = payload as { changes: MetadataChange[] }
    const kept = changes.filter((change) => change.entity !== dropped)
    if (changes.some((change) => change.id === issue.id)) seen.push(kept)
    return emit('oplog.appended', { changes: kept })
  }) as typeof reg.bus.emit)
  const examined: string[][] = []
  const recompute = reg.modules.messages.onIssuesEligibilityChanged.bind(reg.modules.messages)
  vi.spyOn(reg.modules.messages, 'onIssuesEligibilityChanged').mockImplementation(async (ids) => {
    examined.push([...ids])
    await recompute(ids)
  })

  await reg.modules.issues.update(issue.id, { worktreePath: WORKTREE })
  return { reg, daemon, sessionId, sent, issue, seen, examined }
}

describe('mail eligibility triggers on the normalized issue record (POD-4971)', () => {
  it('delivers held issue mail when only the normalized record is published', async () => {
    const { reg, daemon, sessionId, sent, seen } = await heldIssueMail('issue')
    await vi.waitFor(() =>
      expect(seen.flat().map((change) => change.entity)).toContain('issueProjection'),
    )
    await vi.waitFor(async () => {
      await reg.modules.messages.flushDeliveryTriggers()
      expect(durableSends(daemon, sessionId).map((send) => send.rowId)).toEqual([sent.message.id])
    })
  })

  it('does not re-examine the issue when only the old record is published', async () => {
    const { reg, daemon, sessionId, issue, seen, examined } = await heldIssueMail('issueProjection')
    // The old record did arrive, and the listener did run over it ...
    await vi.waitFor(() => expect(seen.flat().map((change) => change.entity)).toContain('issue'))
    await vi.waitFor(() => expect(examined.length).toBeGreaterThan(0))
    await reg.modules.messages.flushDeliveryTriggers()
    // ... and named nothing: the old record is no longer a trigger.
    expect(examined.flat()).not.toContain(issue.id)
    expect(durableSends(daemon, sessionId)).toEqual([])
  })
})
