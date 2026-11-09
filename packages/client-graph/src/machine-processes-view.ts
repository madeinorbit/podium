import type { SocketHub, TopicState } from '@podium/client-core/socket-transport'
import type { MachineId } from '@podium/model'
import type { TopicPayload } from '@podium/protocol'
import { action, observableRef } from 'mobx'
import { type AnswerMachines, answerMachineId, focusRefresh } from './answer-refresh'

export class MachineProcessesView {
  @observableRef accessor snapshot: {
    value?: TopicPayload<'machine.processes'>
    error: string | null
    pending: boolean
  } = { error: null, pending: true }
  private release?: () => void
  private stopMachines?: () => void
  private stopFocus?: () => void
  private machine?: MachineId
  constructor(
    private readonly hub: Pick<SocketHub, 'subscribeTopic' | 'refreshTopic'>,
    private readonly machines: AnswerMachines,
    private readonly requested?: MachineId,
  ) {}
  open(): void {
    if (this.stopMachines) return
    this.bind()
    this.stopMachines = this.machines.subscribe(() => this.bind())
    // Older daemons get a one-shot server request again on focus; never a client poll.
    this.stopFocus = focusRefresh(() => this.refresh())
  }
  @action private bind(): void {
    const id = answerMachineId(this.machines, this.requested)
    if (this.machine === id && this.release) return
    this.release?.()
    this.machine = id
    this.snapshot = { error: null, pending: true }
    this.release = id
      ? this.hub.subscribeTopic('machine.processes', id, { onState: (state) => this.apply(state) })
      : undefined
  }
  @action private apply(state: TopicState<TopicPayload<'machine.processes'>>): void {
    if (state.status === 'value')
      this.snapshot = { value: state.value, error: null, pending: false }
    else
      this.snapshot = {
        error: state.status === 'closed' ? `Machine inventory ${state.reason}` : null,
        pending: state.status === 'pending',
      }
  }
  refresh(): void {
    if (this.machine) this.hub.refreshTopic('machine.processes', this.machine)
  }
  @action close(): void {
    this.release?.()
    this.stopMachines?.()
    this.stopFocus?.()
    this.release = this.stopMachines = this.stopFocus = undefined
    this.machine = undefined
    this.snapshot = { error: null, pending: true }
  }
}
