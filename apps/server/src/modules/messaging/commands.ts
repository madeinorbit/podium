import { issueDisplayRef, type IssueWire, type SessionMeta } from '@podium/protocol'
import type { InlineButton } from './types'

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

const LIVE_STATUSES = new Set(['live', 'starting', 'reconnecting'])

/** Telegram `callback_data` for an issue open button (≤64 bytes). */
export function issueCallbackData(issueId: string): string {
  return `i:${issueId}`
}

/** Parse `issueCallbackData` — returns the issue id or undefined. */
export function parseIssueCallbackData(data: string): string | undefined {
  const m = /^i:(iss_[a-zA-Z0-9_-]+)$/.exec(data)
  return m?.[1]
}

function listedIssues(issues: IssueWire[], mode: string | undefined): IssueWire[] {
  switch (mode) {
    case 'recent':
      return issues
        .filter(boardVisible)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, ISSUES_LIST_CAP)
    case 'ready':
      return issues
        .filter((i) => boardVisible(i) && isOpen(i) && i.ready)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, ISSUES_LIST_CAP)
    case 'active':
    case undefined: {
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
      return open.slice(0, ISSUES_LIST_CAP)
    }
    default:
      return []
  }
}

function issueButtonLabel(issue: IssueWire): string {
  const ref = issueDisplayRef(issue)
  const title = issue.title.length > 24 ? `${issue.title.slice(0, 23)}…` : issue.title
  return `${ref} ${title}`
}

/** Active/recent/ready issue list with one inline open button per row. */
export function buildIssuesMessage(
  issues: IssueWire[],
  mode: string | undefined,
): { text: string; buttons: InlineButton[][] } | { text: string; buttons?: undefined } {
  if (mode && mode !== 'active' && mode !== 'recent' && mode !== 'ready') {
    return { text: 'Usage: /issues [active|recent|ready]' }
  }
  const rows = listedIssues(issues, mode)
  const text = formatIssues(issues, mode)
  if (rows.length === 0) return { text }
  const buttons = rows.map((issue) => [
    { label: issueButtonLabel(issue), data: issueCallbackData(issue.id) },
  ])
  return { text, buttons }
}

/** Pick the agent session whose btw thread should back an issue topic. */
export function pickIssueSession(issue: IssueWire): SessionMeta | undefined {
  const sessions = issue.sessions.filter((s) => !s.archived && !s.headless)
  if (sessions.length === 0) return undefined
  const live = sessions.filter((s) => LIVE_STATUSES.has(s.status))
  const pool = live.length > 0 ? live : sessions
  return [...pool].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0]
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
/issues [active|recent|ready] — issue list with open buttons (default: active)
/stop — interrupt the running superagent turn
/new — restart the superagent harness (fresh session on next message)

Tap an issue button to open it in a forum topic wired to that issue's agent
(btw thread when a session is live, else the repo concierge).
Anything else is sent to the superagent (main chat → global; topic → bound thread).`