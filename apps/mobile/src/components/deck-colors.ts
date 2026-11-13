import { adaptiveColor } from '../theme/platform-colors'

/** Desktop's live selection and fuchsia proposal signals, adapted for readable text. */
export const deckColor = {
  live: '#6f9dff',
  liveFill: 'rgba(111,157,255,0.13)',
  liveRing: 'rgba(111,157,255,0.65)',
  proposal: '#d946ef',
  proposalText: adaptiveColor('#a21caf', '#eaa3f5', '#86198f', '#f0b9f8'),
  proposalFill: 'rgba(217,70,239,0.05)',
  proposalRing: 'rgba(217,70,239,0.3)',
} as const
