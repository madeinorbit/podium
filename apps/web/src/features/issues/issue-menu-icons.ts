/**
 * ONE map from the shared menu tree's icon NAMES to marks (POD-745).
 *
 * `issue-menu-config.ts` keeps icons as data — "each surface owns its icon
 * renderer" — which was right when the context menu was the only surface. The
 * command palette is the second, and a second hand-written switch is how the
 * two surfaces drift into naming the same action with different marks. The
 * config still holds names; this file is the single place they resolve.
 */

import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  Bot,
  Check,
  Copy,
  ExternalLink,
  type LucideIcon,
  Mail,
  MailOpen,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Play,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import type { IssueMenuIcon } from './issue-menu-config'

export const ISSUE_MENU_ICON: Record<IssueMenuIcon, LucideIcon> = {
  'alarm-clock': AlarmClock,
  'alarm-clock-off': AlarmClockOff,
  archive: Archive,
  'archive-restore': ArchiveRestore,
  'arrow-right-left': ArrowRightLeft,
  agent: Bot,
  check: Check,
  copy: Copy,
  'external-link': ExternalLink,
  mail: Mail,
  'mail-open': MailOpen,
  palette: Palette,
  pencil: Pencil,
  pin: Pin,
  'pin-off': PinOff,
  play: Play,
  tag: Tag,
  trash: Trash2,
  x: X,
}

export function issueMenuIcon(icon: IssueMenuIcon): LucideIcon {
  return ISSUE_MENU_ICON[icon]
}
