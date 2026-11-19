/** Native symbol names rendered with matching browser glyphs in this layout harness. */
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronUp,
  Circle,
  Ellipsis,
  ListFilter,
  type LucideIcon,
  Plus,
  X,
} from 'lucide-react'

const glyphs: Record<string, LucideIcon> = {
  arrow_downward: ArrowDown,
  check: Check,
  expand_more: ChevronDown,
  chevron_left: ChevronLeft,
  expand_less: ChevronUp,
  unfold_less: ChevronsDownUp,
  unfold_more: ChevronsUpDown,
  more_horiz: Ellipsis,
  filter_list: ListFilter,
  add: Plus,
  close: X,
}

export function SymbolView({
  name,
  size = 24,
  tintColor = 'currentColor',
}: {
  name: string | { web?: string }
  size?: number
  tintColor?: string
}) {
  const Glyph = glyphs[(typeof name === 'string' ? name : name.web) ?? ''] ?? Circle
  return <Glyph aria-hidden size={size} color={tintColor} />
}
