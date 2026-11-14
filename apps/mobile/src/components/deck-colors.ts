import type { SessionWord, TaskWord } from '@podium/model/browser'
import { adaptiveColor } from '../theme/platform-colors'
import { color } from '../theme/theme'

/** Desktop index.css state tokens on native grouped paper, including increased contrast. */
export const deckColor = {
  live: adaptiveColor('#2a62f0', '#6f9dff', '#1d4ed8', '#99b9ff'),
  liveFill: adaptiveColor(
    'rgba(42,98,240,0.10)',
    'rgba(111,157,255,0.13)',
    'rgba(42,98,240,0.16)',
    'rgba(111,157,255,0.20)',
  ),
  liveRing: adaptiveColor('rgba(42,98,240,0.65)', 'rgba(111,157,255,0.65)', '#1d4ed8', '#99b9ff'),
  working: color.workingText,
  needsYou: color.needsYouText,
  blocked: color.textDim,
  error: color.dangerText,
  done: color.successText,
  idle: color.textDim,
  notStarted: color.textFaint,
  proposal: adaptiveColor('#a21caf', '#d946ef', '#86198f', '#f0b9f8'),
  proposalText: adaptiveColor('#a21caf', '#eaa3f5', '#86198f', '#f0b9f8'),
  proposalFill: adaptiveColor(
    '#ffffff',
    'rgba(217,70,239,0.05)',
    '#ffffff',
    'rgba(217,70,239,0.09)',
  ),
  proposalRing: adaptiveColor(
    'rgba(162,28,175,0.3)',
    'rgba(217,70,239,0.3)',
    'rgba(162,28,175,0.5)',
    'rgba(217,70,239,0.5)',
  ),
  /** UISegmentedControl's selected thumb on its tertiary-fill track. */
  segmentThumb: adaptiveColor('#ffffff', '#636366', '#ffffff', '#7c7c80'),
  // Desktop's disjoint execution buckets. Attention counts never change these segments.
  gaugeDone: adaptiveColor('#1d4ed8', '#2a62f0', '#173ead', '#99b9ff'),
  gaugeWorking: adaptiveColor(
    'rgba(42,98,240,0.55)',
    'rgba(111,157,255,0.55)',
    '#2a62f0',
    '#6f9dff',
  ),
  gaugeWaiting: adaptiveColor(
    'rgba(0,0,0,0.24)',
    'rgba(242,243,245,0.24)',
    'rgba(0,0,0,0.44)',
    'rgba(242,243,245,0.44)',
  ),
  gaugeTodo: adaptiveColor(
    'rgba(0,0,0,0.09)',
    'rgba(242,243,245,0.09)',
    'rgba(0,0,0,0.18)',
    'rgba(242,243,245,0.18)',
  ),
} as const

export function deckWordColor(word: TaskWord | SessionWord): string {
  switch (word) {
    case 'working':
      return deckColor.working
    case 'needs-you':
      return deckColor.needsYou
    case 'blocked':
      return deckColor.blocked
    case 'error':
      return deckColor.error
    case 'done':
      return deckColor.done
    case 'idle':
      return deckColor.idle
    case 'not-started':
      return deckColor.notStarted
  }
}
