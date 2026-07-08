import { Platform } from 'react-native'

/**
 * Podium mobile design language ("Podium Dark").
 *
 * Principles: one deep neutral canvas with layered, softly-lit surfaces;
 * a single violet-blue accent used sparingly; semantic attention colors that
 * match the product's triage language (amber = needs you, green = working);
 * large friendly radii; real depth (shadow + hairline border together).
 */
export const color = {
  // Canvas
  bg: '#0a0b0f',
  bgGradientTop: '#101321',
  bgSunken: '#07080b',
  // Legacy alias used by older components; same as surface.
  bgRaised: '#14161d',

  // Surfaces (each step ~4% lighter)
  surface: '#14161d',
  surfaceHigh: '#1a1d26',
  surfacePressed: '#20242f',
  glass: 'rgba(20, 22, 29, 0.72)',
  // Legacy aliases
  card: '#14161d',
  cardPressed: '#20242f',

  border: 'rgba(148, 163, 197, 0.14)',
  borderStrong: 'rgba(148, 163, 197, 0.28)',
  hairline: 'rgba(148, 163, 197, 0.09)',

  // Ink
  text: '#f4f6fb',
  textDim: '#a3adc2',
  textFaint: '#636d84',

  // Accent — violet-blue, with a gradient pair for primary actions
  accent: '#8b9dff',
  accentSoft: 'rgba(139, 157, 255, 0.14)',
  accentBorder: 'rgba(139, 157, 255, 0.45)',
  accentGradient: ['#8b9dff', '#6f7dff'] as const,
  onAccent: '#0a0b0f',
  // Legacy alias
  accentText: '#0a0b0f',

  // Attention semantics
  needsYou: '#ffb454',
  needsYouSoft: 'rgba(255, 180, 84, 0.12)',
  needsYouBorder: 'rgba(255, 180, 84, 0.4)',
  needsYouBg: 'rgba(255, 180, 84, 0.12)',
  working: '#3ddc97',
  workingSoft: 'rgba(61, 220, 151, 0.11)',
  workingBg: 'rgba(61, 220, 151, 0.11)',
  idle: '#8a94ab',
  idleSoft: 'rgba(138, 148, 171, 0.12)',
  idleBg: 'rgba(138, 148, 171, 0.12)',
  danger: '#ff7a85',
  dangerSoft: 'rgba(255, 122, 133, 0.12)',
  dangerBg: 'rgba(255, 122, 133, 0.12)',

  // Chat
  userBubbleGradient: ['#3a4a80', '#2c3862'] as const,
  userBubble: '#32406e',
  assistantBubble: '#171a22',
  toolText: '#6c7690',
} as const

/** Claude's /color identity palette → display hex (SessionMeta.agentColor). */
export const AGENT_COLORS: Record<string, string> = {
  red: '#ff8f8f',
  blue: '#7cb5ff',
  green: '#5fd6a0',
  yellow: '#ffd166',
  purple: '#c9a0ff',
  orange: '#ffab70',
  pink: '#ff9bc8',
  cyan: '#6fdbe8',
}

export function agentColorHex(name: string | undefined): string | null {
  if (!name || name === 'default') return null
  return AGENT_COLORS[name] ?? null
}

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const

export const radius = {
  sm: 12,
  md: 16,
  lg: 22,
  xl: 28,
  full: 999,
} as const

export const font = {
  largeTitle: 32,
  title: 20,
  heading: 17,
  body: 15,
  small: 13,
  tiny: 11,
} as const

export type AttentionTone = 'needsYou' | 'working' | 'idle' | 'danger' | 'accent'

export const tone: Record<AttentionTone, { fg: string; bg: string; border: string }> = {
  needsYou: { fg: color.needsYou, bg: color.needsYouSoft, border: color.needsYouBorder },
  working: { fg: color.working, bg: color.workingSoft, border: 'rgba(61, 220, 151, 0.35)' },
  idle: { fg: color.idle, bg: color.idleSoft, border: 'rgba(138, 148, 171, 0.3)' },
  danger: { fg: color.danger, bg: color.dangerSoft, border: 'rgba(255, 122, 133, 0.4)' },
  accent: { fg: color.accent, bg: color.accentSoft, border: color.accentBorder },
}

/** Depth: shadow + hairline border together (either alone reads flat). */
export const elevation = {
  card: Platform.select({
    web: { boxShadow: '0 2px 16px rgba(0,0,0,0.35), 0 1px 2px rgba(0,0,0,0.4)' },
    default: {
      shadowColor: '#000',
      shadowOpacity: 0.35,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
  }) as object,
  raised: Platform.select({
    web: { boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 2px 6px rgba(0,0,0,0.45)' },
    default: {
      shadowColor: '#000',
      shadowOpacity: 0.5,
      shadowRadius: 20,
      shadowOffset: { width: 0, height: 8 },
      elevation: 12,
    },
  }) as object,
  glow: (glowColor: string) =>
    Platform.select({
      web: { boxShadow: `0 0 24px ${glowColor}, 0 2px 16px rgba(0,0,0,0.4)` },
      default: {
        shadowColor: glowColor,
        shadowOpacity: 0.55,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 2 },
        elevation: 8,
      },
    }) as object,
} as const
