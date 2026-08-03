import { Mic } from 'lucide-react'
import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { useVoiceInput } from '@/lib/voice'

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
        'size-6 rounded-md text-muted-foreground hover:bg-transparent hover:text-foreground',
        "[&_svg:not([class*='size-'])]:size-3.5",
        voice.listening && 'animate-pulse text-destructive hover:text-destructive',
      )}
      title={voice.listening ? 'Stop voice input' : 'Voice input'}
      onClick={voice.toggle}
    >
      <Mic size={16} aria-hidden="true" />
    </Button>
  )
}
