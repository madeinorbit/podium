/**
 * Design tokens for the mobile app. One dark theme, tuned for OLED and for
 * glanceability outdoors: high-contrast text, a single accent, and semantic
 * status colors that match the web app's attention language (amber = needs you,
 * green = working, slate = idle).
 */
export const color = {
  bg: '#0b0c0f',
  bgRaised: '#14161b',
  bgSunken: '#08090b',
  card: '#171a20',
  cardPressed: '#1e222a',
  border: '#262b35',
  borderStrong: '#343b48',

  text: '#f3f5f8',
  textDim: '#9aa3b2',
  textFaint: '#5f6877',

  accent: '#7aa2ff',
  accentText: '#0b0c0f',

  needsYou: '#f6b355',
  needsYouBg: '#2a2113',
  working: '#4fc38a',
  workingBg: '#12241b',
  idle: '#8b93a3',
  idleBg: '#191d24',
  danger: '#f26d6d',
  dangerBg: '#2a1516',

  userBubble: '#223052',
  assistantBubble: '#171a20',
  toolText: '#7d8694',
} as const

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  full: 999,
} as const

export const font = {
  title: 22,
  heading: 17,
  body: 15,
  small: 13,
  tiny: 11,
} as const

export type AttentionTone = 'needsYou' | 'working' | 'idle' | 'danger'

export const tone: Record<AttentionTone, { fg: string; bg: string }> = {
  needsYou: { fg: color.needsYou, bg: color.needsYouBg },
  working: { fg: color.working, bg: color.workingBg },
  idle: { fg: color.idle, bg: color.idleBg },
  danger: { fg: color.danger, bg: color.dangerBg },
}
