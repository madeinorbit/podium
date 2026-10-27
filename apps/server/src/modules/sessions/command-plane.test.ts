/**
 * The command plane's ACCEPTANCE properties (POD-381), driven through the real
 * services rather than through mocks: every fixture below is a live
 * `SessionRegistry` from POD-379's oracle harness, and only the PRINCIPAL and
 * the ownership table are synthetic — because those are the two things the
 * transport cannot yet produce (there is one password and no accounts).
 *
 * Why not drive these through `appRouter` like the oracle does: the tRPC caller
 * resolves to the instance's one account by construction, so a second human is
 * unreachable from that seam. Building the context directly is what makes the
 * multi-user answer testable BEFORE POD-1075 lands accounts — and it is the same
 * context the router builds, from the same composition root.
 */

import type { MachineId } from '@podium/model'
import {
  asIssueId,
  asMachineId,
  asSessionId,
  asUserId,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { MachineGrant } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type AgentCommandPrincipal,
  type CommandPrincipal,
  firstAdminMemberId,
} from '../../command-principal'
import type { MachineOwnershipIndex, MachineOwnershipRow } from '../../machine-access'
import { ownershipSnapshotFromMachines } from '../../machine-access'
import { machinesForPrincipal, sessionCommandServices, usableRepos } from './command-ctx'
import {
  bindingPrincipalFor,
  createdOwnership,
  dispatchSessionCommand,
  SESSION_COMMAND_HANDLERS,
  SessionCommandCtx,
  type SessionCommandDeps,
  spawnedByFor,
} from './command-plane'
import { disposeOracles, makeOracle, messageOf } from './oracle-support'
import {
  ambiguousSessionPrefixMessage,
  asyncSessionIssueAccess,
  resolveSessionTarget,
  type SessionAccessDeps,
  type SessionTargetRow,
  type SessionVisibility,
} from './session-access'

afterEach(() => disposeOracles())

const COLLEAGUE: UserId = asUserId('colleague')
const GHOST = '00000000-0000-4000-8000-000000000000'

const human = (id: UserId, role: 'admin' | 'worker' = 'worker'): CommandPrincipal => ({
  kind: 'user',
  user: id,
  // Worker by default, mirroring machine-access.test.ts: POD-3960 gives admins
  // universal `see`, so an admin principal can never be told "unknown machine"
  // and the D20 invisible-identical-to-nonexistent pin below would be
  // unstatable. Scope stays `all` — the operator channel the router resolves.
  capability: { role, scope: { kind: 'all' } },
})

const agentFor = (
  sessionId: string,
  onBehalfOf: UserId,
  chain: SessionId[] = [],
): AgentCommandPrincipal => ({
  kind: 'agent',
  agentSessionId: asSessionId(sessionId),
  onBehalfOf,
  // Worker, as above: the delegation tests pin the `absent` answer after the
  // human's grant is revoked, which an admin-human agent could never produce.
  capability: { role: 'worker', scope: { kind: 'all' }, actorSessionId: asSessionId(sessionId) },
  chain,
})

/** A machine table a test can mutate between two applies. */
function ownershipTable(
  rows: Map<string, { owner: UserId | null; grants: MachineGrant[]; name?: string }>,
  delegated?: Map<string, string[]>,
): MachineOwnershipIndex {
  return {
    rowFor: (machineId): MachineOwnershipRow | undefined => {
      const row = rows.get(machineId)
      if (!row) return undefined
      return {
        machine: machineId as MachineId,
        owner: row.owner,
        // An attached daemon the registry has assigned for agent execution is
        // the posture makeOracle leaves behind; without both flags the
        // assignment/availability split strips `use` from every principal,
        // owner included, and every positive control below fails closed.
        daemonAssigned: true,
        daemonAvailable: true,
        grants: [...(row.owner ? [{ subject: row.owner, verb: 'use' as const }, { subject: row.owner, verb: 'manage' as const, custody: true }] : []), ...row.grants],
        ...(row.name === undefined ? {} : { name: row.name }),
      }
    },
    delegatedMachines: (sessionId) => {
      const allowed = delegated?.get(sessionId)
      return allowed === undefined ? undefined : new Set(allowed)
    },
  }
}

type Oracle = Awaited<ReturnType<typeof makeOracle>>

/** The context the router builds, with the principal and ownership substituted. */
async function ctxFor(
  o: Oracle,
  principal: CommandPrincipal,
  opts: { ownership?: MachineOwnershipIndex; visibility?: SessionVisibility } = {},
): Promise<SessionCommandCtx> {
  const modules = o.reg.modules
  const deps: SessionCommandDeps = {
    sessions: () => sessionCommandServices(modules),
    stageAttachment: (input) => modules.sessions.runtimeGateway.stageAttachment(input),
    holdUpload: async (input) => await modules.pendingUploads.put(input),
    claimUpload: async (issueId, input) =>
      await modules.issues.crud.panelChatUploadClaim(issueId, input),
    isAgentDriven: async (sessionId) => modules.sessions.receiptSender.onContract(sessionId),
    // The chat path's send dispatches the `mail.send` CONTRACT (POD-729), so the
    // fixture binds the port the same way the composition root does — from the
    // principal's own capability, through the real gate. Substituting the
    // delivery service here instead would have let these tests pass while the
    // production path went around the mail policy, which is precisely the
    // bypass POD-729 exists to close.
    mailSend: (input) =>
      modules.messageGate.dispatch(
        'capability' in principal
          ? principal.capability
          : { role: 'admin', scope: { kind: 'all' } },
        undefined,
        'send',
        input,
        'relay',
      )!,

    createDraftIssue: async (repoPath, agentKind, issueId, ownership) =>
      await modules.issues.attention.createDraftFor(repoPath, agentKind, issueId, ownership),
    attachDraftArtifacts: async (issueId, artifacts) => {
      for (const artifact of artifacts) await modules.issues.crud.panelArtifactUpload(issueId, artifact)
    },
    discardUnlaunchedDraft: async (issueId) => await modules.issues.attention.discardUnlaunchedDraft(issueId),
    issueOwner: async () => undefined,
    access: {
      sessionById: async (sessionId) => await modules.sessions.sessionById(sessionId),
      listSessionIds: () => modules.sessions.sessionFacts().map((s) => s.sessionId),
      issues: asyncSessionIssueAccess(modules.issues),
      ...(opts.visibility ? { visibility: opts.visibility } : {}),
    },
    rpc: () => modules.rpc,
    ownership: opts.ownership ?? (await ownershipSnapshotFromMachines(modules.machines)),
    mutations: modules.mutations,
  }
  return new SessionCommandCtx(deps, principal)
}

