import { draft, lazy } from '@podium/mobx-helpers'
import { action, observable } from 'mobx'
import type { Automation } from './AutomationsView'
import { automationInput, GLOBAL_TARGET, type AutomationFormState } from './automation-form'
import type { Frequency } from './cron-format'
import { issueDefaultAgentKind } from '@/lib/issue-agents'

export const localDateTimeValue = (iso?: string | null): string => {
  const fallback = new Date(Date.now() + 60 * 60_000)
  fallback.setSeconds(0, 0)
  const date = iso ? new Date(iso) : fallback
  if (Number.isNaN(date.getTime())) return ''
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

const FIELDS = ['name', 'repoPath', 'scheduleKind', 'cron', 'runAt', 'agentKind',
  'model', 'effort', 'prompt', 'enabled', 'sessionMode'] as const
export type AutomationChanges = Partial<Pick<Automation, typeof FIELDS[number]>>

/** The record draft owns edits; schedule controls are this opening's UI state. */
export class AutomationEditDraft implements AutomationFormState {
  readonly record
  @observable accessor kind: AutomationFormState['kind'] = 'schedule'
  @observable accessor time = '09:00'
  @observable accessor weekday = 1
  @observable accessor reactive: AutomationFormState['reactive'] = 'merge-main'
  @observable accessor glob = ''
  @observable accessor frequency: Frequency | null = null

  constructor(readonly automation: Automation, save: (changes: AutomationChanges) => Promise<unknown>) {
    this.record = draft(automation, { fields: FIELDS, save: changes => {
      const patch = { ...changes,
        ...('name' in changes ? { name: changes.name!.trim() } : {}),
        ...('prompt' in changes ? { prompt: changes.prompt!.trim() } : {}),
      }
      return save(patch).catch(error => {
        // A rejected save keeps the edited fields; untouched fields stay live.
        Object.assign(this.record, changes)
        throw error
      })
    } })
  }
  @lazy get name() { return this.record.name }
  @lazy get prompt() { return this.record.prompt }
  @lazy get agent() { return issueDefaultAgentKind(this.record.agentKind) }
  @lazy get model() { return this.record.model ?? 'auto' }
  @lazy get effort() { return this.record.effort ?? 'auto' }
  @lazy get enabled() { return this.record.enabled }
  @lazy get sessionMode() { return this.record.sessionMode ?? 'fresh' }
  @lazy get target() { return this.record.repoPath ?? GLOBAL_TARGET }
  @lazy get freq(): Frequency { return this.frequency ?? (this.record.scheduleKind === 'once' ? 'once' : 'cron') }
  @lazy get rawCron() { return this.record.cron ?? '' }
  @lazy get runAt() { return localDateTimeValue(this.record.runAt) }
  @lazy get isDirty() { return this.record.isDirty }

  @action patch(next: Partial<AutomationFormState>): void {
    if (next.name !== undefined) this.record.name = next.name
    if (next.prompt !== undefined) this.record.prompt = next.prompt
    if (next.agent !== undefined) this.record.agentKind = next.agent
    if (next.model !== undefined) this.record.model = next.model
    if (next.effort !== undefined) this.record.effort = next.effort
    if (next.enabled !== undefined) this.record.enabled = next.enabled
    if (next.sessionMode !== undefined) this.record.sessionMode = next.sessionMode
    if (next.target !== undefined) this.record.repoPath = next.target === GLOBAL_TARGET ? null : next.target
    if (next.kind !== undefined) this.kind = next.kind
    if (next.reactive !== undefined) this.reactive = next.reactive
    if (next.glob !== undefined) this.glob = next.glob
    if (next.time !== undefined) this.time = next.time
    if (next.weekday !== undefined) this.weekday = next.weekday
    if (next.freq !== undefined) this.frequency = next.freq
    if (next.rawCron !== undefined) this.record.cron = next.rawCron
    if (next.runAt !== undefined) this.record.runAt = next.runAt ? new Date(next.runAt).toISOString() : null
    if (next.freq !== undefined || next.time !== undefined || next.weekday !== undefined) {
      const input = automationInput(this, this.automation)
      this.record.scheduleKind = input.scheduleKind
      this.record.cron = input.cron
      this.record.runAt = input.runAt
    }
  }
  @action reset(): void {
    this.record.reset()
    this.frequency = null
    this.kind = 'schedule'
    this.time = '09:00'
    this.weekday = 1
    this.reactive = 'merge-main'
    this.glob = ''
  }
  submit() { return this.record.submit() }
}
