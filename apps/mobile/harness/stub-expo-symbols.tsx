import {
  ArrowUp,
  ChevronLeft,
  Circle,
  ClipboardPaste,
  Cpu,
  Gauge,
  Mic,
  MicOff,
  Paperclip,
  Square,
  type LucideIcon,
} from 'lucide-react'

const GLYPHS: Record<string, LucideIcon> = {
  arrow_upward: ArrowUp,
  attach_file: Paperclip,
  chevron_left: ChevronLeft,
  content_paste: ClipboardPaste,
  memory: Cpu,
  mic: Mic,
  mic_off: MicOff,
  speed: Gauge,
  stop: Square,
}

/**
 * The plain Vite harness has no Expo module runtime. Keep its few captured
 * controls legible with the matching Lucide web glyph.
 */
export function SymbolView({
  name,
  size = 24,
  tintColor = 'currentColor',
}: {
  name: string | { web?: string }
  size?: number
  tintColor?: string
}) {
  const webName = typeof name === 'string' ? name : name.web
  const Glyph = (webName && GLYPHS[webName]) || Circle
  return <Glyph aria-hidden size={size} color={tintColor} />
}
