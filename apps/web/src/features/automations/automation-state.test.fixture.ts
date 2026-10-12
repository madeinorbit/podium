import type { Automation } from './AutomationsView'
import type { AutomationFormState } from './automation-form'
import { GLOBAL_TARGET } from './automation-form'
import { localDateTimeValue } from './automation-edit-draft'
import { issueDefaultAgentKind } from '@/lib/issue-agents'
import { AUTO } from '@podium/client-core/agent-models'

/** Frozen pre-migration oracle; production editors never snapshot records. */
export function initialState(automation: Automation | null, defaultTarget: string): AutomationFormState {
  return {
    name: automation?.name ?? '',
    kind: 'schedule',
    // Existing recurring schedules open as custom cron so their exact expression
    // is preserved.
    freq: automation ? (automation.scheduleKind === 'once' ? 'once' : 'cron') : 'daily',
    time: '09:00',
    weekday: 1, // Monday
    rawCron: automation?.cron ?? '',
    runAt: localDateTimeValue(automation?.runAt),
    reactive: 'merge-main',
    glob: '',
    target: automation ? (automation.repoPath ?? GLOBAL_TARGET) : defaultTarget,
    prompt: automation?.prompt ?? '',
    agent: issueDefaultAgentKind(automation?.agentKind),
    model: automation?.model ?? AUTO,
    effort: automation?.effort ?? AUTO,
    enabled: automation?.enabled ?? true,
    sessionMode: automation?.sessionMode ?? 'fresh',
  }
}
