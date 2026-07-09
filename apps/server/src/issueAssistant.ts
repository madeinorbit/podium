import { ISSUE_STAGES, type IssueStage } from '@podium/protocol'
import type { LlmMessage } from './llm'

export interface StageDigest {
  stage: IssueStage
  hasPlanArtifact: boolean
  anyWorking: boolean
  allIdleDone: boolean
  prOpen: boolean
  merged: boolean
}

export function suggestStage(d: StageDigest): IssueStage | null {
  let target: IssueStage = d.stage
  if (d.merged) target = 'done'
  else if (d.prOpen) target = 'review'
  else if (d.stage === 'planning' && d.hasPlanArtifact && d.allIdleDone) target = 'in_progress'
  return target !== d.stage ? target : null
}

export interface AssistantResult {
  activityNotes: string
  suggestedStage: IssueStage | null
  suggestedReason: string
  blockedBy: string[]
  dependencyNote: string
}

export function parseAssistantJson(text: string): AssistantResult | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced?.[1] ?? text).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < start) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  const stage = obj.suggestedStage
  return {
    activityNotes: typeof obj.activityNotes === 'string' ? obj.activityNotes : '',
    suggestedStage: typeof stage === 'string' && (ISSUE_STAGES as string[]).includes(stage) ? (stage as IssueStage) : null,
    suggestedReason: typeof obj.suggestedReason === 'string' ? obj.suggestedReason : '',
    blockedBy: Array.isArray(obj.blockedBy) ? obj.blockedBy.filter((x): x is string => typeof x === 'string') : [],
    dependencyNote: typeof obj.dependencyNote === 'string' ? obj.dependencyNote : '',
  }
}

export interface AssistantContext {
  issue: { title: string; description: string; stage: string; branch: string | null; prUrl?: string }
  gitStatus: string
  gitLog: string
  members: { agentKind: string; phase: string; tail: string }[]
  otherIssues: { seq: number; title: string; stage: string; branch: string | null }[]
}

export function buildAssistantMessages(ctx: AssistantContext): LlmMessage[] {
  const system =
    'You maintain a software issue tracker card. Given the issue, its git state, and the agents working in its ' +
    'worktree, return ONLY a JSON object: {"activityNotes": string (1-4 sentence markdown summary of progress ' +
    'across all agents), "suggestedStage": one of ' + JSON.stringify(ISSUE_STAGES) + ' or null (only when a move ' +
    'is clearly warranted), "suggestedReason": short string, "blockedBy": array of other issue branch names this ' +
    'likely depends on, "dependencyNote": short advisory or "". Do not wrap in prose.'
  const user = JSON.stringify(ctx, null, 2)
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}
