import type { IssueStage, IssueWire } from '@podium/protocol'

export const STAGE_LABELS: Record<IssueStage, string> = {
  backlog: 'Backlog',
  planning: 'Planning',
  in_progress: 'In Progress',
  review: 'Review',
  verifying: 'Verifying',
  done: 'Done',
}

export function issueCardModel(issue: IssueWire): {
  title: string
  subtitle: string
  phaseBadges: { label: string; tone: string }[]
  hasSuggestion: boolean
} {
  const repo = issue.repoPath.split('/').filter(Boolean).pop() ?? issue.repoPath
  const count = issue.sessionSummary.total
  const subtitle = `#${issue.seq} · ${repo} · ${count} session${count === 1 ? '' : 's'}`
  const phaseBadges = Object.entries(issue.sessionSummary.byPhase).map(([phase, n]) => ({ label: `${n} ${phase}`, tone: phase }))
  return { title: issue.title, subtitle, phaseBadges, hasSuggestion: Boolean(issue.suggestedStage) }
}
