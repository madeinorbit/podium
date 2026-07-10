import { ISSUE_STAGES, type IssueStage } from '@podium/protocol'

const STAGES = new Set<string>(ISSUE_STAGES)

/** A drop target's stage, or null if the value isn't a real stage. */
export function dropTargetStage(raw: string): IssueStage | null {
  return STAGES.has(raw) ? (raw as IssueStage) : null
}
