import { Platform } from 'react-native'

/**
 * Podium mobile design language — Superade. [POD-131, mirrors apps/web/DESIGN.md]
 *
 * Token values mirror the web's Superade theme: deep race-navy chassis with
 * darker engraved tiers below it, a three-tier seam/hairline system, a
 * six-step ink ramp, and STRICT status semantics — Superade Yellow #f5c518
 * means "waiting on you" and marks the primary action (The Signal Rule),
 * Accent Blue #2f6bff is calm liveness (working spinner/timer, success,
 * info — Superade has no green), Alert Red #e5303f is destructive/alerts
 * only, terracotta #d97757 is Claude. Issue accents come from the 10-colour
 * palette in ./issueColors.ts and are always tinted via ./mix.ts, never flat.
 */
export const color = {
  // Canvas tiers (darker = deeper)
  bg: '#0a0f1c',
  bgGradientTop: '#0a0f1c',
  bgSunken: '#070b16',
  /** Engraved column surface (the Tray queue). */
  engraved: '#070b16',
  /** Compact section bars, key-bar strip — the darkest tier. */
  bar: '#050912',
  /** Agent-roster band tier (POD-100 rail-navy). */
  rail: '#0e1626',
  // Legacy alias used by older components; same as surface.
  bgRaised: '#121b30',

  // Surfaces
  surface: '#121b30',
  surfaceHigh: '#16223c',
  surfacePressed: '#1c2a4a',
  /** Raised chips ("New Claude in podium"), neutral ID-square fill. */
  elevated: '#16223c',
  glass: 'rgba(5, 9, 18, 0.78)',
  // Legacy aliases
  card: '#121b30',
  cardPressed: '#1c2a4a',

  // Seam / hairline tiers
  border: '#243356',
  borderStrong: '#364a78',
  hairline: '#1e2a4c',
  /** Hairlines on the darkest #050912 bars. */
  hairlineBar: '#283a66',

  // Ink — six-step ramp
  text: '#f3f3f8',
  body: '#d7d7e0',
  textDim: '#9a9aa8',
  textFaint: '#6c7690',
  /** Micro labels, hints. */
  textMicro: '#525c78',
  /** Mono section labels (project names). */
  label: '#7a84a0',

  // Accent = Superade Yellow. One signal everywhere (The Signal Rule).
  accent: '#f5c518',
  accentSoft: 'rgba(245, 197, 24, 0.13)',
  accentBorder: 'rgba(245, 197, 24, 0.45)',
  accentGradient: ['#f7d031', '#e3b40e'] as const,
  /** Ink on yellow is always Race Navy — never white. */
  onAccent: '#0a0f1c',
  /** Yellow-tinted text (the lit ⏎ key, tinted labels). */
  accentTint: '#ecd679',
  // Legacy alias
  accentText: '#0a0f1c',

  // Attention semantics — reserved hues, never issue colours
  needsYou: '#f5c518',
  needsYouSoft: 'rgba(245, 197, 24, 0.12)',
  needsYouBorder: 'rgba(245, 197, 24, 0.4)',
  needsYouBg: 'rgba(245, 197, 24, 0.12)',
  /** Calm liveness — Superade has no green; blue is "agent working". */
  working: '#2f6bff',
  workingSoft: 'rgba(47, 107, 255, 0.13)',
  workingBg: 'rgba(47, 107, 255, 0.13)',
  /** Host/health dots, quota bars, done ✓ — blue is the calm "all good". */
  success: '#2f6bff',
  idle: '#7a84a0',
  idleSoft: 'rgba(122, 132, 160, 0.12)',
  idleBg: 'rgba(122, 132, 160, 0.12)',
  danger: '#e5303f',
  dangerSoft: 'rgba(229, 48, 63, 0.12)',
  dangerBg: 'rgba(229, 48, 63, 0.12)',
  /** User / YOU rail blue. */
  info: '#2f6bff',
  /** Claude brand terracotta. */
  claude: '#d97757',
  /** Neutral no-colour issue flow. */
  flow: '#94a3b8',

  // Chat
  userBubbleGradient: ['#2450b8', '#1d4ed8'] as const,
  userBubble: '#1d47a8',
  assistantBubble: '#121b30',
  toolText: '#525c78',
} as const

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const

/** Discrete redesign radii — the workhorse row/square radius is 7. */
export const radius = {
  xs: 5,
  sm: 6,
  md: 7,
  lg: 10,
  xl: 14,
  full: 999,
} as const

export const font = {
  largeTitle: 24,
  title: 18,
  heading: 15,
  body: 13,
  small: 12,
  tiny: 10,
  micro: 9,
} as const

/**
 * Geist / Geist Mono, one static family per weight (loaded in app/_layout).
 * Use these instead of fontWeight — mixing a weight-specific family with
 * fontWeight makes Android synthesize fake bolds.
 */
export const sans = (weight: 400 | 500 | 600 | 700 = 400) =>
  ({
    fontFamily: {
      400: 'Geist_400Regular',
      500: 'Geist_500Medium',
      600: 'Geist_600SemiBold',
      700: 'Geist_700Bold',
    }[weight],
  }) as const

export const mono = (weight: 400 | 500 | 600 | 700 = 400) =>
  ({
    fontFamily: {
      400: 'GeistMono_400Regular',
      500: 'GeistMono_500Medium',
      600: 'GeistMono_600SemiBold',
      700: 'GeistMono_700Bold',
    }[weight],
  }) as const

/** Mono micro-label style (project/scope labels): tracking ≈ .12em. */
export const monoLabel = (size = 10) =>
  ({
    ...mono(500),
    fontSize: size,
    letterSpacing: size * 0.12,
    textTransform: 'uppercase',
  }) as const

export type AttentionTone = 'needsYou' | 'working' | 'idle' | 'danger' | 'accent'

export const tone: Record<AttentionTone, { fg: string; bg: string; border: string }> = {
  needsYou: { fg: color.needsYou, bg: color.needsYouSoft, border: color.needsYouBorder },
  working: { fg: color.working, bg: color.workingSoft, border: 'rgba(47, 107, 255, 0.35)' },
  idle: { fg: color.idle, bg: color.idleSoft, border: 'rgba(122, 132, 160, 0.3)' },
  danger: { fg: color.danger, bg: color.dangerSoft, border: 'rgba(229, 48, 63, 0.4)' },
  accent: { fg: color.accent, bg: color.accentSoft, border: color.accentBorder },
}

/** Depth: shadow + hairline border together (either alone reads flat). */
export const elevation = {
  card: Platform.select({
    web: { boxShadow: '0 2px 12px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.45)' },
    default: {
      shadowColor: '#000',
      shadowOpacity: 0.4,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 3 },
      elevation: 5,
    },
  }) as object,
  raised: Platform.select({
    web: { boxShadow: '0 8px 24px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.45)' },
    default: {
      shadowColor: '#000',
      shadowOpacity: 0.55,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 8 },
      elevation: 12,
    },
  }) as object,
  glow: (glowColor: string) =>
    Platform.select({
      web: { boxShadow: `0 0 24px ${glowColor}, 0 2px 16px rgba(0,0,0,0.4)` },
      default: {
        shadowColor: glowColor,
        shadowOpacity: 0.5,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 2 },
        elevation: 8,
      },
    }) as object,
} as const