describe('held chat uploads (POD-2148)', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')

  async function hold(o: Oracle, sessionId: string, pending?: true) {
    const held = await dispatchSessionCommand(
      await ctxFor(o, human(firstAdminMemberId())),
      'uploadImage',
      {
        sessionId: asSessionId(sessionId),
        filename: 'shot.png',
        mimeType: 'image/png',
        dataBase64: png,
        ...(pending ? { pending } : {}),
      },
    )
    if (!('attachment' in held) || !held.attachment) throw new Error('expected a held ref')
    expect(held.path).toBe('')
    expect(held.attachment).not.toHaveProperty('path')
    return held.attachment
  }

  it('create claims the task’s uploads and queues the first prompt with them instead of argv', async () => {
    const o = await makeOracle()
    await provisionHost(o)
    const ref = await hold(o, 'coldstart-5c1f', true)

    const created = await dispatchSessionCommand(
      await ctxFor(o, human(firstAdminMemberId())),
      'create',
      {
        agentKind: 'claude-code',
        cwd: '/p',
        draftIssue: { repoPath: '/p' },
        initialPrompt: 'what is in this picture?',
        attachments: [ref],
      },
    )

    const draft = (await o.reg.issues.reports.list('/p')).find((issue) => issue.draft)
    expect(draft?.panel?.artifacts).toEqual([
      expect.objectContaining({ chatUploadId: ref.id, title: 'shot.png', entry: 'shot.png' }),
    ])
    // Argv carries text alone: the prompt rides a queued row with its file.
    const spawn = o.daemon.filter((m) => m.type === 'spawn').at(-1)
    expect(spawn).toMatchObject({ sessionId: created.sessionId })
    expect(spawn).not.toHaveProperty('initialPrompt')
    const queued = await o.store.sync.listQueuedMessages(created.sessionId)
    expect(queued.map((row) => [row.text, JSON.parse(row.attachmentsJson ?? '[]')])).toEqual([
      ['what is in this picture?', [ref]],
    ])
    // The first bubble's record names the file.
    const prompt = await o.store.messages.getMessage(queued[0]?.sourceMessageId ?? '')
    expect(prompt?.attachments).toEqual([ref])
  })

  it('a create that fails after claiming hands the files back, so the same refs work on retry', async () => {
    const o = await makeOracle()
    await provisionHost(o)
    const ref = await hold(o, 'coldstart-9a2e', true)
    vi.spyOn(o.reg.modules.sessions, 'createSession').mockImplementationOnce(() => {
      throw new Error('unknown model')
    })
    // The purge's artifact cleanup is held until the test lets it go: the
    // create must not reject (and invite a retry) while it is still running.
    const removeIssue = o.reg.modules.issueArtifacts.removeIssue.bind(o.reg.modules.issueArtifacts)
    let letCleanupRun: () => void = () => {}
    const cleanupHeld = new Promise<void>((resolve) => {
      letCleanupRun = resolve
    })
    vi.spyOn(o.reg.modules.issueArtifacts, 'removeIssue').mockImplementationOnce(async (id) => {
      await cleanupHeld
      await removeIssue(id)
    })
    const create = {
      sessionId: asSessionId('5d0c7c1e-3f2a-4b8e-9c61-7a2d4e8f1b03'),
      agentKind: 'claude-code' as const,
      cwd: '/p',
      draftIssue: { repoPath: '/p', issueId: asIssueId('iss_6f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f') },
      initialPrompt: 'what is in this picture?',
      attachments: [ref],
    }

    let settled = false
    const failed = dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId())), 'create', create)
      .finally(() => {
        settled = true
      })
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(o.reg.modules.issueArtifacts.removeIssue).toHaveBeenCalled())
    expect(settled).toBe(false)
    letCleanupRun()
    expect(await failed).toMatchObject({ message: 'unknown model' })
    expect((await o.reg.issues.reports.list('/p')).filter((issue) => issue.draft)).toEqual([])
    expect(await o.reg.modules.pendingUploads.meta(ref.id)).not.toHaveProperty('claimed')

    await dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId())), 'create', create)
    const draft = (await o.reg.issues.reports.list('/p')).find((issue) => issue.draft)
    expect(draft?.panel?.artifacts).toEqual([expect.objectContaining({ chatUploadId: ref.id })])
    expect(await o.reg.issues.crud.chatUploadBytes(asIssueId(draft?.id ?? ''), ref.id)).toEqual(
      new Uint8Array(Buffer.from(png, 'base64')),
    )
  })

  it('a claim whose panel commit fails hands the file back, so the same refs work on retry', async () => {
    const o = await makeOracle()
    await provisionHost(o)
    const ref = await hold(o, 'coldstart-e05f', true)
    vi.spyOn(o.reg.issues.crud, 'panelApply').mockRejectedValueOnce(new Error('revision conflict'))
    const create = {
      sessionId: asSessionId('8b2e4c1a-6d3f-4a7b-9e05-1c2d3e4f5a6b'),
      agentKind: 'claude-code' as const,
      cwd: '/p',
      draftIssue: { repoPath: '/p', issueId: asIssueId('iss_2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d') },
      initialPrompt: 'what is in this picture?',
      attachments: [ref],
    }

    await expect(
      dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId())), 'create', create),
    ).rejects.toThrow('revision conflict')
    expect((await o.reg.issues.reports.list('/p')).filter((issue) => issue.draft)).toEqual([])
    expect(await o.reg.modules.pendingUploads.meta(ref.id)).not.toHaveProperty('claimed')

    await dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId())), 'create', create)
    const draft = (await o.reg.issues.reports.list('/p')).find((issue) => issue.draft)
    expect(await o.reg.issues.crud.chatUploadBytes(asIssueId(draft?.id ?? ''), ref.id)).toEqual(
      new Uint8Array(Buffer.from(png, 'base64')),
    )
  })

  it.each([
    ['moving the file back fails', 'relinquish'],
    ['clearing the claim fails after the move', 'markUnclaimed'],
  ] as const)('a failed claim commit whose rollback fails (%s) still works on retry', async (_label, broken) => {
    const o = await makeOracle()
    await provisionHost(o)
    const ref = await hold(o, `coldstart-${broken}`, true)
    vi.spyOn(o.reg.issues.crud, 'panelApply').mockRejectedValueOnce(new Error('revision conflict'))
    if (broken === 'relinquish') {
      vi.spyOn(o.reg.modules.issueArtifacts, 'relinquish').mockRejectedValueOnce(new Error('EBUSY'))
    } else {
      vi.spyOn(o.reg.modules.pendingUploads, 'markUnclaimed').mockRejectedValueOnce(new Error('EIO'))
    }
    const create = {
      sessionId: asSessionId(
        broken === 'relinquish'
          ? '0e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b'
          : '1f2a3b4c-5d6e-4f7a-8b9c-0d1e2f3a4b5c',
      ),
      agentKind: 'claude-code' as const,
      cwd: '/p',
      draftIssue: {
        repoPath: '/p',
        issueId: asIssueId(
          broken === 'relinquish'
            ? 'iss_3b4c5d6e-7f8a-4b9c-8d0e-1f2a3b4c5d6e'
            : 'iss_4c5d6e7f-8a9b-4c0d-9e1f-2a3b4c5d6e7f',
        ),
      },
      initialPrompt: 'what is in this picture?',
      attachments: [ref],
    }

    await expect(
      dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId())), 'create', create),
    ).rejects.toThrow('revision conflict')
    expect((await o.reg.issues.reports.list('/p')).filter((issue) => issue.draft)).toEqual([])
    expect(await o.reg.modules.pendingUploads.meta(ref.id)).not.toHaveProperty('claimed')

    // A fresh launch (new ids) with the same file.
    await dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId())), 'create', {
      ...create,
      sessionId: asSessionId(crypto.randomUUID()),
      draftIssue: { repoPath: '/p', issueId: asIssueId(`iss_${crypto.randomUUID()}`) },
    })
    const draft = (await o.reg.issues.reports.list('/p')).find((issue) => issue.draft)
    expect(await o.reg.issues.crud.chatUploadBytes(asIssueId(draft?.id ?? ''), ref.id)).toEqual(
      new Uint8Array(Buffer.from(png, 'base64')),
    )
  })

  it('a discard that cannot hand a file back keeps the draft’s stored files', async () => {
    const o = await makeOracle()
    await provisionHost(o)
    const ref = await hold(o, 'coldstart-keepdir', true)
    vi.spyOn(o.reg.issues.crud, 'panelApply').mockRejectedValueOnce(new Error('revision conflict'))
    // Both the claim's rollback and the discard's release fail to move it back.
    vi.spyOn(o.reg.modules.issueArtifacts, 'relinquish')
      .mockRejectedValueOnce(new Error('EBUSY'))
      .mockRejectedValueOnce(new Error('EBUSY'))
    const removeIssue = vi.spyOn(o.reg.modules.issueArtifacts, 'removeIssue')
    const create = {
      sessionId: asSessionId('2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6e'),
      agentKind: 'claude-code' as const,
      cwd: '/p',
      draftIssue: { repoPath: '/p', issueId: asIssueId('iss_5d6e7f8a-9b0c-4d1e-8f2a-3b4c5d6e7f8a') },
      initialPrompt: 'what is in this picture?',
      attachments: [ref],
    }

    await expect(
      dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId())), 'create', create),
    ).rejects.toThrow('revision conflict')
    expect(removeIssue).not.toHaveBeenCalled()

    // The same create re-adopts the file where it was left.
    await dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId())), 'create', create)
    const draft = (await o.reg.issues.reports.list('/p')).find((issue) => issue.draft)
    expect(await o.reg.issues.crud.chatUploadBytes(asIssueId(draft?.id ?? ''), ref.id)).toEqual(
      new Uint8Array(Buffer.from(png, 'base64')),
    )
  })

  it('a create that fails after its session registered keeps the draft and its claimed files', async () => {
    const o = await makeOracle()
    await provisionHost(o)
    const ref = await hold(o, 'coldstart-b71d', true)
    const createSession = o.reg.modules.sessions.createSession.bind(o.reg.modules.sessions)
    vi.spyOn(o.reg.modules.sessions, 'createSession').mockImplementationOnce(async (input) => {
      await createSession(input)
      throw new Error('late spawn failure')
    })

    await expect(
      dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId())), 'create', {
        agentKind: 'claude-code',
        cwd: '/p',
        draftIssue: { repoPath: '/p' },
        initialPrompt: 'what is in this picture?',
        attachments: [ref],
      }),
    ).rejects.toThrow('late spawn failure')

    // The queued first prompt still has its file to stage.
    const draft = (await o.reg.issues.reports.list('/p')).find((issue) => issue.draft)
    expect(draft?.panel?.artifacts).toEqual([expect.objectContaining({ chatUploadId: ref.id })])
    expect(await o.reg.modules.pendingUploads.meta(ref.id)).toMatchObject({
      claimed: { issueId: draft?.id },
    })
    expect(await o.reg.issues.crud.chatUploadBytes(asIssueId(draft?.id ?? ''), ref.id)).toEqual(
      new Uint8Array(Buffer.from(png, 'base64')),
    )
  })

  it('a shell refuses files before anything is claimed or spawned', async () => {
    const o = await makeOracle()
    await provisionHost(o)
    const ref = await hold(o, 'coldstart-4c2a', true)
    const createSession = vi.spyOn(o.reg.modules.sessions, 'createSession')

    await expect(
      dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId())), 'create', {
        agentKind: 'shell',
        cwd: '/p',
        draftIssue: { repoPath: '/p' },
        initialPrompt: 'ls',
        attachments: [ref],
      }),
    ).rejects.toThrow('this agent cannot accept file attachments')
    expect(createSession).not.toHaveBeenCalled()
    expect((await o.reg.issues.reports.list('/p')).filter((issue) => issue.draft)).toEqual([])
    expect(await o.reg.modules.pendingUploads.meta(ref.id)).not.toHaveProperty('claimed')
  })

  it('a send claims its uploads into the session’s issue, once, and queues the ref without a path', async () => {
    const o = await makeOracle()
    await provisionHost(o)
    const issue = await o.reg.issues.crud.create({ repoPath: '/p', title: 'Work', startNow: false })
    const { sessionId } = await dispatchSessionCommand(
      await ctxFor(o, human(firstAdminMemberId())),
      'create',
      {
        agentKind: 'claude-code',
        cwd: '/p',
        issueId: issue.id,
      },
    )
    const ref = await hold(o, sessionId)
    const send = {
      sessionId,
      text: 'look',
      attachments: [ref],
      mutationId: 'msg_0f6a3c2e-1b4d-4c8e-9a7f-2d5e6b8c9a01',
    }

    // Through the router, whose capability carries the sender's attribution.
    const first = await o.call.sessions.sendText(send)
    const again = await o.call.sessions.sendText(send)

    expect(first).toMatchObject({ ok: true })
    expect(again).toMatchObject({ ok: true })
    const artifacts = (await o.reg.issues.reports.get(issue.id))?.panel?.artifacts ?? []
    expect(artifacts.filter((artifact) => artifact.chatUploadId === ref.id)).toHaveLength(1)
    const queued = await o.store.sync.listQueuedMessages(sessionId)
    expect(queued.map((row) => JSON.parse(row.attachmentsJson ?? '[]'))).toEqual([[ref]])
  })

  it('a session with no issue has nowhere to keep a file, so the send is refused', async () => {
    const o = await makeOracle()
    await provisionHost(o)
    const { sessionId } = await dispatchSessionCommand(
      await ctxFor(o, human(firstAdminMemberId())),
      'create',
      {
        agentKind: 'claude-code',
        cwd: '/p',
      },
    )
    const ref = await hold(o, sessionId)

    expect(await o.call.sessions.sendText({ sessionId, text: 'look', attachments: [ref] })).toEqual(
      {
        ok: false,
        reason: 'this agent cannot accept file attachments',
        disposition: 'dead_letter',
      },
    )
    expect(await o.store.sync.listQueuedMessages(sessionId)).toEqual([])
  })

  it('the superagent’s headless session still stages at upload, so its path can ride the text', async () => {
    const staged = {
      id: 'staged-1',
      path: '/home/u/.podium/uploads/s-1/staged-1.png',
      filename: 'shot.png',
      mediaType: 'image/png',
      kind: 'image' as const,
    }
    const holdUpload = vi.fn()
    const ctx = new SessionCommandCtx(
      {
        sessions: () =>
          ({ sessionById: async () => ({ sessionId: 's-1', headless: true }) }) as never,
        stageAttachment: async () => staged,
        holdUpload,
        claimUpload: async () => {},
        isAgentDriven: async () => true,
        rpc: () => ({}) as never,
      } as unknown as SessionCommandDeps,
      human(firstAdminMemberId()),
    )

    expect(
      await SESSION_COMMAND_HANDLERS.uploadImage(ctx, {
        sessionId: asSessionId('s-1'),
        filename: 'shot.png',
        mimeType: 'image/png',
        dataBase64: png,
      }),
    ).toEqual({ path: staged.path, attachment: staged })
    expect(holdUpload).not.toHaveBeenCalled()
  })
})

