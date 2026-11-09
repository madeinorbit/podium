import type { SessionId, WorkState } from '@podium/model'
import { pinRowId, SESSION_INTERRUPT_KIND } from '@podium/model'
import { submitNow } from '@podium/protocol'
import { type PodiumSettings, shouldPromptAutoContinue } from '@podium/runtime'
import type { PodiumClientApi } from '../api'
import { randomUUID } from '../id'
import { UNSET } from '../records'
import {
  issueActionEffect,
  sessionAnswerEffect,
  sessionConfigureEffect,
  sessionHandoffEffect,
} from '../spawn-agent'
import type { CommandDeps } from './context'
import type { SessionsCommands } from './sessions-types'
import type { CommandWrites } from './writes'

/**
 * The revision an edit of this session is made against NOW (POD-6399): the
 * replica's, past every edit of it this device has queued and not yet seen
 * confirmed, because the server applies them in order and each moves it by one.
 */
function sessionRevisionNow(
  rt: Pick<CommandDeps<PodiumClientApi>, 'outbox' | 'sessionRevision'>,
  sessionId: SessionId,
): number {
  let revision = rt.sessionRevision?.(sessionId) ?? 1
  for (const entry of [...rt.outbox.pending(), ...rt.outbox.awaiting()]) {
    if (entry.kind !== 'recordEdit' && entry.kind !== 'recordRemove') continue
    const input = entry.input as { kind?: unknown; id?: unknown; expectedRevision?: unknown }
    if (input.kind !== 'session' || input.id !== sessionId) continue
    if (typeof input.expectedRevision === 'number') {
      revision = Math.max(revision, input.expectedRevision + 1)
    }
  }
  return revision
}

