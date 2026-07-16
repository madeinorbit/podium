import { issueDisplayRef, type IssueWire } from '@podium/protocol'

const KNOWN_COMMANDS = new Set(['help', 'issues', 'stop', 'new'])
const ISSUES_LIST_CAP = 15

export interface SlashCommand {
  command: string
  args: string[]
}

/** Parse a Telegram slash command. Returns null for plain text or unknown `/foo`. */
export function parseSlashCommand(text: string): SlashCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const m = /^\/([a-zA-Z0-9_]+)(?:@\S*)?(?:\s+(.*))?$/s.exec(trimmed)
  if (!m) return null
  const command = m[1]!.toLowerCase()
  if (!KNOWN_COMMANDS.has(command)) return null
  const rest = m[2]?.trim()
  const args = rest ? rest.split(/\s+/).map((a) => a.toLowerCase()) : []
  return { command, args }
}

function boardVisible(issue: IssueWire): boolean {
  return !issue.draft && !issue.archived && !issue.deletedAt && issue.audience !== 'agent'
}

function isOpen(issue: IssueWire): boolean {
  return issue.stage !== 'done' && !issue.closedReason
}

function formatIssueLine(issue: IssueWire): string {
  const ref = issueDisplayRef(issue)
  const stage = issue.stage.replace(/_/g, ' ')
  return `• ${ref} ${issue.title} (${stage})`
}

/** Active board issues: open, human-facing, grouped by stage priority. */
export function formatActiveIssues(issues: IssueWire[]): string {
  const open = issues.filter((i) => boardVisible(i) && isOpen(i))
  const stageRank: Record<string, number> = {
    in_progress: 0,
    review: 1,
    planning: 2,
    backlog: 3,
    done: 4,
  }
  open.sort((a, b) => {
    const sa = stageRank[a.stage] ?? 9
    const sb = stageRank[b.stage] ?? 9
    if (sa !== sb) return sa - sb
    return b.updatedAt.localeCompare(a.updatedAt)
  })
  const lines = open.slice(0, ISSUES_LIST_CAP).map(formatIssueLine)
  if (lines.length === 0) return 'No active issues.'
  const more = open.length > ISSUES_LIST_CAP ? `\n…and ${open.length - ISSUES_LIST_CAP} more` : ''
  return `Active issues:\n${lines.join('\n')}${more}`
}

/** Recently updated board issues (any stage). */
export function formatRecentIssues(issues: IssueWire[]): string {
  const recent = issues
    .filter(boardVisible)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, ISSUES_LIST_CAP)
  const lines = recent.map(formatIssueLine)
  if (lines.length === 0) return 'No recent issues.'
  return `Recent issues:\n${lines.join('\n')}`
}

/** Ready-to-start issues (unblocked, not deferred). */
export function formatReadyIssues(issues: IssueWire[]): string {
  const ready = issues
    .filter((i) => boardVisible(i) && isOpen(i) && i.ready)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, ISSUES_LIST_CAP)
  const lines = ready.map(formatIssueLine)
  if (lines.length === 0) return 'No ready issues.'
  return `Ready issues:\n${lines.join('\n')}`
}

export function formatIssues(issues: IssueWire[], mode: string | undefined): string {
  switch (mode) {
    case 'recent':
      return formatRecentIssues(issues)
    case 'ready':
      return formatReadyIssues(issues)
    case 'active':
    case undefined:
      return formatActiveIssues(issues)
    default:
      return 'Usage: /issues [active|recent|ready]'
  }
}

export const TELEGRAM_COMMANDS = [
  { command: 'help', description: 'List available commands' },
  { command: 'issues', description: 'Active or recent issues' },
  { command: 'stop', description: 'Interrupt the running turn' },
  { command: 'new', description: 'Restart the superagent thread' },
] as const

/** Register the bot command menu via Telegram setMyCommands. */
export async function registerTelegramCommands(botToken: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken.trim()}/setMyCommands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commands: TELEGRAM_COMMANDS }),
  })
  const parsed = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string }
  if (res.ok && parsed.ok === true) return
  const description =
    typeof parsed.description === 'string' ? parsed.description : `HTTP ${res.status}`
  throw new Error(description)
}

export const HELP_TEXT = `Podium Telegram commands:
/help — this message
/issues [active|recent|ready] — issue list (default: active)
/stop — interrupt the running superagent turn
/new — restart the superagent harness (fresh session on next message)

Anything else is sent to the superagent.`