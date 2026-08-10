import { discoveredPlacement, type ProposalShape } from '@podium/client-core/viewmodels'
import { ISSUE_COLOR_SLOTS, ISSUE_STAGES, type IssueStage } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import type { IssueViewModel } from '@/app/store'
import {
  ISSUE_AGENT_KINDS,
  issueAgentDefaultLabel,
  issueAgentLabel,
  issueDefaultAgentKind,
} from '@/lib/issue-agents'
import { STAGE_LABELS } from './issue-card'
import type { IssueMenuSurface, issueMenuEligibility } from './issue-context-menu'
import { isIssueStartable } from './issue-startable'

export type IssueMenuEligibility = ReturnType<typeof issueMenuEligibility>

/** Names stay data-only here; each surface owns its icon renderer. */
export type IssueMenuIcon =
  | 'alarm-clock'
  | 'alarm-clock-off'
  | 'archive'
  | 'archive-restore'
  | 'arrow-right-left'
  | 'agent'
  | 'check'
  | 'copy'
  | 'external-link'
  | 'mail'
  | 'mail-open'
  | 'palette'
  | 'pencil'
  | 'pin'
  | 'pin-off'
  | 'play'
  | 'tag'
  | 'trash'
  | 'x'

export type IssueMenuAction =
  | 'open'
  | 'rename'
  | 'markUnread'
  | 'markRead'
  | 'closeDone'
  | 'closeWontfix'
  | 'pin'
  | 'archive'
  | 'restore'
  | 'delete'
  | 'placeOnOwn'
  | 'placeInMission'

export type IssueMenuSubmenu =
  | 'stage'
  | 'priority'
  | 'agent'
  | 'labels'
  | 'color'
  | 'handoff'
  | 'defer'
  | 'duplicate'

/** The `color` submenu's value for "clear the colour" — slots are their own
 *  names, and the wire patch carries `null`. */
export const ISSUE_MENU_COLOR_NONE = 'none'

export type IssueMenuSection = 'main' | 'lifecycle' | 'destructive'

export interface IssueMenuOption {
  id: string
  label: string
  value?: string
  icon?: IssueMenuIcon
  checked?: boolean
  disabled?: boolean
  hint?: string
  empty?: boolean
}

export interface IssueMenuTarget {
  id: string
  ref: string
  title: string
}

export interface IssueHandoffMenuData {
  sessionId?: string
  /** A blocker is rendered as a disabled first-level item by the menu host. */
  blocker?: string
  options: readonly IssueMenuOption[]
}

export interface IssueMenuData {
  first: IssueViewModel
  issues: readonly IssueViewModel[]
  allIssues: readonly IssueViewModel[]
  eligibility: IssueMenuEligibility
  surface: IssueMenuSurface
  renameEnabled: boolean
  handoffEnabled: boolean
  labels: readonly string[]
  duplicateTargets: readonly IssueMenuTarget[]
  handoff?: IssueHandoffMenuData
}

export interface IssueMenuActionConfig {
  kind: 'action'
  id: IssueMenuAction
  label: string | ((data: IssueMenuData) => string)
  icon: IssueMenuIcon
  section: IssueMenuSection
  when: (data: IssueMenuData) => boolean
}

export interface IssueMenuSubmenuConfig {
  kind: 'submenu'
  id: IssueMenuSubmenu
  label: string | ((data: IssueMenuData) => string)
  icon: IssueMenuIcon
  section: IssueMenuSection
  when: (data: IssueMenuData) => boolean
  options: (data: IssueMenuData) => readonly IssueMenuOption[]
}

export type IssueMenuConfig = IssueMenuActionConfig | IssueMenuSubmenuConfig

const has =
  (key: keyof IssueMenuEligibility) =>
  (data: IssueMenuData): boolean =>
    data.eligibility[key]

/** Where the menu's single subject currently lives, when it is discovered work
 *  with an origin. Null for a multi-select: placement is one issue's decision. */
export function menuPlacement(data: IssueMenuData): ProposalShape | null {
  if (data.issues.length !== 1) return null
  const byId = new Map(data.allIssues.map((issue) => [issue.id as string, issue]))
  return discoveredPlacement(data.first, byId)
}

