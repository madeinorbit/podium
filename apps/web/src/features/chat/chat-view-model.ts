import type { SessionView } from '@podium/client-core/session-values'
import { chatActivityState, chatSessionReference, composerState, isOperatorPromptRow, parseEnvelopeBatch, pendingAskFromState, transcriptAttributionTable, transcriptPhase, type ChatRow, type SuperThreadRef } from '@podium/client-core/values'
import { lazy } from '@podium/mobx-helpers'
import { isAgentComputing, isMachineOfflineForLiveTerminal } from '@podium/model/browser'
import { actionBound, compareStructural, observable, observableRef } from 'mobx'
import { ConversationPresentation } from './conversation-presentation.next'
import type { WebConversation } from './use-conversation.next'

/** One mounted reader. Shared transcript and send facts stay on Conversation. */
export class ChatViewModel {
  readonly presentation = new ConversationPresentation()
  @observable accessor active = true
  @observable accessor stickyPrompts = false
  @observable accessor ctxSeq: number | null = null
  @observableRef accessor backendPick: { model?: string; effort?: string; agentKind?: string | null } = {}
  private release: (() => void) | undefined

  constructor(readonly conversation: WebConversation, readonly compact: boolean,
    readonly superThread: SuperThreadRef | undefined, private readonly clearAttachedSession: () => void) {}

  open(): void { this.release = this.conversation.addView(this.presentation) }
  close(): void { this.release?.(); this.release = undefined }
  @actionBound setOptions(active: boolean, stickyPrompts: boolean): void {
    this.active = active; this.stickyPrompts = stickyPrompts
  }
  @lazy get session(): SessionView | undefined {
    const pool = this.conversation.pool
    const row = pool.row('session', this.conversation.sessionId)
    return !row || typeof row === 'symbol' ? undefined : pool.model('session', this.conversation.sessionId) as unknown as SessionView
  }
  @lazy get reference() {
    const row = this.conversation.pool.row('sessionExit', this.conversation.sessionId)
    const exit = row && typeof row !== 'symbol' ? row.kind : undefined
    return chatSessionReference(this.conversation.sessionId, this.session ? [this.session] : [], () => exit)
  }
  @lazy get cwd(): string { return this.session?.cwd ?? '/' }
  @lazy get headless(): boolean { return this.superThread !== undefined || this.session?.headless === true }
  @lazy get stickyEnabled(): boolean { return this.stickyPrompts && !this.compact }
  @lazy get phase() {
    return transcriptPhase({ reference: this.reference, blockCount: this.presentation.blockCount,
      pendingCount: this.conversation.hasPending ? 1 : 0,
      initialLoaded: this.conversation.transcript.initialLoaded && this.presentation.computeReady })
  }
  @lazy get gone(): boolean { return this.phase === 'gone' }
  @lazy get moreAbove(): boolean {
    const log = this.conversation.transcript
    return this.presentation.renderStart > 0 || (log.hasMoreOlder && log.head !== undefined)
  }
  @lazy get rowsToRender() { return this.presentation.renderRows(this.stickyEnabled, this.headless) }
  @lazy get livePendingAskIndex(): number {
    return this.session?.status === 'live' || this.session?.status === 'starting' ? this.presentation.pendingAskIndex : -1
  }
  @lazy get pendingAskBlock() {
    return pendingAskFromState(this.session?.agentState?.need, this.session?.status,
      this.session?.agentState?.phase, this.livePendingAskIndex >= 0)
  }
  @lazy get attribution() { return transcriptAttributionTable(this.session) }
  @lazy get composer() {
    const state = composerState({ session: this.session, headless: this.headless,
      turnRunning: this.conversation.turnRunning, compact: this.compact })
    return this.conversation.ready ? state : { ...state, deliverable: false, sendable: false }
  }
  @lazy get activity() {
    return chatActivityState({ session: this.session, headless: this.headless,
      turnRunning: this.conversation.turnRunning, justSent: this.conversation.sends.justSent })
  }
  @lazy get turnActive(): boolean {
    return this.headless ? this.conversation.turnRunning : (this.session !== undefined && isAgentComputing(this.session)) || this.conversation.sends.justSent
  }
  @lazy get turnError(): string | null { return this.conversation.turnError ?? this.conversation.visibleFailure?.error ?? null }
  @lazy get pending() {
    return this.conversation.sends.bubbles.map(bubble => bubble.error === undefined ? bubble : {
      ...bubble, failure: bubble.notice !== undefined || bubble.error.startsWith('not sent') ? bubble.error : `not delivered — ${bubble.error}`,
    })
  }
  @lazy get offer() { return this.headless ? null : this.conversation.sends.offer }
  @lazy get question() {
    const reader = this.conversation.pool.row('chatContextReader', 'reader')
    return reader && typeof reader !== 'symbol' ? reader.interactions(this.conversation.sessionId).question : undefined
  }
  @lazy get blocked(): boolean {
    const reader = this.conversation.pool.row('chatContextReader', 'reader')
    return reader && typeof reader !== 'symbol' ? reader.interactions(this.conversation.sessionId).blocked : false
  }
  @lazy get presenceOfflineMachineName(): string | null {
    if (!this.active) return null
    const pool = this.conversation.pool
    const id = this.session?.machineId
    const machine = id === undefined ? undefined : pool.row('machine', id)
    return machine && typeof machine !== 'symbol' && isMachineOfflineForLiveTerminal(machine)
      ? this.session?.machineName ?? machine.name ?? id ?? null : null
  }
  @lazy({ equals: compareStructural }) get attached() {
    if (!this.superThread) return null
    const pool = this.conversation.pool
    const window = pool.row('chatWindow', 'window')
    const id = window && typeof window !== 'symbol' ? window.attachedSessionId : null
    if (!id) return null
    const session = pool.model('session', id)
    return { sessionId: id, label: session?.name ?? session?.title ?? id, clear: this.clearAttachedSession }
  }
  @lazy get transcriptReveal() {
    const row = this.conversation.pool.row('chatWindow', 'window')
    return row && typeof row !== 'symbol' ? row.transcriptReveal : null
  }
  @lazy get backend() {
    const model = this.backendPick.model ?? this.conversation.thread?.model ?? 'auto'
    return { model, effort: this.backendPick.effort ?? this.conversation.thread?.effort ?? 'auto',
      agentKind: this.backendPick.agentKind !== undefined ? this.backendPick.agentKind ?? undefined
        : model !== 'auto' ? this.conversation.thread?.agentKind : undefined }
  }
  @actionBound setBackendModel(model: string, agentKind?: string): void {
    this.backendPick = { ...this.backendPick, model, agentKind: model === 'auto' ? null : agentKind ?? this.backendPick.agentKind, effort: 'auto' }
  }
  @actionBound setBackendEffort(effort: string): void { this.backendPick = { ...this.backendPick, effort } }
  @actionBound captureContext(): void {
    if (!this.compact) return
    const id = this.conversation.runtime.access.getUserFocus().issueId
    this.ctxSeq = id ? this.conversation.pool.model('issue', id)?.seq ?? null : null
  }
  isOperatorPromptRow = (row: ChatRow): boolean => isOperatorPromptRow(row, {
    collapseMachineContext: this.headless,
    operatorTextOf: text => parseEnvelopeBatch(text)?.operatorText,
  })
}
