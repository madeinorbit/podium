import { here } from '@podium/client-graph/lookup'
import type { MobxPool } from '@podium/client-graph'
import type { ConversationSendInput } from '@podium/client-core/conversation'
import { chatActivity, composerState } from '@podium/client-core/values'
import { isAgentComputing } from '@podium/model'
import { lazy } from '@podium/mobx-helpers'
import { actionBound, observable, observableRef, compareStructural } from 'mobx'
import { superagentState } from '@podium/client-graph/superagent'
import { applySuperagentModelPick, resolveSuperagentBackend, type SuperagentBackendPick } from './superagent-backend'
import { liveTranscriptItem } from './superagent-transcript'
import type { MobileConversation } from './mobile-conversation'

/** One phone reader. The warm service owns the stream, never the reader's choices. */
export class MobileChatViewModel {
  @observable accessor following = true
  @observable accessor searching = false
  @observableRef accessor backendPick: SuperagentBackendPick = {}
  @lazy({ equals: compareStructural }) get backend() { return resolveSuperagentBackend(superagentState(this.pool).active, this.backendPick) }
  @actionBound setBackendModel(model: string, agentKind?: string): void { this.backendPick = applySuperagentModelPick(this.backendPick, model, agentKind) }
  @actionBound setBackendEffort(effort: string): void { this.backendPick = { ...this.backendPick, effort } }
  constructor(private readonly service: MobileConversation, private readonly pool: MobxPool) {}

  @lazy get session() { return here(this.pool.model('session', this.service.sessionId)) }
  @lazy get draft(): string { return this.pool.sessionObject(this.service.sessionId).messageDraft }
  @actionBound setDraft(text: string): void { this.pool.sessionObject(this.service.sessionId).setMessageDraft(text) }
  @actionBound setFollowing(value: boolean): void { this.following = value }
  @actionBound setSearching(value: boolean): void { this.searching = value }
  open(): () => void { return this.service.addReader(() => !this.following || this.searching) }

  // Transcript port: screens and rows read this view, never the warm log.
  @lazy get ids() { return this.service.transcript.ids }
  @lazy get byId() { return this.service.transcript.byId }
  get items() { return this.service.transcript.items }
  @lazy get initialLoaded() { return this.service.transcript.initialLoaded }
  @lazy get hasMoreOlder() { return this.service.transcript.hasMoreOlder }
  @lazy get loadingOlder() { return this.service.transcript.loadingOlder }
  @lazy get pendingQuestion() { return this.service.transcript.pendingQuestion }
  @lazy get freshness() { return this.service.transcript.freshness }
  @lazy get offlineAsOf() { return this.service.transcript.offlineAsOf }
  @lazy get presentation() { return this.service.presentation }
  markRendered(): void { this.service.transcript.markRendered() }
  loadOlder(): Promise<boolean> { return this.service.transcript.loadOlder() }

  // Send port: record-backed bubbles come from the shared message models.
  @lazy get bubbles() { return this.service.sends.bubbles }
  @lazy get pending() { return this.service.sends.pending }
  @lazy get offer() { return this.service.sends.offer }
  @lazy get canInterrupt() { return this.service.sends.canInterrupt }
  @lazy get interruptError() { return this.service.sends.interruptError }
  @lazy({ equals: compareStructural }) get activity() { return chatActivity(this.session, this.justSent, this.offer) }
  @lazy({ equals: compareStructural }) get composer() { return composerState({ session: this.session, headless: false, turnRunning: false, compact: false }) }
  @lazy get turnActive(): boolean { return (this.session !== undefined && isAgentComputing(this.session)) || this.justSent }
  @lazy get justSent() { return this.service.sends.justSent }
  @lazy get turnRunning() { return this.service.turnRunning }
  @lazy get turnError() { return this.service.turnError }
  @lazy get visibleFailure() { return this.service.visibleFailure }
  @lazy get overlayLabel() { return this.service.headless?.label }
  @lazy get hasStreamingText(): boolean { return this.turnRunning && !!this.service.headless?.text }
  @lazy get liveItem() { return liveTranscriptItem(this.service.headless?.text ?? '', this.turnRunning) }
  submit(input: ConversationSendInput) { return this.service.sends.submit(input) }
  retry(id: string) { return this.service.sends.retry(id) }
  sendAgain(id: string) { return this.service.sends.sendAgain(id) }
  discard(id: string) { return this.service.sends.discard(id) }
  retract(id: string) { return this.service.sends.retract(id) }
  sendOffer(prompt: string, at: string) { return this.service.sends.sendOffer(prompt, at) }
  dismissOffer(at: string) { return this.service.sends.dismissOffer(at) }
  interrupt(draft = this.draft) { return this.service.sends.interrupt(draft) }
  finishTurn(): void { this.service.finishTurn() }
  clear(): void { this.service.clear() }
  setTurnError(error: string): void { this.service.setTurnError(error) }
}
