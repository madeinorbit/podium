import type { IssueType, MachineId } from '@podium/model'

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
    defaultAgent: string
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
          defaultAgent: args.launch.defaultAgent,
          defaultModel: args.launch.defaultModel,
          defaultEffort: args.launch.defaultEffort,
          ...(args.launch.machineId ? { machineId: args.launch.machineId } : {}),
        }
      : {}),
  }
}
