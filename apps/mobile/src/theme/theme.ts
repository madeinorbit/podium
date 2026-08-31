import { Platform } from 'react-native'
import { fontFaces } from './font-family'
import { adaptiveColor, semanticColor } from './platform-colors'

export { adaptiveColor } from './platform-colors'

export const appearancePalette = {
  light: {
    bg: '#ffffff',
    sunken: '#f2f2f7',
    surface: '#ffffff',
    raised: '#f2f2f7',
    text: '#000000',
    body: '#1c1c1e',
    dim: '#3c3c43',
  },
  dark: {
    bg: '#16171a',
    sunken: '#191a1e',
    surface: '#23262d',
    raised: '#252830',
    text: '#f2f3f5',
    body: '#d7dae0',
    dim: '#a8adb6',
  },
} as const

/**
 * Podium's status and identity colors remain explicit while UIKit owns the
 * structural chassis. The web/Android fallback stays on the established Dark
 * Ink ramp, so this native migration does not repaint unsupported renderers.
 *
 * Bisque is the primary action and attention signal, blue means active work,
 * red is destructive, and terracotta identifies Claude. Issue accents remain
 * distinct from those reserved signals and are derived in issueColors.ts.
 */
export const color = {
  // UIKit owns the structural chassis and resolves appearance and contrast.
  bg: semanticColor('systemBackground', appearancePalette.dark.bg),
  bgGradientTop: semanticColor('systemBackground', appearancePalette.dark.bg),
  bgSunken: semanticColor('secondarySystemBackground', appearancePalette.dark.sunken),
  /** The work list and the conversation field — a flat surface that steps
   *  AWAY from the work. The name outlived the groove. */
  engraved: semanticColor('secondarySystemBackground', appearancePalette.dark.sunken),
  /** Compact section bars, key-bar strip — lifted just above the ground. */
  bar: semanticColor('secondarySystemBackground', '#1b1d21'),
  /** Agent-roster band tier. */
  rail: semanticColor('tertiarySystemBackground', '#1e2024'),
  // Legacy alias used by older components; same as surface.
  bgRaised: semanticColor('secondarySystemBackground', appearancePalette.dark.surface),

  // Surfaces
  surface: semanticColor('secondarySystemBackground', appearancePalette.dark.surface),
  surfaceHigh: semanticColor('tertiarySystemBackground', appearancePalette.dark.raised),
  surfacePressed: semanticColor('systemFill', '#2c3038'),
  /** Raised chips ("New Claude in podium"), neutral ID-square fill. */
  elevated: semanticColor('tertiarySystemBackground', appearancePalette.dark.raised),
  glass: semanticColor('secondarySystemBackground', 'rgba(27, 29, 33, 0.78)'),
  // Legacy aliases
  card: semanticColor('secondarySystemBackground', appearancePalette.dark.surface),
  cardPressed: semanticColor('systemFill', '#2c3038'),

  // Seam / hairline tiers — row rules → panel/bar seams → chip rims
  border: semanticColor('separator', '#26292f'),
  borderStrong: semanticColor('opaqueSeparator', '#3a3f48'),
  hairline: semanticColor('separator', '#24272d'),
  /** Hairlines on the #1b1d21 bars. */
  hairlineBar: semanticColor('separator', '#26292f'),
  fill: semanticColor('systemFill', 'rgba(120, 120, 128, 0.36)'),
  secondaryFill: semanticColor('secondarySystemFill', 'rgba(120, 120, 128, 0.32)'),
  tertiaryFill: semanticColor('tertiarySystemFill', 'rgba(118, 118, 128, 0.24)'),
  quaternaryFill: semanticColor('quaternarySystemFill', 'rgba(116, 116, 128, 0.18)'),
  clear: 'transparent',

  // Ink — six steps, the web's whole ramp. By LIGHTNESS (contrast vs `bg`):
  // text 16.5 · body 13.1 · textDim 8.1 · label 6.5 · textFaint 5.3 ·
  // textMicro 3.9. The bottom two land LIGHTER than the navy theme's did:
  // metadata has to hold above 5:1 on a ground that is itself lighter now.
  text: semanticColor('label', appearancePalette.dark.text),
  body: semanticColor('label', appearancePalette.dark.body),
  textDim: semanticColor('secondaryLabel', appearancePalette.dark.dim),
  textFaint: semanticColor('tertiaryLabel', '#848a94'),
  /** Micro labels, hints. */
  textMicro: semanticColor('tertiaryLabel', '#6f7580'),
  /** Mono section labels (project names). */
  label: semanticColor('secondaryLabel', '#949aa4'),

  // Accent = bisque. One signal everywhere (The Signal Rule).
  accent: '#d9b477',
  accentSoft: 'rgba(217, 180, 119, 0.13)',
  accentBorder: 'rgba(217, 180, 119, 0.45)',
  /** The fill's own lightness ±5 points, hue and chroma held — the same throw
   *  the yellow gradient had, so a filled button keeps its modelling. */
  accentGradient: ['#dfc08c', '#d3a861'] as const,
  /** Ink on the accent is always Dark Ink — never white. */
  onAccent: '#16171a',
  /** Every accent `color:` — tinted labels, the lit ⏎ key, attention text.
   *  Same value as {@link accent} since the swap (rule 3), kept under its own
   *  name because the call sites mean different things by it. */
  accentTint: adaptiveColor('#765114', '#d9b477'),
  // Legacy alias
  accentText: '#16171a',

  // Attention semantics — reserved hues, never issue colours
  needsYou: '#d9b477',
  needsYouSoft: 'rgba(217, 180, 119, 0.12)',
  needsYouBorder: 'rgba(217, 180, 119, 0.4)',
  needsYouBg: 'rgba(217, 180, 119, 0.12)',
  /** "Waiting on you" as a `color:` — the write of {@link accentTint}, kept
   *  under its own name so the SIGNAL stays legible at the call site.
   *  `needsYou` above remains the fill (dots, spines, bars). */
  needsYouText: adaptiveColor('#765114', '#d9b477'),
  /** What is MOVING — spinners, live rings, meters. Superade has no green. */
  working: '#6f9dff',
  workingText: adaptiveColor('#0057b8', '#6f9dff'),
  workingSoft: 'rgba(111, 157, 255, 0.13)',
  workingBg: 'rgba(111, 157, 255, 0.13)',
  /** Host/health dots, quota bars, done ✓ — the settled blue behind the
   *  moving one; blue is the calm "all good". */
  success: '#2a62f0',
  successText: adaptiveColor('#1d4ed8', '#6f9dff'),
  idle: '#949aa4',
  idleSoft: 'rgba(148, 154, 164, 0.12)',
  idleBg: 'rgba(148, 154, 164, 0.12)',
  danger: '#e5303f',
  dangerText: adaptiveColor('#b42318', '#ff6673'),
  dangerSoft: 'rgba(229, 48, 63, 0.12)',
  dangerBg: 'rgba(229, 48, 63, 0.12)',
  /** User / YOU rail blue. */
  info: '#2a62f0',
  /** Claude brand terracotta. */
  claude: '#d97757',
  claudeText: adaptiveColor('#9f3e23', '#e58d70'),
  /** Neutral no-colour issue flow — a TRUE grey, not slate: a blue-grey
   *  default tint over neutral ink reads as an issue colour nobody chose. */
  flow: '#949aa4',

  // Chat
  userBubbleGradient: ['#2452c9', '#1c41a4'] as const,
  userBubble: '#1f47b0',
  assistantBubble: semanticColor('secondarySystemBackground', '#23262d'),
  toolText: semanticColor('tertiaryLabel', '#6f7580'),
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
 * Geist / Geist Mono, with regular and semibold static faces embedded on native
 * and loaded by the web launch root. Medium and bold requests intentionally use
 * semibold so the app keeps its emphasis hierarchy without shipping near-identical
 * extra files. Use these instead of fontWeight — mixing a weight-specific family
 * with fontWeight makes Android synthesize fake bolds.
 */
export const sans = (weight: 400 | 500 | 600 | 700 = 400) =>
  Platform.select({
    ios: {
      fontFamily: undefined,
      fontWeight: String(weight) as '400' | '500' | '600' | '700',
    },
    default: {
      fontFamily: {
        400: fontFaces.sansRegular,
        500: fontFaces.sansSemiBold,
        600: fontFaces.sansSemiBold,
        700: fontFaces.sansSemiBold,
      }[weight],
    },
  })!

export const mono = (weight: 400 | 500 | 600 | 700 = 400) =>
  ({
    fontFamily: {
      400: fontFaces.monoRegular,
      500: fontFaces.monoSemiBold,
      600: fontFaces.monoSemiBold,
      700: fontFaces.monoSemiBold,
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
  needsYou: {
    fg: color.needsYouText,
    bg: color.needsYouSoft,
    border: color.needsYouBorder,
  },
  working: {
    fg: color.workingText,
    bg: color.workingSoft,
    border: 'rgba(111, 157, 255, 0.35)',
  },
  idle: {
    fg: color.idle,
    bg: color.idleSoft,
    border: 'rgba(148, 154, 164, 0.3)',
  },
  danger: {
    fg: color.dangerText,
    bg: color.dangerSoft,
    border: 'rgba(229, 48, 63, 0.4)',
  },
  accent: {
    fg: color.accentTint,
    bg: color.accentSoft,
    border: color.accentBorder,
  },
}

/** Depth: shadow + hairline border together (either alone reads flat). */
export const elevation = {
  card: Platform.select({
    web: {
      boxShadow: '0 2px 12px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.45)',
    },
    default: {
      shadowColor: '#000',
      shadowOpacity: 0.4,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 3 },
      elevation: 5,
    },
  }) as object,
  raised: Platform.select({
    web: {
      boxShadow: '0 8px 24px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.45)',
    },
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
