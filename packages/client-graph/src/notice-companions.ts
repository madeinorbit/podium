import type { MessageNotice, PendingInteractionCard } from '@podium/client-core/values'
import { deadLetterDeliveryLine } from '@podium/model'
import { machinePathBasename } from '@podium/model/browser'
import { companion, lazy } from '@podium/mobx-helpers'
import type { MessageModel, PendingInteractionModel } from './message-models'
import type { MobxPool } from './pool'
import { pendingInteractionCard } from './notice-card'

export class NoticeMessage implements MessageNotice {
  readonly messageId: string
  constructor(readonly message: MessageModel, private readonly pool: MobxPool) { this.messageId = message.id }
  get sessionId() { return this.message.sessionId! }
  get status() { return this.message.status as MessageNotice['status'] }
  get createdAt() { return this.message.createdAt }
  @lazy get sessionLabel(): string {
    const session = this.pool.sessionObject(this.sessionId)
    if (!session.known) {
      const row = this.pool.row('session', this.sessionId, 'summary-fields')
      return typeof row === 'symbol' ? 'Loading session…' : 'a closed session'
    }
    return session.name?.trim() || session.title?.trim() || machinePathBasename(session.cwd ?? '') || session.agentKind || 'a closed session'
  }
  @lazy get excerpt(): string {
    const first = this.message.body.trim().split('\n')[0] ?? ''
    return first.length > 80 ? `${first.slice(0, 79)}…` : first
  }
  @lazy get line(): string {
    return this.status === 'unknown' ? 'not confirmed — it may or may not have arrived'
      : this.status === 'expired' ? 'not delivered · it waited too long' : deadLetterDeliveryLine(this.message.reason)
  }
}
export class NoticeInteraction implements PendingInteractionCard {
  readonly id: string
  constructor(readonly interaction: PendingInteractionModel) { this.id = interaction.id }
  @lazy private get card() { return pendingInteractionCard(this.interaction) }
  get sessionId() { return this.interaction.sessionId }
  get kind() { return this.interaction.kind }
  @lazy get title() { return this.card.title }
  @lazy get detail() { return this.card.detail }
  @lazy get actions() { return this.card.actions }
  @lazy get note() { return this.card.note }
  @lazy get surface() { return this.card.surface }
}
class Notices {
  constructor(private readonly pool: MobxPool) {}
  readonly message = companion((message: MessageModel) => new NoticeMessage(message, this.pool))
  readonly interaction = companion((interaction: PendingInteractionModel) => new NoticeInteraction(interaction))
}
export function noticeCompanions(pool: MobxPool) { return pool.sources.view('notice-companions', () => new Notices(pool)) }
