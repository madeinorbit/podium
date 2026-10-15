import {
  issueAgentKind,
  issueDefaultAgentKind,
  issueAgentOptions as harnessOptions,
} from '@podium/client-core/agent-models'
import type { HarnessDescriptorWire } from '@podium/protocol'
import { createElement, type ReactNode } from 'react'
import { agentIconFor } from './agent-tone'
import type { PropertyOption } from './PropertyMenu'

export {
  ISSUE_AGENT_KINDS,
  issueAgentDescriptors,
  issueAgentKind,
  issueAgentLabel,
  issueDefaultAgentKind,
  type IssueAgentKind,
} from '@podium/client-core/agent-models'
import { issueAgentLabel } from '@podium/client-core/agent-models'

type IconComponent = (props: Record<string, unknown>) => ReactNode

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


export function issueAgentDefaultLabel(
  value: string | null | undefined,
  descriptors?: readonly HarnessDescriptorWire[],
  codingHarness?: string | null,
): string {
  return `${issueAgentLabel(issueDefaultAgentKind(value, codingHarness), descriptors)} (default)`
}

/** Web presentation adapter: shared options plus the harness icons. */
export function issueAgentOptions(
  defaultAgent: string | null | undefined,
  descriptors?: readonly HarnessDescriptorWire[],
  codingHarness?: string | null,
): PropertyOption[] {
  const defaultKind = issueDefaultAgentKind(defaultAgent, codingHarness)
  return harnessOptions(defaultKind, descriptors).map((option) => ({
    ...option,
    icon: issueAgentIcon(option.value || defaultKind, 14, descriptors),
  }))
}

export const ISSUE_AGENT_OPTIONS: PropertyOption[] = issueAgentOptions(undefined)