describe('draft launch compensation', () => {
  it('stores browser attachments on the draft before starting its session', async () => {
    const o = await makeOracle()
    await provisionHost(o)
    const created = await dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId())), 'create', {
      agentKind: 'codex',
      cwd: '/p',
      draftIssue: { repoPath: '/p' },
      draftArtifacts: [
        {
          id: 'att-1',
          filename: 'mock.png',
          mimeType: 'image/png',
          dataBase64: 'UE5H',
        },
      ],
    })

    const draft = (await o.reg.issues.reports.list('/p')).find((issue) => issue.draft)
    expect(draft?.panel?.artifacts).toEqual([
      expect.objectContaining({
        path: 'attachments/att-1/mock.png',
        title: 'mock.png',
        entry: 'mock.png',
      }),
    ])
    expect(o.reg.modules.sessions.getSessionIssueId(created.sessionId)).toBe(draft?.id)
    expect((await o.reg.issues.crud.panelArtifactRead(draft?.id ?? '', { index: 1 })).dataBase64).toBe(
      'UE5H',
    )
  })

  it('does not create a draft when an existing issue takes precedence', async () => {
    const o = await makeOracle()
    await provisionHost(o)
    const issue = await o.reg.issues.crud.create({ repoPath: '/p', title: 'Existing work', startNow: false })

    const created = await dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId())), 'create', {
      agentKind: 'codex',
      cwd: '/p',
      issueId: issue.id,
      draftIssue: { repoPath: '/p' },
    })

    expect((await o.reg.issues.reports.list('/p')).filter((candidate) => candidate.draft)).toEqual([])
    expect(o.reg.modules.sessions.getSessionIssueId(created.sessionId)).toBe(issue.id)
  })

  it('purges only the placeholder created for a session spawn that throws', async () => {
    const o = await makeOracle()
    await provisionHost(o)
    vi.spyOn(o.reg.modules.sessions, 'createSession').mockImplementationOnce(() => {
      throw new Error('spawn failed')
    })

    await expect(
      dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId())), 'create', {
        agentKind: 'codex',
        cwd: '/p',
        draftIssue: { repoPath: '/p' },
      }),
    ).rejects.toThrow('spawn failed')

    expect((await o.reg.issues.reports.list('/p')).filter((issue) => issue.draft)).toEqual([])
    expect(await o.reg.modules.sessions.listSessions(undefined, 'rpc')).toEqual([])
  })

  it('refuses compensation once the session has been registered against the draft', async () => {
    const o = await makeOracle()
    await provisionHost(o)
    const createSession = o.reg.modules.sessions.createSession.bind(o.reg.modules.sessions)
    vi.spyOn(o.reg.modules.sessions, 'createSession').mockImplementationOnce(async (input) => {
      await createSession(input)
      throw new Error('late spawn failure')
    })

    await expect(
      dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId())), 'create', {
        agentKind: 'codex',
        cwd: '/p',
        draftIssue: { repoPath: '/p' },
      }),
    ).rejects.toThrow('late spawn failure')

    const draft = (await o.reg.issues.reports.list('/p')).find((issue) => issue.draft)
    expect(draft).toBeDefined()
    expect(await o.reg.modules.sessions.listSessions(undefined, 'rpc')).toContainEqual(
      expect.objectContaining({ issueId: draft?.id }),
    )
  })
})

