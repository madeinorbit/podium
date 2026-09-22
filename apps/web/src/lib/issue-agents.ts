import {
  BUNDLED_DESCRIPTORS,
  parseServedDescriptors,
  resolveDescriptors,
} from '@podium/harness/browser'
import type { HarnessDescriptorWire } from '@podium/protocol'
import type { AgentKind } from '@podium/model/browser'
import { createElement, type ReactNode } from 'react'
import { agentIconFor } from './agent-tone'
import type { PropertyOption } from './PropertyMenu'

export type IssueAgentKind = Exclude<AgentKind, 'shell'>

// `agentIconFor`'s component type takes open props; this file only ever
// passes size, class and aria-hidden (see `issueAgentIcon`).
type IconComponent = (props: Record<string, unknown>) => ReactNode

/**
 * The harnesses THIS BUILD knows, derived from the bundled descriptors —
 * never a second hand-written list (POD-4475). Order follows the registry.
 * The TYPE stays closed (`IssueAgentKind`) for signatures; the RUNTIME list
 * for pickers comes from resolved descriptors (served over bundled), so a
 * newer harness appears without a client change.
 */
export const ISSUE_AGENT_KINDS: readonly IssueAgentKind[] = BUNDLED_DESCRIPTORS.map(
  (d) => d.kind as IssueAgentKind,
)

/**
 * Resolve the descriptor list a picker renders: served over bundled, so an
 * older client shows a newer harness inside the schema it already has.
 * Pass the machine's served `descriptors` frame field when held; otherwise
 * the bundled copy (no machine connected) applies.
 */
export function issueAgentDescriptors(
  served: readonly HarnessDescriptorWire[] | undefined,
): HarnessDescriptorWire[] {
  return resolveDescriptors(parseServedDescriptors(served ?? []))
}

function descriptorFor(
  value: string | null | undefined,
  descriptors: readonly HarnessDescriptorWire[] | undefined,
): HarnessDescriptorWire | undefined {
  if (!value) return undefined
  return issueAgentDescriptors(descriptors).find((d) => d.kind === value)
}

export function issueAgentIcon(
  value: string | null | undefined,
  size = 14,
  descriptors?: readonly HarnessDescriptorWire[],
): ReactNode {
  // One icon table (in agent-tone): bundled components for harnesses this
  // build knows, served icon DATA for newer ones, null when neither exists.
  const Icon = agentIconFor(
    issueAgentKind(value) ?? value ?? issueDefaultAgentKind(undefined),
    descriptors,
  ) as IconComponent | undefined
  if (!Icon) return null
  return createElement(Icon, {
    size,
    'aria-hidden': true,
    className: 'text-muted-foreground',
  })
}

export function issueAgentKind(value: string | null | undefined): IssueAgentKind | null {
  return ISSUE_AGENT_KINDS.find((kind) => kind === value) ?? null
}

/**
 * The default harness: the registry's first row. Index, not a literal, so
 * the default follows the same derivation as every other row here.
 */
export function issueDefaultAgentKind(value: string | null | undefined): IssueAgentKind {
  return issueAgentKind(value) ?? ISSUE_AGENT_KINDS[0]!
}

export function issueAgentLabel(
  value: string | null | undefined,
  descriptors?: readonly HarnessDescriptorWire[],
): string {
  const found = descriptorFor(value, descriptors)
  // Unknown harnesses render their wire id rather than borrowing another
  // CLI's name; null/undefined renders the default row.
  if (found) return found.label
  if (value) return value
  return descriptorFor(issueDefaultAgentKind(undefined), descriptors)?.label ?? value ?? ''
}

export function issueAgentDefaultLabel(
  value: string | null | undefined,
  descriptors?: readonly HarnessDescriptorWire[],
): string {
  return `${issueAgentLabel(value, descriptors)} (default)`
}

export function issueAgentOptions(
  defaultAgent: string | null | undefined,
  descriptors?: readonly HarnessDescriptorWire[],
): PropertyOption[] {
  const defaultKind = issueDefaultAgentKind(defaultAgent)
  const resolved = issueAgentDescriptors(descriptors)
  const byKind = new Map(resolved.map((d) => [d.kind, d]))
  const kinds = [...byKind.keys()].filter((kind) => kind !== 'shell')
  const labelOf = (kind: string): string => byKind.get(kind)?.label ?? kind
  return [
    {
      value: '',
      label: `${labelOf(defaultKind)} (default)`,
      icon: issueAgentIcon(defaultAgent, 14, descriptors),
    },
    ...kinds
      .filter((kind) => kind !== defaultKind)
      .map((kind) => ({
        value: kind,
        label: labelOf(kind),
        icon: issueAgentIcon(kind, 14, descriptors),
      })),
  ]
}

export const ISSUE_AGENT_OPTIONS: PropertyOption[] = issueAgentOptions(undefined)