/** One ordered tree. Context menus and palette commands both project this list. */
export const ISSUE_MENU_CONFIG: readonly IssueMenuConfig[] = [
  {
    kind: 'action',
    id: 'open',
    label: 'Open',
    icon: 'external-link',
    section: 'main',
    when: has('canOpen'),
  },
  {
    kind: 'action',
    id: 'rename',
    label: 'Rename',
    icon: 'pencil',
    section: 'main',
    when: (data) => data.renameEnabled && data.eligibility.canRename,
  },
  {
    kind: 'action',
    id: 'markUnread',
    label: 'Mark as unread',
    icon: 'mail',
    section: 'main',
    when: has('canMarkUnread'),
  },
  {
    kind: 'action',
    id: 'markRead',
    label: 'Mark as read',
    icon: 'mail-open',
    section: 'main',
    when: has('canMarkRead'),
  },
  {
    kind: 'submenu',
    id: 'stage',
    label: 'Set stage',
    icon: 'check',
    section: 'main',
    when: has('canSetStage'),
    options: () =>
      ISSUE_STAGES.map((stage) => ({ id: stage, value: stage, label: STAGE_LABELS[stage] })),
  },
  {
    kind: 'submenu',
    id: 'priority',
    label: 'Set priority',
    icon: 'check',
    section: 'main',
    when: has('canSetPriority'),
    options: () =>
      [0, 1, 2, 3, 4].map((priority) => ({
        id: String(priority),
        value: String(priority),
        label: `P${priority}`,
      })),
  },
  {
    kind: 'submenu',
    id: 'agent',
    label: (data) => (isIssueStartable(data.first) ? 'Run now' : 'Assign agent'),
    icon: 'agent',
    section: 'main',
    when: has('canAssignAgent'),
    options: (data) => {
      const defaultKind = issueDefaultAgentKind(data.first.defaultAgent)
      return [
        { id: 'default', value: '', label: issueAgentDefaultLabel(data.first.defaultAgent) },
        ...ISSUE_AGENT_KINDS.filter((kind) => kind !== defaultKind).map((kind) => ({
          id: kind,
          value: kind,
          label: issueAgentLabel(kind),
        })),
      ]
    },
  },
  {
    kind: 'submenu',
    id: 'labels',
    label: 'Labels',
    icon: 'tag',
    section: 'main',
    when: has('canSetLabels'),
    options: (data) =>
      data.labels.length === 0
        ? [{ id: 'none', label: 'No labels', disabled: true, empty: true }]
        : data.labels.map((label) => ({
            id: label,
            value: label,
            label,
            checked: data.issues.every((issue) => issue.labels.includes(label)),
          })),
  },
  // The IdSquare picker keeps owning the fast path (click the square). This
  // entry is the discoverable one (POD-380): everything else you can do to a
  // task lives in the right-click menu, so colour has to be here too. The menu
  // host renders it as the picker's swatch grid; the palette gets these rows.
  {
    kind: 'submenu',
    id: 'color',
    label: 'Set colour',
    icon: 'palette',
    section: 'main',
    when: has('canSetColor'),
    options: (data) => [
      ...ISSUE_COLOR_SLOTS.map((slot) => ({
        id: slot,
        value: slot,
        label: slot.charAt(0).toUpperCase() + slot.slice(1),
        checked: data.issues.every((issue) => issue.color === slot),
      })),
      {
        id: ISSUE_MENU_COLOR_NONE,
        value: ISSUE_MENU_COLOR_NONE,
        label: 'No colour',
        checked: data.issues.every((issue) => !issue.color),
      },
    ],
  },
  {
    kind: 'submenu',
    id: 'handoff',
    label: 'Handoff',
    icon: 'arrow-right-left',
    section: 'main',
    when: (data) => data.handoffEnabled && data.handoff !== undefined,
    options: (data) => data.handoff?.options ?? [],
  },
  /**
   * THE PLACEMENT CORRECTION (POD-679).
   *
   * The start control asks where discovered work should live; this is where a
   * wrong answer is undone. It has to exist: departure keys on the
   * `discovered-from` EDGE, so reparenting alone would not bring a spin-off
   * back — the UI would be able to reach a state it could not leave.
   *
   * Exactly one of the two ever shows, because an issue is in one place.
   */
  {
    kind: 'action',
    id: 'placeOnOwn',
    label: (data) => `Move out of ${menuPlacement(data)?.originRef ?? 'this mission'}`,
    icon: 'arrow-right-left',
    section: 'lifecycle',
    when: (data) => menuPlacement(data)?.placement === 'mission',
  },
  {
    kind: 'action',
    id: 'placeInMission',
    label: (data) => `Move into ${menuPlacement(data)?.originRef ?? 'the task that found it'}`,
    icon: 'arrow-right-left',
    section: 'lifecycle',
    when: (data) => menuPlacement(data)?.placement === 'own',
  },
  {
    kind: 'action',
    id: 'closeDone',
    label: 'Close (done)',
    icon: 'check',
    section: 'lifecycle',
    when: has('canClose'),
  },
  {
    kind: 'action',
    id: 'closeWontfix',
    label: 'Close (wontfix)',
    icon: 'x',
    section: 'lifecycle',
    when: has('canClose'),
  },
  {
    kind: 'submenu',
    id: 'defer',
    label: 'Snooze / defer',
    icon: 'alarm-clock',
    section: 'lifecycle',
    when: (data) => data.eligibility.canDefer || data.eligibility.canUndefer,
    options: (data) => [
      { id: 'hour', value: 'hour', label: 'For 1 hour', icon: 'alarm-clock' },
      { id: 'tomorrow', value: 'tomorrow', label: 'Until tomorrow', icon: 'alarm-clock' },
      { id: 'week', value: 'week', label: 'For a week', icon: 'alarm-clock' },
      {
        id: 'next-message',
        value: 'next-message',
        label: 'Until next message',
        icon: 'alarm-clock',
      },
      ...(data.eligibility.canUndefer
        ? [{ id: 'undefer', value: 'undefer', label: 'Unsnooze', icon: 'alarm-clock-off' as const }]
        : []),
    ],
  },
  {
    kind: 'action',
    id: 'pin',
    label: (data) => (data.first.pinned ? 'Unpin' : 'Pin'),
    icon: 'pin',
    section: 'destructive',
    when: has('canPin'),
  },
  {
    kind: 'action',
    id: 'archive',
    label: (data) => (data.first.archived ? 'Unarchive' : 'Archive'),
    icon: 'archive',
    section: 'destructive',
    when: (data) => data.eligibility.canArchive || data.eligibility.canUnarchive,
  },
  {
    kind: 'submenu',
    id: 'duplicate',
    label: 'Duplicate of',
    icon: 'copy',
    section: 'destructive',
    when: has('canDuplicate'),
    options: (data) =>
      data.duplicateTargets.length === 0
        ? [{ id: 'none', label: 'No sibling issues', disabled: true, empty: true }]
        : data.duplicateTargets.map((target) => ({
            id: target.id,
            value: target.id,
            label: target.title,
            hint: target.ref,
          })),
  },
  {
    kind: 'action',
    id: 'restore',
    label: 'Restore',
    icon: 'archive-restore',
    section: 'destructive',
    when: has('canRestore'),
  },
  {
    kind: 'action',
    id: 'delete',
    label: 'Delete',
    icon: 'trash',
    section: 'destructive',
    when: has('canDelete'),
  },
]