/** A fixture with one paired machine row that HAS an owner to be denied on. */
async function oracleWithPairedMachine(): Promise<{
  o: Oracle
  rows: Map<string, { owner: UserId | null; grants: MachineGrant[]; name?: string }>
}> {
  const o = await makeOracle({
    machineId: asMachineId('box'),
    offlineMachines: [{ id: asMachineId('box'), name: 'The Box' }],
  })
  // The offline-row upsert carries no assignment; without it the placement
  // path refuses every spawn as structurally daemon-less (POD-2700), before
  // any `use` question is reached. The daemon socket itself is attached by
  // makeOracle, so this is the execution assignment only.
  await o.store.machines.setServiceAssignment(asMachineId('box'), {
    server: false,
    agentExecution: true,
  })
  const rows = new Map([
    ['box', { owner: firstAdminMemberId(), grants: [] as MachineGrant[], name: 'The Box' }],
  ])
  return { o, rows }
}

/**
 * The posture a real boot leaves behind, which makeOracle does not: the host
 * row itself (nothing provisions it on construction — the store is empty until
 * a test writes), assigned for agent execution, owned by the instance owner,
 * and reporting the /p checkout the tests below place work into. Without the
 * row the placement path answers "unknown machine"; without the assignment it
 * answers "no assigned and available daemon" (POD-2700's structural axis);
 * without the owner the host is quarantined (usable by nobody, POD-3960);
 * without the checkout no repo path resolves to a repo id (POD-4165). The
 * daemon socket and its inventory report are already attached by makeOracle,
 * and presence/availability derive from that socket live, so no re-attach is
 * needed after the row appears.
 */
async function provisionHost(o: Oracle): Promise<void> {
  const host = o.store.hostMachineId
  // Fill the boot gap only: if a future makeOracle provisions the host
  // itself, its row, assignment and owner stand.
  if (!(await o.store.machines.getMachine(host))) {
    await o.store.machines.upsertMachine({
      id: host,
      name: 'Test Host',
      hostname: 'test-host',
      tokenHash: 'test',
      ownerUserId: firstAdminMemberId(),
      assignment: { server: true, agentExecution: true },
    })
  }
  if ((await o.reg.modules.machines.serviceAssignment(host)).agentExecution !== true) {
    await o.store.machines.setServiceAssignment(host, { server: true, agentExecution: true })
  }
  if ((await o.store.machines.custodian(host)) === null) {
    await o.store.machines.setMachineOwner(host, firstAdminMemberId())
  }
  await o.store.repos.addRepo('/p', host)
}

