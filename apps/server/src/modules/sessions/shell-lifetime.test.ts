/**
 * SHELL LIFETIME TRIGGERS (POD-4435): the tab-release edge and the
 * issue-close / worktree-free upgrade, against a real registry.
 *
 * - releaseShellTab kills an untouched shell and keeps a touched one;
 * - stopSession tombstones an untouched, unheld shell whose owner is gone
 *   (closed issue) instead of parking it, and still parks touched shells;
 * - the tabRelease client frame forwards through client control with the same
 *   attach-grade authorization (silence otherwise).
 */

import { asSessionId, firstAdminMemberId } from '@podium/model'
import type { ServerMessage, SessionId } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../relay'
import { testClientPrincipal } from '../../test-support/client-principal'
import { openTestStore } from '../../test-support/open-test-store'
import type { ClientConn } from '../../gateway/client-registry'
import type { ControlMessage } from '@podium/protocol/daemon'
import { SessionClientControl } from './client-control'
import type { SessionInbox } from './inbox'
import type { Session } from './session'
import type { SessionLifecycle } from './lifecycle'

const registries: SessionRegistry[] = []

afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose()
})

async function makeRegistry(): Promise<{ reg: SessionRegistry; daemon: ControlMessage[] }> {
  const store = await openTestStore(':memory:')
  await store.machines.upsertMachine({
    id: store.hostMachineId,
    name: 'test-host',
    hostname: 'test-host',
    tokenHash: 'test',
    ownerUserId: await firstAdminMemberId(store),
    assignment: { server: true, agentExecution: true },
  })
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  const daemon: ControlMessage[] = []
  await reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, (m) => daemon.push(m))
  await reg.sessionStore.repos.addRepo(
    '/r',
    reg.sessionStore.hostMachineId,
    'git@github.com:example/r.git',
  )
  const rpc = (
    reg.modules.sessions as unknown as {
      rpc: {
        runtimeLifecycle: (
          input: { sessionId: string; verb: 'stop' | 'hibernate' | 'kill' },
          machineId: string,
        ) => Promise<{ sessionId: string; result: { ok: true; retirement?: 'confirmed' } }>
      }
    }
  ).rpc
  rpc.runtimeLifecycle = async (input) => {
    daemon.push({ type: 'runtimeLifecycleRequest', requestId: 'fixture', ...input } as ControlMessage)
    return { sessionId: input.sessionId, result: { ok: true, retirement: 'confirmed' } }
  }
  return { reg, daemon }
}

function lifecycleOf(reg: SessionRegistry): SessionLifecycle {
  return reg.modules.sessions as unknown as SessionLifecycle
}

function liveSession(reg: SessionRegistry, sessionId: SessionId): Session {
  const session = lifecycleOf(reg).sessions.get(sessionId)
  if (!session) throw new Error(`no live session ${sessionId}`)
  return session
}

function stubClient(id: string): ClientConn & { sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  return {
    id,
    principal: testClientPrincipal(id),
    send: (m: ServerMessage) => sent.push(m),
    viewports: new Map(),
    viewportSeq: new Map(),
    attached: new Set(),
    caps: new Set(),
    wireVersion: 1,
    transcriptSubs: new Set(),
    visible: true,
    viewVisible: new Set(),
    focused: null,
    viewModes: {},
    sent,
  }
}

/** Type into the shell through its terminal: first attach becomes controller. */
function typeInto(session: Session, clientId: string, text: string): void {
  session.terminal.attachClient(stubClient(clientId) as ClientConn)
  session.terminal.handleInput(clientId, Buffer.from(text).toString('base64'))
}

async function liveIds(reg: SessionRegistry): Promise<SessionId[]> {
  return (await reg.modules.sessions.listSessions(undefined, 'rpc')).map((s) => s.sessionId)
}

describe('releaseShellTab (tab-release trigger)', () => {
  it('kills an untouched shell: the row is tombstoned, not parked', async () => {
    const { reg } = await makeRegistry()
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/proj',
    })

    await lifecycleOf(reg).releaseShellTab(sessionId, 'c-reporter')

    expect(await liveIds(reg)).not.toContain(sessionId)
  })

  it('keeps a touched shell live, with its scrollback intact', async () => {
    const { reg } = await makeRegistry()
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/proj',
    })
    typeInto(liveSession(reg, sessionId), 'c-typer', 'echo hi\n')

    await lifecycleOf(reg).releaseShellTab(sessionId, 'c-reporter')

    expect(await liveIds(reg)).toContain(sessionId)
    expect(liveSession(reg, sessionId).status).not.toBe('hibernated')
  })

  it('keeps an untouched shell another client still holds: no cross-client kill', async () => {
    const { reg } = await makeRegistry()
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/proj',
    })
    const holder = stubClient('c-holder')
    holder.viewVisible.add(sessionId)
    lifecycleOf(reg).clients.add(holder as ClientConn)

    await lifecycleOf(reg).releaseShellTab(sessionId, 'c-reporter')

    expect(await liveIds(reg)).toContain(sessionId)
  })

  it('ignores non-shell sessions and unknown ids', async () => {
    const { reg } = await makeRegistry()
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/proj',
    })

    await lifecycleOf(reg).releaseShellTab(sessionId, 'c-reporter')
    await lifecycleOf(reg).releaseShellTab(asSessionId('nope'), 'c-reporter')

    expect(await liveIds(reg)).toContain(sessionId)
  })
})

