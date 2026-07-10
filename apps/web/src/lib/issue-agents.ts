import type { AgentKind } from '@podium/protocol'
import { createElement, type ReactNode } from 'react'
import {
  ClaudeCodeIcon,
  CursorIcon,
  GrokIcon,
  OpenAIcon,
  OpenCodeIcon,
} from '@/lib/icons/AgentIcons'
import type { PropertyOption } from './PropertyMenu'

export type IssueAgentKind = Exclude<AgentKind, 'shell'>

type IconComponent = (props: Record<string, unknown>) => ReactNode

export const ISSUE_AGENT_KINDS = [
  'claude-code',
  'codex',
  'grok',
  'opencode',
  'cursor',
] as const satisfies readonly IssueAgentKind[]

const ISSUE_AGENT_LABELS: Record<IssueAgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  opencode: 'OpenCode',
  cursor: 'Cursor',
}

const ISSUE_AGENT_ICONS: Record<IssueAgentKind, IconComponent> = {
  'claude-code': ClaudeCodeIcon,
  codex: OpenAIcon,
  grok: GrokIcon,
  opencode: OpenCodeIcon,
  cursor: CursorIcon,
}

export function issueAgentKind(value: string | null | undefined): IssueAgentKind | null {
  return ISSUE_AGENT_KINDS.find((kind) => kind === value) ?? null
}

export function issueDefaultAgentKind(value: string | null | undefined): IssueAgentKind {
  return issueAgentKind(value) ?? 'claude-code'
}

export function issueAgentLabel(value: string | null | undefined): string {
  return ISSUE_AGENT_LABELS[issueDefaultAgentKind(value)]
}

export function issueAgentDefaultLabel(value: string | null | undefined): string {
  return `${issueAgentLabel(value)} (default)`
}

export function issueAgentIcon(value: string | null | undefined, size = 14): ReactNode {
  const kind = issueDefaultAgentKind(value)
  const Icon = ISSUE_AGENT_ICONS[kind]
  return createElement(Icon, {
    size,
    'aria-hidden': true,
    className: 'text-muted-foreground',
  })
}

export function issueAgentOptions(defaultAgent: string | null | undefined): PropertyOption[] {
  const defaultKind = issueDefaultAgentKind(defaultAgent)
  return [
    { value: '', label: issueAgentDefaultLabel(defaultAgent), icon: issueAgentIcon(defaultAgent) },
    ...ISSUE_AGENT_KINDS.filter((kind) => kind !== defaultKind).map((kind) => ({
      value: kind,
      label: issueAgentLabel(kind),
      icon: issueAgentIcon(kind),
    })),
  ]
}

export const ISSUE_AGENT_OPTIONS: PropertyOption[] = issueAgentOptions('claude-code')
