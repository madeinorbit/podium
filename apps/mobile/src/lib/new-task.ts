import { AUTO } from '@podium/client-core/agent-models'
import type { SpawnIssueAgentArgs } from '@podium/client-core/spawn-agent'
import type { AgentKind, IssueStage, IssueType, MachineId } from '@podium/model'

export interface NewTaskInput {
  repoPath: string
  title: string
  description?: string
  type: IssueType
  priority: number
  startNow: boolean
  defaultAgent?: string
  defaultModel?: string
  defaultEffort?: string
  machineId?: MachineId
}

/** Exact create payload: prompt text is never reconstructed or dropped by launch configuration. */
export function newTaskInput(args: {
  repoPath: string
  title: string
  prompt: string
  type: IssueType
  priority: number
  startNow: boolean
  launch: {
    defaultAgent?: string
    defaultModel: string
    defaultEffort: string
    machineId: MachineId | null
  }
}): NewTaskInput {
  const hasPrompt = args.prompt.trim().length > 0
  return {
    repoPath: args.repoPath.trim(),
    title: args.title.trim(),
    ...(hasPrompt ? { description: args.prompt } : {}),
    type: args.type,
    priority: args.priority,
    startNow: args.startNow,
    ...(args.startNow
      ? {
          ...(args.launch.defaultAgent ? { defaultAgent: args.launch.defaultAgent } : {}),
          ...(args.launch.defaultModel !== AUTO ? { defaultModel: args.launch.defaultModel } : {}),
          ...(args.launch.defaultEffort !== AUTO
            ? { defaultEffort: args.launch.defaultEffort }
            : {}),
          ...(args.launch.machineId ? { machineId: args.launch.machineId } : {}),
        }
      : {}),
  }
}

/**
 * "Create and start" as the pool's `issue.start` (POD-6421): the same fields
 * the create took, the prompt verbatim as the task's description, and the
 * agent left on the configured coding role when Agent stays Auto (the shown
 * agent is then only what the start paints). Backlog is the screen's default
 * and adds nothing: a started task reads In progress; another stage is applied
 * once it has started.
 */
export function newTaskStart(args: {
  repoPath: string
  title: string
  prompt: string
  priority: number
  stage: IssueStage
  /** The agent the screen shows: painted, and started when pinned. */
  agentKind: AgentKind
  launch: {
    defaultAgent?: string
    defaultModel: string
    defaultEffort: string
    machineId: MachineId | null
  }
}): SpawnIssueAgentArgs {
  const repoPath = args.repoPath.trim()
  const pinned = args.launch.defaultAgent
  return {
    target: {
      path: repoPath,
      repoPath,
      ...(args.launch.machineId ? { machineId: args.launch.machineId } : {}),
    },
    title: args.title.trim(),
    description: args.prompt.trim().length > 0 ? args.prompt : '',
    agentKind: (pinned as AgentKind | undefined) ?? args.agentKind,
    ...(pinned ? {} : { inheritAgent: true }),
    ...(args.launch.defaultModel !== AUTO ? { model: args.launch.defaultModel } : {}),
    ...(args.launch.defaultEffort !== AUTO ? { effort: args.launch.defaultEffort } : {}),
    ...(args.priority !== 2 ? { priority: args.priority } : {}),
    ...(args.stage !== 'backlog' && args.stage !== 'shipping' ? { stage: args.stage } : {}),
  }
}