/** Build the data passed to the shared tree; hosts only supply environment-specific handoff data. */
export function createIssueMenuData(input: {
  issues: readonly IssueViewModel[]
  allIssues: readonly IssueViewModel[]
  eligibility: IssueMenuEligibility
  surface?: IssueMenuSurface
  renameEnabled?: boolean
  handoffEnabled?: boolean
  handoff?: IssueHandoffMenuData
}): IssueMenuData | null {
  const first = input.issues[0]
  if (!first) return null
  const targetIds = new Set(input.issues.map((issue) => issue.id))
  return {
    first,
    issues: input.issues,
    allIssues: input.allIssues,
    eligibility: input.eligibility,
    surface: input.surface ?? 'board',
    renameEnabled: input.renameEnabled ?? false,
    handoffEnabled: input.handoffEnabled ?? false,
    labels: [
      ...new Set([
        ...input.allIssues.flatMap((issue) => issue.labels),
        ...input.issues.flatMap((issue) => issue.labels),
      ]),
    ].sort(),
    duplicateTargets: input.allIssues
      .filter(
        (issue) =>
          !issue.deletedAt && issue.repoPath === first.repoPath && !targetIds.has(issue.id),
      )
      .sort((a, b) => a.seq - b.seq)
      .map((issue) => ({ id: issue.id, ref: issueDisplayRef(issue), title: issue.title })),
    handoff: input.handoff,
  }
}

export function issueMenuEntries(data: IssueMenuData): IssueMenuConfig[] {
  return ISSUE_MENU_CONFIG.filter((entry) => entry.when(data))
}

export function issueMenuEntryLabel(entry: IssueMenuConfig, data: IssueMenuData): string {
  return typeof entry.label === 'function' ? entry.label(data) : entry.label
}

/** Palette and menu tests use this compact projection to prove they share IDs and options. */
export function issueMenuCommandKeys(data: IssueMenuData): string[] {
  return issueMenuEntries(data).flatMap((entry) => {
    if (entry.kind === 'action') return [entry.id]
    return entry
      .options(data)
      .filter((option) => !option.disabled && !option.empty && option.value !== undefined)
      .map((option) => `${entry.id}:${option.value}`)
  })
}

export function stageValue(value: string): IssueStage | null {
  return (ISSUE_STAGES as readonly string[]).includes(value) ? (value as IssueStage) : null
}