describe('stopSession shell upgrade (issue-close / worktree-free trigger)', () => {
  it('tombstones an untouched, unheld shell on a closed issue instead of parking it', async () => {
    const { reg } = await makeRegistry()
    const issue = await reg.modules.issues.create({
      repoPath: '/r',
      title: 'Closed work',
      startNow: false,
    })
    await reg.modules.issues.update(issue.id, { stage: 'done' })
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r',
      issueId: issue.id,
    })

    const r = await reg.modules.issueSessionLifecycle.stopSession({ sessionId })

    expect(r.ok).toBe(true)
    expect(await liveIds(reg)).not.toContain(sessionId)
  })

  it('still parks a touched shell on a closed issue', async () => {
    const { reg } = await makeRegistry()
    const issue = await reg.modules.issues.create({
      repoPath: '/r',
      title: 'Closed work',
      startNow: false,
    })
    await reg.modules.issues.update(issue.id, { stage: 'done' })
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r',
      issueId: issue.id,
    })
    typeInto(liveSession(reg, sessionId), 'c-typer', 'make test\n')

    const r = await reg.modules.issueSessionLifecycle.stopSession({ sessionId })

    expect(r.ok).toBe(true)
    const meta = (await reg.modules.sessions.listSessions(undefined, 'rpc')).find(
      (s) => s.sessionId === sessionId,
    )
    expect(meta?.status).toBe('hibernated')
  })

  it('still parks an untouched shell whose issue is open (owner not gone)', async () => {
    const { reg } = await makeRegistry()
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/proj',
    })

    const r = await reg.modules.issueSessionLifecycle.stopSession({ sessionId })

    expect(r.ok).toBe(true)
    const meta = (await reg.modules.sessions.listSessions(undefined, 'rpc')).find(
      (s) => s.sessionId === sessionId,
    )
    expect(meta?.status).toBe('hibernated')
  })
})

describe('tabRelease client frame', () => {
  function control(
    session: Session,
    onTabRelease: (sessionId: SessionId, reporterClientId: string) => void,
  ): { ctl: SessionClientControl; client: ClientConn & { sent: ServerMessage[] } } {
    const sessions = new Map([[session.sessionId, session]])
    const client = stubClient('c1')
    const ctl = new SessionClientControl({
      sessions,
      state: { replayDrafts: vi.fn(), handleDraftEdit: vi.fn() } as never,
      inbox: {} as SessionInbox as never,
      machinesForPrincipal: async () => [],
      browserOpen: { submitCallback: vi.fn(), dismiss: vi.fn() } as never,
      mutate: () => {},
      broadcastSessions: vi.fn(),
      pushPriorities: vi.fn(),
      setDraft: vi.fn(),
      editDraft: vi.fn(),
      sessionOwner: async () => ({ owner: await firstAdminMemberId(), grants: [] }),
      machineUseFor: async () => 'granted' as const,
      onTabRelease: (sessionId, reporterClientId) => onTabRelease(sessionId, reporterClientId),
    })
    return { ctl, client }
  }

  it('forwards an authorized release to the policy trigger', async () => {
    const { reg } = await makeRegistry()
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/proj',
    })
    const seen: { sessionId: SessionId; reporter: string }[] = []
    const { ctl, client } = control(liveSession(reg, sessionId), (id, reporter) =>
      seen.push({ sessionId: id, reporter }),
    )

    await ctl.onFrame(client.principal, client, { type: 'tabRelease', sessionId })

    expect(seen).toEqual([{ sessionId, reporter: 'c1' }])
    expect(client.sent).toEqual([])
  })

  it('stays silent for a session the caller cannot see', async () => {
    const { reg } = await makeRegistry()
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/proj',
    })
    const seen: SessionId[] = []
    const sessions = new Map([[sessionId, liveSession(reg, sessionId)]])
    const client = stubClient('c1')
    const ctl = new SessionClientControl({
      sessions,
      state: { replayDrafts: vi.fn(), handleDraftEdit: vi.fn() } as never,
      inbox: {} as SessionInbox as never,
      machinesForPrincipal: async () => [],
      browserOpen: { submitCallback: vi.fn(), dismiss: vi.fn() } as never,
      mutate: () => {},
      broadcastSessions: vi.fn(),
      pushPriorities: vi.fn(),
      setDraft: vi.fn(),
      editDraft: vi.fn(),
      // No resolvable owner: absent and invisible share one denial.
      sessionOwner: async () => undefined,
      machineUseFor: async () => 'granted' as const,
      onTabRelease: (id) => seen.push(id),
    })

    await ctl.onFrame(client.principal, client, { type: 'tabRelease', sessionId })

    expect(seen).toEqual([])
    expect(client.sent).toEqual([])
  })
})