describe('the machine `use` gate, on every command that starts or feeds work', () => {
  it('denies a principal with no use grant, on create — and the owner still passes', async () => {
    const { o, rows } = await oracleWithPairedMachine()
    const ownership = ownershipTable(rows)

    // The owner may spawn there: the fixture is not one that denies everybody.
    await expect(
      dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId()), { ownership }), 'create', {
        agentKind: 'shell',
        cwd: '/p',
        machineId: 'box',
      }),
    ).resolves.toMatchObject({ sessionId: expect.any(String) })

    // A second human cannot — and the machine is invisible to them, so the
    // refusal is the never-paired one.
    expect(
      await messageOf(async () =>
        dispatchSessionCommand(await ctxFor(o, human(COLLEAGUE), { ownership }), 'create', {
          agentKind: 'shell',
          cwd: '/p',
          machineId: 'box',
        }),
      ),
    ).toBe("unknown machine 'box'")
  })

  it('denies resume on a machine the principal may see but not use', async () => {
    const { o, rows } = await oracleWithPairedMachine()
    rows.set('box', {
      owner: COLLEAGUE,
      grants: [{ subject: firstAdminMemberId(), verb: 'see' }],
      name: 'The Box',
    })
    const ownership = ownershipTable(rows)

    expect(
      await messageOf(async () =>
        dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId()), { ownership }), 'resume', {
          agentKind: 'claude-code',
          cwd: '/p',
          resume: { kind: 'claude-session', value: 'n1' },
          conversationId: 'n1',
          machineId: 'box',
        }),
      ),
    ).toBe("you do not have access to run agents on machine 'The Box'")
    // Nothing was spawned, and nothing was persisted.
    expect(await o.reg.modules.sessions.listSessions(undefined, 'rpc')).toEqual([])
  })

  it.each([
    'kill',
    'hibernate',
    'interrupt',
    'resurrect',
    'sendText',
    'resumeAndSend',
    'continue',
  ] as const)('denies %s against a session living on a machine the principal may not use', async (command) => {
    const { o, rows } = await oracleWithPairedMachine()
    const ownership = ownershipTable(rows)
    const owner = await ctxFor(o, human(firstAdminMemberId()), { ownership })
    const spawned = (await dispatchSessionCommand(owner, 'create', {
      agentKind: 'shell',
      cwd: '/p',
      machineId: 'box',
    })) as { sessionId: string }
    const input =
      command === 'sendText' || command === 'resumeAndSend'
        ? { sessionId: spawned.sessionId, text: 'hello' }
        : { sessionId: spawned.sessionId }

    // The machine changes hands: the colleague now owns it and the instance
    // owner holds nothing on it.
    rows.set('box', { owner: COLLEAGUE, grants: [], name: 'The Box' })

    expect(
      await messageOf(async () =>
        dispatchSessionCommand(
          await ctxFor(o, human(firstAdminMemberId()), { ownership }),
          command,
          input,
        ),
      ),
    ).toBe("unknown machine 'box'")
  })

  it("M4: a non-owner authenticated to a server running on the owner's machine cannot execute on it", async () => {
    // The default ownership index — the one the router actually builds — over the
    // real machines table. The HOST is the sharpest case for M4 and since POD-318
    // it is an ordinary machine with an ordinary row: `ensureHostMachine` wrote it
    // at construction, owned by whoever set the instance up. There is no sentinel
    // arm underneath any more, so this exercises the same rule as any other machine.
    const o = await makeOracle()
    await provisionHost(o)
    const host = o.store.hostMachineId
    // The kill below retires the process through the daemon (POD-4302): answer
    // the lifecycle RPC the way a real daemon does, or retirement is never
    // confirmed and the kill fails after the tombstone committed. makeOracle's
    // own send arm is replicated, not dropped — the create above it still
    // observes every frame and still gets its repo-op answers.
    await o.reg.gateway.attachDaemon(host, (msg) => {
      o.daemon.push(msg)
      if (msg.type === 'repoOpRequest') {
        o.reg.gateway.routeDaemonFrame(host, {
          type: 'repoOpResult',
          requestId: msg.requestId,
          ok: true,
          output: '',
        })
      }
      if (msg.type === 'runtimeLifecycleRequest') {
        o.reg.gateway.routeDaemonFrame(host, {
          type: 'runtimeLifecycleResult',
          requestId: msg.requestId,
          sessionId: msg.sessionId,
          result: { ok: true, retirement: 'confirmed' },
        })
      }
    })
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    expect((await o.meta(sessionId)).machineId).toBe(host)

    // The instance owner — whoever set it up — may kill it.
    const asOwner = await ctxFor(o, human(firstAdminMemberId()))
    // ...and a second authenticated human may not, on the SAME machine.
    const asColleague = await ctxFor(o, human(COLLEAGUE))

    expect(await messageOf(() => dispatchSessionCommand(asColleague, 'kill', { sessionId }))).toBe(
      `unknown machine '${host}'`,
    )
    expect(await dispatchSessionCommand(asOwner, 'kill', { sessionId })).toBeUndefined()
  })
})

describe('the spawn surface never OFFERS a machine the principal cannot use', () => {
  it('drops what the principal cannot see, and marks what it may see but not use', async () => {
    const o = await makeOracle({
      machineId: asMachineId('mine'),
      offlineMachines: [
        { id: asMachineId('mine'), name: 'Mine' },
        { id: asMachineId('shared'), name: 'Shared' },
        { id: asMachineId('theirs'), name: 'Theirs' },
      ],
    })
    const ownership = ownershipTable(
      new Map([
        ['mine', { owner: firstAdminMemberId(), grants: [] as MachineGrant[], name: 'Mine' }],
        // Visible but not usable...
        [
          'shared',
          {
            owner: COLLEAGUE,
            grants: [{ subject: firstAdminMemberId(), verb: 'see' }] as MachineGrant[],
            name: 'Shared',
          },
        ],
        // ...and not visible at all.
        ['theirs', { owner: COLLEAGUE, grants: [] as MachineGrant[], name: 'Theirs' }],
      ]),
    )

    const offered = await machinesForPrincipal(o.reg.modules, human(firstAdminMemberId()), ownership)

    // `theirs` is absent, not denied: for this principal it does not exist.
    expect(offered.map((m) => m.id).sort()).toEqual(['mine', 'shared'])
    // And the one that IS visible carries the denial, so the SERVER-SIDE
    // predicate refuses it with a reason that is not "offline" — the M5
    // distinction. The annotation stops at the wire on purpose: `MachineWire`
    // may not grow a per-principal field until POD-1079/POD-1075 land the
    // ownership columns, so a client-side picker sees the see-filter today and
    // the use-decision when that schema carries it.
    expect(offered.find((m) => m.id === 'mine')?.use).toBe('granted')
    expect(offered.find((m) => m.id === 'shared')?.use).toBe('denied')

    /**
     * POD-1495 — and the field the comment above was WAITING for. The same
     * projection now also carries "may you give this machine away", so the
     * settings panel can withhold a transfer control the server would refuse.
     *
     * Both arms in one list, so neither can be the fixture's only answer: the
     * owned machine says `true` and the visible-but-not-owned one says `false`.
     * `false` is what a manage grantee would see here too — ownership is
     * strictly larger than any verb the machine can grant — and it is
     * deliberately the same `false` an unowned machine produces, since no owner
     * IDENTITY may cross this boundary.
     */
    expect(offered.find((m) => m.id === 'mine')?.owned).toBe(true)
    expect(offered.find((m) => m.id === 'shared')?.owned).toBe(false)

    /**
     * POD-1386 — `podium machine list` joins each machine's registered checkouts
     * onto this projection, because an enumeration without them cannot answer
     * "which machine can take this work". Repo rows are stored UNSCOPED, so the
     * join is where the disclosure decision is taken, and the cut is `use`, not
     * `see`: a checkout path answers "what can I run on your hardware, and as
     * whom", the same question `inventory` answers.
     *
     * All three cases in one list on purpose. Against a fixture with only a usable
     * machine, a join that filtered NOTHING would pass — the see-only row is what
     * makes this able to fail.
     */
    const repos = usableRepos(offered, [
      { machineId: asMachineId('mine'), path: '/home/me/src/podium' },
      { machineId: asMachineId('shared'), path: '/home/colleague/src/podium' },
      { machineId: asMachineId('theirs'), path: '/home/colleague/src/secret' },
    ])
    expect(repos).toEqual([{ machineId: 'mine', path: '/home/me/src/podium' }])
  })
})

