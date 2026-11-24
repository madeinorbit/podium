import type { ConversationSendInput } from '@podium/client-core/conversation'
import { composerState, phoneChatActivity } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { here } from '@podium/client-graph/lookup'
import { MailReply, type MailReplyApi } from '@podium/client-graph/mail-reply'
import type { CurrentMessageRecord } from '@podium/client-graph/message-models'
import { superagentState } from '@podium/client-graph/superagent'
import { lazy } from '@podium/mobx-helpers'
import { isAgentComputing } from '@podium/model'
import { actionBound, compareStructural, observable, observableRef } from 'mobx'
import { MobileTranscriptSearch } from './conversation-presentation'
import type { MobileConversation } from './mobile-conversation'
import {
  applySuperagentModelPick,
  resolveSuperagentBackend,
  type SuperagentBackendPick,
} from './superagent-backend'
import { liveTranscriptItem } from './superagent-transcript'

/** One phone reader. The warm service owns the stream, never the reader's choices. */
export class MobileChatViewModel {
  readonly find: MobileTranscriptSearch
  @observable accessor following = true
  @observable accessor searching = false
  @observableRef accessor backendPick: SuperagentBackendPick = {}
  @lazy({ equals: compareStructural }) get backend() {
    return resolveSuperagentBackend(superagentState(this.pool).active, this.backendPick)
  }
  @actionBound setBackendModel(model: string, agentKind?: string): void {
    this.backendPick = applySuperagentModelPick(this.backendPick, model, agentKind)
    this.saveBackend?.({ model, effort: 'auto' })
  }
  @actionBound setBackendEffort(effort: string): void {
    this.backendPick = { ...this.backendPick, effort }
    this.saveBackend?.({ effort })
  }
  /** A reply to the agent that asked the operator a question (POD-2380): the
   *  web's shared flow, so a written reply goes to the asker over the existing
   *  `messages.reply`, never into the session prompt. */
  readonly reply: MailReply
  /** `saveBackend`: the pick as the thread's own choice, a queued edit of its
   *  record (POD-6675). The send still carries the pick for its own turn. */
  constructor(
    private readonly service: MobileConversation,
    private readonly pool: MobxPool,
    private readonly saveBackend?: (choice: { model?: string; effort?: string }) => void,
    replyApi: MailReplyApi = UNWIRED_REPLY,
    current?: CurrentMessageRecord,
  ) {
    this.find = new MobileTranscriptSearch(service.presentation)
    this.reply = new MailReply(pool, replyApi, current)
  }

  @lazy get session() {
    return here(this.pool.model('session', this.service.sessionId))
  }
  /** While replying, the composer writes the reply's own draft and the session's
   *  prompt draft waits untouched underneath, as on the web. */
  @lazy get draft(): string {
    return this.reply.active
      ? this.reply.draft
      : this.pool.sessionObject(this.service.sessionId).messageDraft
  }
  @actionBound setDraft(text: string): void {
    if (this.reply.active) this.reply.setDraft(text)
    else this.pool.sessionObject(this.service.sessionId).setMessageDraft(text)
  }
  @actionBound setFollowing(value: boolean): void {
    this.following = value
  }
  @actionBound setSearching(value: boolean): void {
    this.searching = value
  }
  open(): () => void {
    const release = this.service.addReader(() => !this.following || this.searching)
    return () => {
      this.reply.cancel()
      release()
    }
  }

  // Transcript port: screens and rows read this view, never the warm log.
  @lazy get ids() {
    return this.service.transcript.ids
  }
  @lazy get byId() {
    return this.service.transcript.byId
  }
  get items() {
    return this.service.transcript.items
  }
  @lazy get initialLoaded() {
    return this.service.transcript.initialLoaded
  }
  @lazy get storedSettled() {
    return this.service.transcript.storedSettled
  }
  @lazy get hasMoreOlder() {
    return this.service.transcript.hasMoreOlder
  }
  @lazy get loadingOlder() {
    return this.service.transcript.loadingOlder
  }
  @lazy get pendingQuestion() {
    return this.service.pendingQuestion
  }
  @lazy get freshness() {
    return this.service.transcript.freshness
  }
  @lazy get offlineAsOf() {
    return this.service.transcript.offlineAsOf
  }
  @lazy get presentation() {
    return this.service.presentation
  }
  markRendered(): void {
    this.service.transcript.markRendered()
  }
  loadOlder(): Promise<boolean> {
    return this.service.transcript.loadOlder()
  }

  // Send port: record-backed bubbles come from the shared message models.
  @lazy get bubbles() {
    return this.service.sends.bubbles
  }
  @lazy get pending() {
    return this.service.sends.pending
  }
  @lazy get offer() {
    return this.service.sends.offer
  }
  @lazy get canInterrupt() {
    return this.service.sends.canInterrupt
  }
  @lazy get interruptError() {
    return this.service.sends.interruptError
  }
  @lazy({ equals: compareStructural }) get activity() {
    return phoneChatActivity(
      this.session,
      this.justSent,
      this.offer,
      this.service.sends.wakeRequestedAt,
    )
  }
  @lazy({ equals: compareStructural }) get composer() {
    return composerState({
      session: this.session,
      headless: false,
      turnRunning: false,
      compact: false,
      phoneWakeRequestedAt: this.service.sends.wakeRequestedAt,
    })
  }
  @lazy get turnActive(): boolean {
    return (this.session !== undefined && isAgentComputing(this.session)) || this.justSent
  }
  @lazy get justSent() {
    return this.service.sends.justSent
  }
  @lazy get turnRunning() {
    return this.service.turnRunning
  }
  @lazy get turnError() {
    return this.service.turnError
  }
  @lazy get visibleFailure() {
    return this.service.visibleFailure
  }
  @lazy get overlayLabel() {
    return this.service.headless?.label
  }
  @lazy get hasStreamingText(): boolean {
    return this.turnRunning && !!this.service.headless?.text
  }
  @lazy get liveItem() {
    return liveTranscriptItem(this.service.headless?.text ?? '', this.turnRunning)
  }
  submit(input: ConversationSendInput) {
    return this.service.sends.submit(input)
  }
  replyToAsyncQuestion(reply: Parameters<MobileConversation['replyToAsyncQuestion']>[0]) {
    return this.service.replyToAsyncQuestion(reply)
  }
  retry(id: string) {
    return this.service.sends.retry(id)
  }
  sendAgain(id: string) {
    return this.service.sends.sendAgain(id)
  }
  discard(id: string) {
    return this.service.sends.discard(id)
  }
  retract(id: string) {
    return this.service.sends.retract(id)
  }
  sendOffer(prompt: string, at: string) {
    return this.service.sends.sendOffer(prompt, at)
  }
  dismissOffer(at: string) {
    return this.service.sends.dismissOffer(at)
  }
  interrupt(draft = this.draft, options?: { restore?: boolean }) {
    return this.service.sends.interrupt(draft, options)
  }
  finishTurn(): void {
    this.service.finishTurn()
  }
  clear(): void {
    this.service.clear()
  }
  setTurnError(error: string): void {
    this.service.setTurnError(error)
  }
}

const UNWIRED_REPLY: MailReplyApi = {
  show: () => Promise.reject(new Error('Replies are not available here.')),
  reply: () => Promise.reject(new Error('Replies are not available here.')),
}