export function createSessionsCommands<TApi extends PodiumClientApi>(
  rt: CommandDeps<TApi>,
  shared: CommandWrites,
): SessionsCommands<TApi> {
  const api = rt.api
  const { records, editRecord, mySessionState, markRead, pendingReads } = shared
  /**
   * WHAT THE SESSION SHOULD BE, as an edit of its record (ADR 12 D5 E1,
   * POD-6399): queued, shown at once, replay-safe, and refused by its revision
   * if a newer edit landed first. The server's controller makes it true; how it
   * went shows on the session itself (`sessionTransition`), on every device.
   */
  const editSessionLifecycle = async (
    sessionId: SessionId,
    desired: 'running' | 'stopped' | 'hibernated',
    force = false,
  ): Promise<{ ok: boolean; reason?: string }> => {
    try {
      await records.edit(
        { kind: 'session', id: sessionId },
        { desired, ...(force ? { force: true } : {}) },
        sessionRevisionNow(rt, sessionId),
      )
      return { ok: true }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error'
      rt.notices.error(`Couldn't change the session — ${reason}`)
      return { ok: false, reason }
    }
  }

  return {
    spawnDraftAgent: (args) => rt.spawnDraftAgent(args),
    launch: (args) => rt.launchSession(args),
    spawnIssueAgent: (args) => rt.spawnIssueAgent(args),
    killSession: async (sessionId) => {
      // A draft start that never became a session is dismissed, not removed.
      const dismissed = rt.dismissLaunch?.(sessionId) === true
      // Kill deletes the session (records.session.remove), against its
      // revision: a kill queued offline that arrives after a newer start is
      // refused rather than ending the process the user resumed (POD-6399).
      if (!dismissed)
        await records
          .remove({ kind: 'session', id: sessionId }, sessionRevisionNow(rt, sessionId))
          .catch(() => {})
      rt.ui.forgetSession(sessionId)
    },
    continueSession: async (sessionId) => {
      // On the sync write entry point (POD-6416). LEGACY(remove-after: 2027-03):
      // an older server has no `sync.submit` and takes the command's own route.
      await submitNow(
        api,
        'sessions.continue',
        { sessionId },
        {
          legacy: async () => await api.sessions.continue.mutate({ sessionId }),
        },
      ).catch(() => {})
      // My auto-continue choice is a synced record of mine (POD-6673).
      const preferences = rt.preferences?.()
      if (
        preferences !== undefined &&
        shouldPromptAutoContinue(preferences as unknown as PodiumSettings)
      ) {
        rt.autoContinueDialog.open(sessionId)
      }
    },
    hibernate: async (sessionId) => {
      await editSessionLifecycle(sessionId, 'hibernated')
    },
    // Clean end [spec:SP-9904], as an edit (POD-6399). `ok` means the edit is
    // queued; a refusal (an unsaved working tree) arrives later as the
    // session's `lifecycleFailure`, which the session's own bar shows with the
    // force offer, on every device. Only a call the API refuses outright
    // notifies here.
    stop: async (sessionId, opts) =>
      await editSessionLifecycle(sessionId, 'stopped', opts?.force === true),
    // Stop, scoped to the turn the person saw (POD-6397): a `session.interrupt`
    // effect record, queued durably. Every device shows it from the record:
    // Interrupting… until that turn ends, and the Kill offer if it does not.
    interrupt: async (sessionId, args) => {
      const id = `eff_${randomUUID()}`
      await rt.write('effectCreate', {
        id,
        kind: SESSION_INTERRUPT_KIND,
        target: { kind: 'session', id: sessionId },
        input: {
          ...(args.turn !== undefined ? { turn: args.turn } : {}),
          ...(args.messageId !== undefined ? { messageId: args.messageId } : {}),
        },
      })
      return id
    },
    // A model or effort change (POD-6523): a `session.configure` effect record,
    // queued durably. The chip reads its progress and the driver's answer from
    // the record (`SessionModel.configureChange`), on every device.
    configure: async (sessionId, patch) => {
      const id = `eff_${randomUUID()}`
      await rt.write('effectCreate', sessionConfigureEffect({ effectId: id, sessionId, ...patch }))
      return id
    },
    // A move to another machine (POD-6422): a `session.handoff` effect record.
    // The session's pane paints the move from the record until the server's own
    // overlay takes over (`SessionModel.handingOffTo`).
    handoff: async (sessionId, machineId) => {
      const id = `eff_${randomUUID()}`
      await rt.write('effectCreate', sessionHandoffEffect({ effectId: id, sessionId, machineId }))
      return id
    },
    resume: async (sessionId) => await editSessionLifecycle(sessionId, 'running'),
    // An answer to an agent's question (POD-6415): a `session.answer` effect
    // record, created at once and never queued. An answer is online-only: one
    // that reached the server later would land on whatever menu is up by then,
    // so offline it fails here, and the record's own deadline covers the rest.
    answer: async (sessionId, answer) => {
      const id = `eff_${randomUUID()}`
      await submitNow(
        api,
        'effects.create',
        sessionAnswerEffect({ effectId: id, sessionId, answer }),
        { action: 'answer the question' },
      )
      return id
    },
    archive: async (sessionId, archived) => {
      const write = editRecord(
        { kind: 'session', id: sessionId },
        archived ? { archived, workState: 'done' } : { archived },
      )
      if (!archived) return await write
      // An archived session is no longer pinned (POD-6673: a remove of my pin).
      await records.remove({ kind: 'pin', id: pinRowId(rt.userId, 'panel', sessionId) })
      await write
    },
    // An issue's own work as effect records (POD-6526): a session start paints
    // from its record through the launch paint; the rest are read from their
    // records by the issue model (`workAction`).
    startIssueSession: (args) => rt.startIssueSession(args),
    issueAction: async (issueId, action, opts) => {
      const id = `eff_${randomUUID()}`
      await rt.write(
        'effectCreate',
        issueActionEffect({
          effectId: id,
          issueId,
          action,
          ...(opts?.force === true ? { force: true } : {}),
        }),
      )
      return id
    },
    /**
     * "ASK SUPERAGENT (BTW)" — OPEN THE ONE CHAT, WITH THIS SESSION ATTACHED
     * (POD-1069).
     *
     * It used to aim `superThreadId` at `btw_<sessionId>` and mint that thread
     * server-side. The dock has bound the global thread alone since POD-782, so
     * what the operator got was a pane rendering a thread with no headless
     * session: no composer, no way back, and no reset until a reload — from all
     * three entry points (tab overflow, session context menu, command palette).
     *
     * The thread was never the point; the session's transcript was. So the pane
     * stays on the one chat and the session is ATTACHED to whatever the operator
     * types next — the server digests it into that turn's preamble with the same
     * `buildBtwSeed` block the btw thread was seeded with. No thread to switch
     * to, and therefore no thread to be stranded on.
     *
     * `dockTab` IS PART OF THE ACT. Opening the dock is not the same as showing
     * the superagent: the right dock also holds Files, Git and Issue, so an
     * operator sitting on any of those got the dock they already had, with the
     * attachment staged behind a pane that never mentions it — the same "nothing
     * happened" this issue is about, one surface further in.
     */
    startBtw: rt.ui.startBtw,
    dismissEffect: async (id) => await rt.write('effectDismiss', { id }),
    // The session's labels are plain fields of its record (POD-6406): one edit
    // each, last writer wins per field; an archive marks the work done in the
    // same edit.
    rename: async (sessionId, name) => editRecord({ kind: 'session', id: sessionId }, { name }),
    markRead: (sessionId, readAt) => {
      if (readAt === undefined) rt.ui.screen.navigation.readIntent?.('session', sessionId, true)
      return markRead('session', sessionId, readAt ? { readAt } : {})
    },
    markUnread: async (sessionId) => {
      pendingReads.delete(`session:${sessionId}`)
      rt.ui.screen.navigation.readIntent?.('session', sessionId, false)
      return editRecord(mySessionState(sessionId), { readAt: null })
    },
    setWorkState: async (sessionId: SessionId, workState: WorkState | null) =>
      editRecord({ kind: 'session', id: sessionId }, { workState: workState ?? UNSET }),
    // `null` snoozes until the next message; clearing the cell ends the snooze.
    snooze: async (sessionId, until) =>
      editRecord(mySessionState(sessionId), { snoozedUntil: until }),
    clearSnooze: async (sessionId) =>
      editRecord(mySessionState(sessionId), { snoozedUntil: UNSET }),
    setSessionDraft: (sessionId, text) => rt.setSessionDraft(sessionId, text),
  }
}