describe('delegation, resolved live at every apply', () => {
  it('an agent whose human lost the machine grant is denied on the NEXT apply, with no reaper', async () => {
    const { o, rows } = await oracleWithPairedMachine()
    rows.set('box', {
      owner: COLLEAGUE,
      grants: [{ subject: firstAdminMemberId(), verb: 'use' }],
      name: 'The Box',
    })
    const ownership = ownershipTable(rows)
    // The agent acts from a live parent session: agent spawns resolve their
    // delegation through the parent binding, and a fictional id answers
    // "parent delegation missing" before any grant is consulted.
    const parent = (await dispatchSessionCommand(
      await ctxFor(o, human(firstAdminMemberId()), { ownership }),
      'create',
      { agentKind: 'shell', cwd: '/p', machineId: 'box' },
    )) as { sessionId: string }
    const worker = agentFor(parent.sessionId, firstAdminMemberId())

    const first = (await dispatchSessionCommand(await ctxFor(o, worker, { ownership }), 'create', {
      agentKind: 'shell',
      cwd: '/p',
      machineId: 'box',
    })) as { sessionId: string }
    expect(first.sessionId).toEqual(expect.any(String))

    // Revoke the HUMAN's grant. Nothing is told about the agent; nothing kills it.
    rows.set('box', { owner: COLLEAGUE, grants: [], name: 'The Box' })

    expect(
      await messageOf(async () =>
        dispatchSessionCommand(await ctxFor(o, worker, { ownership }), 'create', {
          agentKind: 'shell',
          cwd: '/p',
          machineId: 'box',
        }),
      ),
    ).toBe("unknown machine 'box'")
  })

  it('a sub-agent cannot spawn on a machine its PARENT could not use', async () => {
    const o = await makeOracle({
      machineId: asMachineId('a'),
      offlineMachines: [
        { id: asMachineId('a'), name: 'A' },
        { id: asMachineId('b'), name: 'B' },
      ],
    })
    // 'b' needs a live daemon, or every spawn on it refuses as OFFLINE and the
    // `use` denial below would be indistinguishable from unreachability — the
    // exact conflation D18.5 exists to prevent, arriving in the test that is
    // supposed to prove it.
    o.reg.gateway.attachDaemon('b', () => {})
    // ...and the execution assignment, or every spawn refuses as structurally
    // daemon-less before the delegation narrowing is even consulted (POD-2700).
    // Both rows: the counterfactual below spawns on 'a' for real.
    for (const id of [asMachineId('a'), asMachineId('b')]) {
      await o.store.machines.setServiceAssignment(id, { server: false, agentExecution: true })
    }
    const ownership = ownershipTable(
      new Map([
        ['a', { owner: firstAdminMemberId(), grants: [] as MachineGrant[], name: 'A' }],
        ['b', { owner: firstAdminMemberId(), grants: [] as MachineGrant[], name: 'B' }],
      ]),
      // The parent's delegation is narrowed to machine 'a'; the HUMAN may still
      // use 'b', which is what makes this a chain test and not a repeat of the
      // human gate.
      new Map([['parent', ['a']]]),
    )
    const ownerCtx = await ctxFor(o, human(firstAdminMemberId()), { ownership })

    // The human may spawn on 'b'...
    await expect(
      dispatchSessionCommand(ownerCtx, 'create', {
        agentKind: 'shell',
        cwd: '/p',
        machineId: 'b',
      }),
    ).resolves.toMatchObject({ sessionId: expect.any(String) })

    // ...and the leaf the child acts from must exist as a session: agent
    // spawns resolve their delegation through the parent binding, so a
    // fictional leaf would answer "parent delegation missing" instead of
    // reaching the narrowing below. The narrowed LINK stays synthetic — it is
    // the delegation map above that declares it, keyed by the same id.
    const leaf = (await dispatchSessionCommand(ownerCtx, 'create', {
      agentKind: 'shell',
      cwd: '/p',
      machineId: 'a',
    })) as { sessionId: string }
    const narrowedChild = agentFor(leaf.sessionId, firstAdminMemberId(), [asSessionId('parent')])

    // ...the child, delegating through that parent, may not.
    expect(
      await messageOf(async () =>
        dispatchSessionCommand(await ctxFor(o, narrowedChild, { ownership }), 'create', {
          agentKind: 'shell',
          cwd: '/p',
          machineId: 'b',
        }),
      ),
    ).toBe("you do not have access to run agents on machine 'B'")

    // Counterfactual: the narrowing denies 'b' specifically, not everything.
    await expect(
      dispatchSessionCommand(await ctxFor(o, narrowedChild, { ownership }), 'create', {
        agentKind: 'shell',
        cwd: '/p',
        machineId: 'a',
      }),
    ).resolves.toMatchObject({ sessionId: expect.any(String) })
  })
})

describe('invisible fails exactly like nonexistent', () => {
  it('a session hidden from the principal produces the same answer as one that never existed', async () => {
    const o = await makeOracle()
    await provisionHost(o)
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    // The multi-user answer POD-1075 will supply, injected here so the branch is
    // exercised rather than merely present.
    const hidden = await ctxFor(o, human(COLLEAGUE), { visibility: () => false })
    const visible = await ctxFor(o, human(firstAdminMemberId()))

    // Same command, same shapes, whichever kind of absence it was.
    expect(await dispatchSessionCommand(hidden, 'hibernate', { sessionId })).toEqual(
      await dispatchSessionCommand(visible, 'hibernate', { sessionId: GHOST }),
    )
    expect(await dispatchSessionCommand(hidden, 'resurrect', { sessionId })).toEqual(
      await dispatchSessionCommand(visible, 'resurrect', { sessionId: GHOST }),
    )
    expect(
      await dispatchSessionCommand(hidden, 'answerAskUserQuestion', {
        sessionId,
        choices: [{ optionIndices: [1] }],
      }),
    ).toEqual(
      await dispatchSessionCommand(visible, 'answerAskUserQuestion', {
        sessionId: GHOST,
        choices: [{ optionIndices: [1] }],
      }),
    )
    expect(await dispatchSessionCommand(hidden, 'kill', { sessionId })).toEqual(
      await dispatchSessionCommand(visible, 'kill', { sessionId: GHOST }),
    )
    // And the hidden session is still alive: the refusal refused, it did not act.
    expect((await o.reg.modules.sessions.listSessions(undefined, 'rpc')).map((s) => s.sessionId)).toEqual([sessionId])
  })

  it('a relayed send to a hidden session throws the same message as one to a ghost', async () => {
    const o = await makeOracle()
    await provisionHost(o)
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    const agent = agentFor('agent-1', firstAdminMemberId())
    const hidden = await ctxFor(o, agent, { visibility: () => false })
    const visible = await ctxFor(o, agent)

    const onHidden = await messageOf(() =>
      dispatchSessionCommand(hidden, 'sendText', { sessionId, text: 'hi' }),
    )
    const onGhost = await messageOf(() =>
      dispatchSessionCommand(visible, 'sendText', { sessionId: GHOST, text: 'hi' }),
    )

    expect(onHidden).toBe('session not found')
    expect(onHidden).toBe(onGhost)
  })
})

