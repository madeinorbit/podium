import type { useVoiceInput } from '@podium/terminal-client-react'
import { Mic } from 'lucide-react'
import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * VOICE INPUT (POD-405) — the mic affordance, and nothing else.
 *
 * Renders nothing at all where the browser has no speech recognition, so the
 * composer never shows a control that cannot work. Dictated text is appended to
 * the draft through the SAME action seam typing uses (see ChatComposer): voice
 * is an input method, not a second write path.
 */
export function VoiceButton({
  voice,
}: {
  voice: ReturnType<typeof useVoiceInput>
}): JSX.Element | null {
  if (!voice.supported) return null
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        // The action cluster's own idiom, shared with the composer's other two
        // squares so one box does not wear three hover treatments.
        'size-6 rounded-md text-text-dim hover:bg-chip hover:text-text-strong',
        "[&_svg:not([class*='size-'])]:size-3.5",
        // Listening HOLDS STILL. The pulse was perpetual motion that depicts no
        // agent computing (DESIGN.md §5), and destructive red is reserved for
        // alerts — a mic that is merely on is neither. Live blue on the chip
        // ground says "on" without asking for anything.
        voice.listening && 'bg-chip text-live hover:text-live',
      )}
      title={voice.listening ? 'Stop voice input' : 'Voice input'}
      onClick={voice.toggle}
    >
      <Mic size={16} aria-hidden="true" />
    </Button>
  )
}
