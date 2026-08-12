import { Platform } from 'react-native'

/**
 * Podium mobile design language — Superade "Dark Ink". [POD-784, mirrors
 * apps/web/DESIGN.md and the `[data-theme="superade"].dark` block of
 * apps/web/src/index.css]
 *
 * The chassis is NEUTRAL INK, not navy. It was a deep race navy (#0a0f1c
 * ground, #121b30 card) because the first Superade mock painted the chrome in
 * the brand's blue; POD-737 took the hue out of the web's neutrals and this
 * file follows it, value for value. Three rules carry over:
 *
 * 1. NEUTRAL, NOT NAVY. Every surface and every seam is a cool-neutral ink.
 *    A tinted ground competes with the issue-accent channel — the point of
 *    that channel is that a hue on a surface MEANS something, and navy chrome
 *    meant nothing while looking like it did.
 * 2. THE FRAME LIFTS. The tier order inverts the old navy ramp: `bg` #16171a
 *    is the darkest thing on screen and every surface steps UP from it, so the
 *    tab bar and section bars sit ABOVE the ground rather than below it.
 * 3. YELLOW FILLS, GOLD WRITES. `accent` #f5c518 is the fill (buttons, dots,
 *    spines, the active tab glyph); `accentTint` #e3ba52 does every yellow
 *    `color:`. Pure yellow as running text against neutral ink reads as a
 *    highlighter smear.
 *
 * Status semantics are unchanged and still strict: Superade Yellow means
 * "waiting on you" and marks the primary action (The Signal Rule); blue keeps
 * its two jobs — `working` #6f9dff is what is MOVING (spinners, live rings)
 * and `success`/`info` #2a62f0 the settled fill behind them, because Superade
 * has no green; Alert Red #e5303f is destructive/alerts only; terracotta
 * #d97757 is Claude. Issue accents come from the 10-colour palette in
 * ./issueColors.ts and are always tinted via ./mix.ts, never flat.
 */
export const color = {
  // Canvas tiers — the ground is the DARKEST; every surface steps up (rule 2)
  bg: '#16171a',
  bgGradientTop: '#16171a',
  bgSunken: '#191a1e',
  /** The work list and the conversation field — a flat surface that steps
   *  AWAY from the work. The name outlived the groove. */
  engraved: '#191a1e',
  /** Compact section bars, key-bar strip — lifted just above the ground. */
  bar: '#1b1d21',
  /** Agent-roster band tier. */
  rail: '#1e2024',
  // Legacy alias used by older components; same as surface.
  bgRaised: '#23262d',

  // Surfaces
  surface: '#23262d',
  surfaceHigh: '#252830',
  surfacePressed: '#2c3038',
  /** Raised chips ("New Claude in podium"), neutral ID-square fill. */
  elevated: '#252830',
  glass: 'rgba(27, 29, 33, 0.78)',
  // Legacy aliases
  card: '#23262d',
  cardPressed: '#2c3038',

  // Seam / hairline tiers — row rules → panel/bar seams → chip rims
  border: '#26292f',
  borderStrong: '#3a3f48',
  hairline: '#24272d',
  /** Hairlines on the #1b1d21 bars. */
  hairlineBar: '#26292f',

  // Ink — six steps, the web's whole ramp. By LIGHTNESS (contrast vs `bg`):
  // text 16.5 · body 13.1 · textDim 8.1 · label 6.5 · textFaint 5.3 ·
  // textMicro 3.9. The bottom two land LIGHTER than the navy theme's did:
  // metadata has to hold above 5:1 on a ground that is itself lighter now.
  text: '#f2f3f5',
  body: '#d7dae0',
  textDim: '#a8adb6',
  textFaint: '#848a94',
  /** Micro labels, hints. */
  textMicro: '#6f7580',
  /** Mono section labels (project names). */
  label: '#949aa4',

  // Accent = Superade Yellow. One signal everywhere (The Signal Rule).
  accent: '#f5c518',
  accentSoft: 'rgba(245, 197, 24, 0.13)',
  accentBorder: 'rgba(245, 197, 24, 0.45)',
  accentGradient: ['#f7d031', '#e3b40e'] as const,
  /** Ink on yellow is always Dark Ink — never white. */
  onAccent: '#16171a',
  /** Gold WRITES (rule 3): every yellow `color:` — tinted labels, the lit ⏎
   *  key, attention text. #f5c518 stays the fill. */
  accentTint: '#e3ba52',
  // Legacy alias
  accentText: '#16171a',

  // Attention semantics — reserved hues, never issue colours
  needsYou: '#f5c518',
  needsYouSoft: 'rgba(245, 197, 24, 0.12)',
  needsYouBorder: 'rgba(245, 197, 24, 0.4)',
  needsYouBg: 'rgba(245, 197, 24, 0.12)',
  /** "Waiting on you" as a `color:` — the gold write of {@link accentTint},
   *  kept under its own name so the SIGNAL stays legible at the call site.
   *  `needsYou` above remains the fill (dots, spines, bars). */
  needsYouText: '#e3ba52',
  /** What is MOVING — spinners, live rings, meters. Superade has no green. */
  working: '#6f9dff',
  workingSoft: 'rgba(111, 157, 255, 0.13)',
  workingBg: 'rgba(111, 157, 255, 0.13)',
  /** Host/health dots, quota bars, done ✓ — the settled blue behind the
   *  moving one; blue is the calm "all good". */
  success: '#2a62f0',
  idle: '#949aa4',
  idleSoft: 'rgba(148, 154, 164, 0.12)',
  idleBg: 'rgba(148, 154, 164, 0.12)',
  danger: '#e5303f',
  dangerSoft: 'rgba(229, 48, 63, 0.12)',
  dangerBg: 'rgba(229, 48, 63, 0.12)',
  /** User / YOU rail blue. */
  info: '#2a62f0',
  /** Claude brand terracotta. */
  claude: '#d97757',
  /** Neutral no-colour issue flow — a TRUE grey, not slate: a blue-grey
   *  default tint over neutral ink reads as an issue colour nobody chose. */
  flow: '#949aa4',

  // Chat
  userBubbleGradient: ['#2452c9', '#1c41a4'] as const,
  userBubble: '#1f47b0',
  assistantBubble: '#23262d',
  toolText: '#6f7580',
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
  /**
   * Floating bottom-edge surfaces (the composer capsule; the tab bar's own is
   * 28 for its taller capsule). Deliberately fixed rather than `full`: a pill
   * radius reads right on a one-line composer and turns a six-line one into a
   * stadium, because the clamp follows the height.
   */
  xxl: 24,
  full: 999,
} as const

