import type { IssueStage } from '@podium/protocol'
import { ListTodo } from 'lucide-react'
import type { JSX } from 'react'
import { StageGlyph } from './issue-glyphs'

/**
 * The unified sidebar's leading icon for a real issue row: a NEUTRAL base task
 * glyph (muted, so a row's colour comes from its status dot rather than a
 * distracting stage hue) with the {@link StageGlyph} shrunk into the bottom-right
 * corner as a small badge — the stage is still legible, just demoted. Draft
 * agent-only rows keep their agent icon instead.
 */
export function IssueStatusIcon({
  stage,
  size = 16,
  badge = true,
}: {
  stage: IssueStage
  size?: number
  /** Corner stage badge — off in the sidebar work list, where rows stay plain. */
  badge?: boolean
}): JSX.Element {
  return (
    <span
      className="relative flex flex-none items-center justify-center"
      style={{ width: size, height: size }}
    >
      <ListTodo size={size} className="text-[#8a8a97]" aria-hidden="true" />
      {/* Corner badge: a small stage glyph on a background chip so it reads as a
          badge over the base glyph rather than blending into it. */}
      {badge && (
        <span className="absolute -right-1 -bottom-1 flex items-center justify-center rounded-full bg-background">
          <StageGlyph stage={stage} size={8} />
        </span>
      )}
    </span>
  )
}
