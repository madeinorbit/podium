import type { ParsedEnvelope } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { here } from '@podium/client-graph/lookup'
import {
  type CurrentMessageRecord,
  confirmMessageReply,
  ingestLedgerMessages,
} from '@podium/client-graph/message-models'
import { MessageLedgerWire } from '@podium/model/browser'
import { actionBound, observable, observableRef, runInAction } from 'mobx'

/** The existing endpoint returns an opaque JSON receipt through the mail router. */
function readReceipt(value: unknown): { id: string; ok: boolean; acked: boolean; reason?: string } {
  const receipt = value as { id?: unknown; ok?: unknown; acked?: unknown; reason?: unknown } | null
  if (
    !receipt ||
    typeof receipt.id !== 'string' ||
    typeof receipt.ok !== 'boolean' ||
    typeof receipt.acked !== 'boolean'
  )
    throw new Error('The server returned an invalid reply receipt.')
  return {
    id: receipt.id,
    ok: receipt.ok,
    acked: receipt.acked,
    ...(typeof receipt.reason === 'string' ? { reason: receipt.reason } : {}),
  }
}
export interface MailReplyApi {
  show(id: string): Promise<unknown>
  reply(id: string, body: string): Promise<unknown>
}

/** UI state for one mounted composer. The selected destination is stored on
 * open so incoming notes cannot redirect a half-written reply. Normal prompt
 * drafts remain on the session; mail metadata stays on the shared message. */
export class MailReply {
  @observableRef accessor target: Pick<ParsedEnvelope, 'id' | 'from'> | null = null
  @observable accessor active = false
  @observable accessor draft = ''
  @observable accessor sending = false
  @observable accessor error: string | null = null
  private generation = 0
  constructor(
    readonly pool: MobxPool,
    readonly api: MailReplyApi,
    readonly current?: CurrentMessageRecord,
  ) {}

  message(id: string) {
    return here(this.pool.model('messageRecord', id))
  }
  async load(id: string): Promise<void> {
    const message = MessageLedgerWire.parse(await this.api.show(id))
    if (message.id !== id) throw new Error('The server returned a different note.')
    ingestLedgerMessages(this.pool, [message], this.current)
  }

  @actionBound start(envelope: ParsedEnvelope): void {
    if (this.active && this.target?.id === envelope.id) return
    if (this.target?.id !== envelope.id) this.draft = ''
    this.target = { id: envelope.id, from: envelope.from }
    this.active = true
    this.error = null
    this.generation++
  }
  @actionBound cancel(): void {
    this.active = false
    this.error = null
    this.generation++
  }
  @actionBound setDraft(text: string): void {
    if (!this.sending) this.draft = text
  }

  async send(body: string): Promise<boolean> {
    const target = this.target
    if (!this.active || !target || this.sending || !body.trim()) return false
    if (body.length > 32768) {
      runInAction(() => {
        this.error = 'Replies can contain up to 32,768 characters.'
      })
      return false
    }
    const generation = this.generation
    runInAction(() => {
      this.sending = true
      this.error = null
    })
    try {
      // Load the canonical row before confirming the server's ack receipt.
      await this.load(target.id)
      const result = readReceipt(await this.api.reply(target.id, body))
      if (!result.ok) throw new Error(result.reason ?? 'The reply could not be delivered.')
      if (!result.acked) throw new Error('The server did not confirm the reply.')
      confirmMessageReply(this.pool, target.id, result.id)
      runInAction(() => {
        if (this.generation === generation) {
          this.draft = ''
          this.active = false
          this.error = null
        }
      })
      return this.generation === generation
    } catch (error) {
      runInAction(() => {
        if (this.generation === generation)
          this.error =
            error instanceof Error ? error.message : 'Could not send the reply. Try again.'
      })
      return false
    } finally {
      runInAction(() => {
        this.sending = false
      })
    }
  }
}