/**
 * Type scale, re-based onto iPhone sizes [POD-366].
 *
 * The app used to top out at 13px body — iOS's *footnote* size — which is why
 * it read as a desktop tool shrunk onto a phone, and why the web export needed
 * `maximum-scale=1` to stop Safari auto-zooming every sub-16px input. Each step
 * now lands on an iOS system size: body 17, subhead 15, footnote 13, caption 11.
 *
 * Use the tokens. Arithmetic on them (`font.small - 0.5`) is what produced 34
 * distinct sizes across 178 call sites; if a step is missing, add one here.
 */
export const font = {
  largeTitle: 28,
  title: 22,
  heading: 20,
  /** Primary readable content — row titles, transcript prose, inputs. */
  body: 17,
  /** Secondary text — descriptions, chips, table cells. */
  small: 15,
  /** Metadata — timestamps, status lines, tool rows. */
  tiny: 13,
  /** Micro labels — mono section labels, counts, badges. */
  micro: 11,
} as const

const IOS_LEADING = {
  34: 41,
  28: 34,
  22: 28,
  20: 25,
  17: 22,
  16: 21,
  15: 20,
  13: 18,
  12: 16,
  11: 13,
} as const

/**
 * iOS Dynamic Type leading at the default Large size. Prose deliberately
 * deviates from the platform table: 1.45 (17 -> 25) reads better for multiline
 * agent output at this narrow measure than the system Body leading of 22.
 */
export const leading = (size: keyof typeof IOS_LEADING, density: 'prose' | 'ui' = 'ui') =>
  density === 'prose' ? Math.round(size * 1.45) : IOS_LEADING[size]

/**
 * SF's tracking curve, used as a starting point for Geist: tight at text sizes,
 * neutral around captions, and loose again above 24pt.
 */
export const tracking = {
  34: 0.4,
  28: 0.38,
  22: -0.26,
  20: -0.45,
  17: -0.43,
  16: -0.31,
  15: -0.23,
  13: -0.08,
  12: 0,
  11: 0.06,
} as const

/** React Native spring constants converted from SwiftUI's published presets. */
export const spring = {
  /** iOS system default — anything with no better answer. (response .55, zeta 1) */
  default: { stiffness: 130, damping: 23, mass: 1 },
  /** SwiftUI .smooth — no overshoot. Sheet/accessory settle. */
  smooth: { stiffness: 158, damping: 25, mass: 1 },
  /** SwiftUI .snappy — the detent snap. */
  snappy: { stiffness: 158, damping: 21.4, mass: 1 },
  /** SwiftUI .bouncy — reserve for intentionally playful motion. */
  bouncy: { stiffness: 158, damping: 17.6, mass: 1 },
  /** Press feedback — faster than an Apple preset and critically damped. */
  press: { stiffness: 322, damping: 36, mass: 1 },
} as const

/**
 * Geist / Geist Mono, with regular and semibold static faces loaded in
 * app/_layout (POD-143). Medium and bold requests intentionally use semibold
 * so the app keeps its emphasis hierarchy without shipping near-identical
 * extra files. Use these instead of fontWeight — mixing a weight-specific
 * family with fontWeight makes Android synthesize fake bolds.
 */
export const sans = (weight: 400 | 500 | 600 | 700 = 400) =>
  ({
    fontFamily: {
      400: 'Geist_400Regular',
      500: 'Geist_600SemiBold',
      600: 'Geist_600SemiBold',
      700: 'Geist_600SemiBold',
    }[weight],
  }) as const

export const mono = (weight: 400 | 500 | 600 | 700 = 400) =>
  ({
    fontFamily: {
      400: 'GeistMono_400Regular',
      500: 'GeistMono_600SemiBold',
      600: 'GeistMono_600SemiBold',
      700: 'GeistMono_600SemiBold',
    }[weight],
  }) as const

/** Mono micro-label style (project/scope labels): tracking ≈ .12em. */
export const monoLabel = (size: number = font.micro) =>
  ({
    ...mono(500),
    fontSize: size,
    letterSpacing: size * 0.12,
    textTransform: 'uppercase',
  }) as const

export type AttentionTone = 'needsYou' | 'working' | 'idle' | 'danger' | 'accent'

export const tone: Record<AttentionTone, { fg: string; bg: string; border: string }> = {
  needsYou: { fg: color.needsYou, bg: color.needsYouSoft, border: color.needsYouBorder },
  working: { fg: color.working, bg: color.workingSoft, border: 'rgba(111, 157, 255, 0.35)' },
  idle: { fg: color.idle, bg: color.idleSoft, border: 'rgba(148, 154, 164, 0.3)' },
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
