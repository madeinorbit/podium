import type { TranscriptItem } from '@podium/model/browser'
import { AlignLeft, FileText, Mail, Terminal } from 'lucide-react'

/** Activity keeps its kind when it settles; only failures change its ink. */
export function WorkGlyph({
  item,
  stretch = false,
  mail = false,
}: {
  item?: TranscriptItem
  stretch?: boolean
  mail?: boolean
}) {
  const Glyph = stretch
    ? AlignLeft
    : mail || item?.role === 'user'
      ? Mail
      : item?.toolName === 'Bash'
        ? Terminal
        : FileText
  return <Glyph size={15} strokeWidth={1.5} aria-hidden="true" />
}