describe('chat interrupt ordering', () => {
  it('reserves a stopped message id so a send arriving later cannot recreate it', async () => {
    const o = await makeOracle()
    await provisionHost(o)
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    const ctx = await ctxFor(o, human(firstAdminMemberId()))
    vi.spyOn(o.reg.modules.sessions, 'interruptTurn').mockResolvedValue({
      ok: false,
      reason: 'no active turn',
    })

    expect(
      await dispatchSessionCommand(ctx, 'interrupt', { sessionId, messageId: 'msg_00000000-0000-4000-8000-00000000f001' }),
    ).toEqual({ ok: true, requested: 'retraction' })

    expect(
      await dispatchSessionCommand(ctx, 'sendText', {
        sessionId,
        text: 'must stay stopped',
        mutationId: 'msg_00000000-0000-4000-8000-00000000f001',
      }),
    ).toEqual({
      ok: false,
      reason: 'interaction interrupted',
      disposition: 'dead_letter',
    })
    expect(await o.store.messages.getMessage('msg_00000000-0000-4000-8000-00000000f001')).toBeNull()
  })
})

describe('attribution and ownership come from the principal', () => {
  it('derives binding spawn authority from each authenticated principal arm', () => {
    expect(bindingPrincipalFor(human(COLLEAGUE))).toEqual({
      kind: 'user',
      userId: COLLEAGUE,
    })
    expect(bindingPrincipalFor(agentFor('parent-agent', COLLEAGUE))).toEqual({
      kind: 'agent',
      parentBindingId: asSessionId('parent-agent'),
    })
    // POD-1516: the job NAME survives the crossing. It used to be dropped here,
    // which made every system-spawned session attributable to "some job".
    expect(bindingPrincipalFor({ kind: 'system', job: 'steward' })).toEqual({
      kind: 'system',
      job: 'steward',
    })
  })

  it('answerAskUserQuestion records WHICH human answered, and a payload identity is inert', async () => {
    // The colleague needs a machine they may actually use — on the local
    // sentinel they would be denied outright, which is M4 working and would make
    // this test prove nothing about attribution.
    const { o, rows } = await oracleWithPairedMachine()
    rows.set('box', { owner: COLLEAGUE, grants: [], name: 'The Box' })
    const ownership = ownershipTable(rows)
    const ctx = await ctxFor(o, human(COLLEAGUE), { ownership })
    const { sessionId } = (await dispatchSessionCommand(ctx, 'create', {
      agentKind: 'claude-code',
      cwd: '/p',
      machineId: 'box',
    })) as { sessionId: string }
    o.reg.gateway.routeDaemonFrame('box', {
      type: 'bind',
      sessionId: asSessionId(sessionId),
      cmd: 'claude',
      cwd: '/p',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    // Answers carry the AUTHORITATIVE interaction id (POD-4279): an id-less
    // answer fails closed as unknown-interaction before any attribution runs,
    // so the question is raised through the aggregate first — the same entry
    // the driver path feeds — and answered by its id below.
    // The menu delivery gate answers "no pending question" unless the session
    // is observed sitting on one: report the needs_user phase the harness
    // would. This comes BEFORE the ask: a phase transition runs the
    // aggregate's supersede sweep, so a row seeded first would be retired as
    // replaced-menu before the answer lands. The pending-question read itself
    // comes off the aggregate row below, not the transcript, so no PTY
    // traffic is needed.
    o.reg.gateway.routeDaemonFrame('box', {
      type: 'agentState',
      sessionId: asSessionId(sessionId),
      state: {
        phase: 'needs_user',
        since: new Date().toISOString(),
        nativeSubagentCount: 0,
        need: { kind: 'question', summary: 'Pick' },
      },
    })
    const { row: question } = await o.reg.modules.interactions.ask({
      interaction: {
        sessionId: asSessionId(sessionId),
        kind: 'question',
        payload: {
          v: 1,
          questions: [
            {
              question: 'Pick',
              multiSelect: false,
              previewLayout: false,
              options: [{ label: 'One' }, { label: 'Two' }],
            },
          ],
        },
        source: 'protocol',
        answerable: 'keystroke-emulated',
      },
    })

    const answered = await dispatchSessionCommand(ctx, 'answerAskUserQuestion', {
      sessionId,
      interactionId: question.id,
      choices: [{ optionIndices: [1] }],
      // A payload-supplied answerer, offered and NOT taken.
      humanQuestionAskedBy: firstAdminMemberId(),
    })

    // Admitted, claimed, then reopened: a driverless session has no live menu
    // to press, so delivery fails and the ask stays open for the terminal
    // (REFUSAL_KEEPS_ASK_OPEN). The `delivery-failed` reason — not a throw,
    // and not the bare `{ok: false}` of an invisible target — is the
    // fingerprint that every gate passed and the aggregate claimed the
    // authoritative id; the reopened row is the other half of that proof.
    expect(answered).toMatchObject({ ok: false, reason: 'delivery-failed' })
    expect(
      (await o.reg.modules.interactions.listOpen(asSessionId(sessionId))).find(
        (row) => row.id === question.id,
      ),
    ).toMatchObject({ status: 'asked' })
    // The pair the write is attributed with comes from the transport principal:
    // the colleague answered, whatever the payload said.
    expect(ctx.principal.kind === 'user' && ctx.principal.user).toBe(COLLEAGUE)
    expect(spawnedByFor(ctx.principal)).not.toBe(firstAdminMemberId())
  })

  it('a created session is owned by the onBehalfOf human, with the agent as actor', () => {
    const owned = createdOwnership(agentFor('agent-1', COLLEAGUE), undefined)

    expect(owned).toEqual({
      owner: COLLEAGUE,
      actor: 'session:agent-1',
      inheritedFrom: { kind: 'principal' },
    })
    // The actor half is what the shipped `spawnedBy` column already speaks.
    expect(spawnedByFor(agentFor('agent-1', COLLEAGUE))).toBe('session:agent-1')
    expect(spawnedByFor(human(COLLEAGUE))).toBe('user')
  })

  it('persists an agent-created session under its delegating human with the agent recorded as actor', async () => {
    const { o, rows } = await oracleWithPairedMachine()
    rows.set('box', { owner: COLLEAGUE, grants: [], name: 'The Box' })
    const ownership = ownershipTable(rows)
    // As above: the acting agent's session must exist for the binding lookup.
    const parent = (await dispatchSessionCommand(
      await ctxFor(o, human(COLLEAGUE), { ownership }),
      'create',
      { agentKind: 'shell', cwd: '/p', machineId: 'box' },
    )) as { sessionId: string }
    const principal = agentFor(parent.sessionId, COLLEAGUE)
    const created = (await dispatchSessionCommand(
      await ctxFor(o, principal, { ownership }),
      'create',
      { agentKind: 'shell', cwd: '/p', machineId: 'box' },
    )) as { sessionId: SessionId }

    expect(
      (await o.store.sessions.loadSessions()).find((row) => row.id === created.sessionId),
    ).toMatchObject({
      ownerUserId: COLLEAGUE,
      // The actor names the CALLING session: with a live parent that is the
      // parent's id, exactly as 'session:agent-1' named the fictional one.
      spawnedBy: `session:${parent.sessionId}`,
    })
    expect(await o.reg.modules.sessions.sessionOwner(created.sessionId)).toEqual({
      owner: COLLEAGUE,
      grants: [],
    })
  })

  it("a session spawned under an issue inherits THAT issue's owner, not the actor's", () => {
    const underIssue = createdOwnership(agentFor('agent-1', COLLEAGUE), {
      id: asIssueId('podium-7'),
      owner: firstAdminMemberId(),
    })

    // The issue's owner wins over the delegating human — otherwise sharing an
    // issue would not share the work done inside it.
    expect(underIssue).toEqual({
      owner: firstAdminMemberId(),
      actor: 'session:agent-1',
      inheritedFrom: { kind: 'issue', id: 'podium-7' },
    })
    // An issue with no owner recorded yet falls back to the delegating human,
    // never to nobody: the draft vessel is OWNED.
    expect(
      createdOwnership(agentFor('agent-1', COLLEAGUE), { id: asIssueId('draft-1') }).owner,
    ).toBe(COLLEAGUE)
  })
})

describe('session id prefix (POD-4536)', () => {
  function prefixAccess(
    rows: Map<SessionId, SessionTargetRow>,
    opts?: { listSpy?: SessionAccessDeps['listSessionIds'] & { mock?: unknown } },
  ): SessionAccessDeps {
    return {
      sessionById: async (id) => rows.get(id),
      listSessionIds: opts?.listSpy ?? (() => [...rows.keys()]),
      issues: { has: () => false, ancestorIds: () => [], issueForCwd: async () => null },
    }
  }

  function targetCtx(access: SessionAccessDeps, principal: CommandPrincipal): SessionCommandCtx {
    const rowFor = async (id: SessionId) => {
      const found = await access.sessionById(id)
      // No machineId on the fake rows, so the machine `use` gate is skipped —
      // this test is about id resolution, not placement.
      return found ? { ...found } : undefined
    }
    return new SessionCommandCtx(
      {
        sessions: () => ({ sessionById: rowFor }) as never,
        stageAttachment: async () => {
          throw new Error('unused')
        },
        holdUpload: async () => {
          throw new Error('unused')
        },
        claimUpload: async () => {
          throw new Error('unused')
        },
        isAgentDriven: async () => false,
        mailSend: () => Promise.resolve({ ok: false, disposition: 'dead_letter' }) as never,
        createDraftIssue: async () => ({ id: asIssueId('x') }),
        attachDraftArtifacts: async () => {},
        discardUnlaunchedDraft: async () => false,
        issueOwner: async () => undefined,
        access,
        rpc: () => ({}) as never,
        ownership: { rowFor: () => undefined, delegatedMachines: () => undefined },
        mutations: { once: async (_id: never, _proc: never, fn: () => unknown) => await fn() } as never,
      },
      principal,
    )
  }

  it('resolves an unambiguous 8-char prefix through the shared target path', async () => {
    const full = asSessionId('e10d1055-e770-44a6-bfd4-993c4867297d')
    const rows = new Map<SessionId, SessionTargetRow>([
      [full, { sessionId: full, cwd: '/p', status: 'hibernated', archived: false, agentKind: 'shell' } as SessionTargetRow],
    ])
    const principal = human(firstAdminMemberId())
    const access = prefixAccess(rows)

    const byFull = await resolveSessionTarget(principal, full, access)
    const byPrefix = await resolveSessionTarget(principal, asSessionId(full.slice(0, 8)), access)

    expect(byFull.kind).toBe('visible')
    expect(byPrefix.kind).toBe('visible')
    if (byFull.kind !== 'visible' || byPrefix.kind !== 'visible') throw new Error('expected visible')
    expect(byPrefix.session.sessionId).toBe(full)
    expect(byPrefix.session.sessionId).toBe(byFull.session.sessionId)

    // And through the command-plane target every command rides.
    const ctx = targetCtx(access, principal)
    expect((await ctx.target(full, 'sessions.hibernate'))?.sessionId).toBe(full)
    expect((await ctx.target(asSessionId(full.slice(0, 8)), 'sessions.hibernate'))?.sessionId).toBe(full)
  })

  it('keeps the exact-match fast path first — a full uuid never pays for a scan', async () => {
    const full = asSessionId('e10d1055-e770-44a6-bfd4-993c4867297d')
    const rows = new Map<SessionId, SessionTargetRow>([
      [full, { sessionId: full, cwd: '/p', status: 'live', archived: false, agentKind: 'shell' } as SessionTargetRow],
    ])
    const listSpy = vi.fn(() => [...rows.keys()]) as SessionAccessDeps['listSessionIds'] & {
      mock: unknown
    }
    const access = prefixAccess(rows, { listSpy })
    const principal = human(firstAdminMemberId())

    const resolved = await resolveSessionTarget(principal, full, access)
    expect(resolved.kind).toBe('visible')
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('refuses an ambiguous prefix naming the candidates, never silently picking one', async () => {
    const a = asSessionId('aaaaaaaa-1111-4111-8111-111111111111')
    const b = asSessionId('aaaaaaaa-2222-4222-8222-222222222222')
    const rows = new Map<SessionId, SessionTargetRow>([
      [a, { sessionId: a, cwd: '/p', status: 'live', archived: false, agentKind: 'shell' } as SessionTargetRow],
      [b, { sessionId: b, cwd: '/p', status: 'live', archived: false, agentKind: 'shell' } as SessionTargetRow],
    ])
    const access = prefixAccess(rows)
    const principal = human(firstAdminMemberId())

    const resolved = await resolveSessionTarget(principal, asSessionId('aaaaaaaa'), access)
    expect(resolved.kind).toBe('ambiguous')
    if (resolved.kind !== 'ambiguous') throw new Error('expected ambiguous')
    expect(resolved.candidates).toEqual(expect.arrayContaining([a, b]))
    expect(ambiguousSessionPrefixMessage('aaaaaaaa', resolved.candidates)).toContain(a)
    expect(ambiguousSessionPrefixMessage('aaaaaaaa', resolved.candidates)).toContain(b)

    // Through the shared target path it throws with the same candidates listed.
    const ctx = targetCtx(access, principal)
    await expect(ctx.target(asSessionId('aaaaaaaa'), 'sessions.hibernate')).rejects.toThrow(/ambiguous/)
    await expect(ctx.target(asSessionId('aaaaaaaa'), 'sessions.hibernate')).rejects.toThrow(a)
    await expect(ctx.target(asSessionId('aaaaaaaa'), 'sessions.hibernate')).rejects.toThrow(b)
  })
})
