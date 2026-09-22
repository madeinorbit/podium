import {
  parseServedDescriptors,
  resolveDescriptors,
} from '@podium/harness/browser'
import type { HarnessDescriptorWire } from '@podium/protocol'
import type { AgentKind } from '@podium/model/browser'
import { SquareTerminal } from 'lucide-react'
import { createElement, type ComponentType } from 'react'
import {
  ClaudeCodeIcon,
  CursorIcon,
  GrokIcon,
  OpenAIcon,
  OpenCodeIcon,
  PiIcon,
} from '@/lib/icons/AgentIcons'

/**
 * Per-harness brand tone (POD-293, descriptor-driven since POD-4475).
 *
 * Every value here used to be an inline `kind === 'claude-code' ? … : …`
 * spread across view files, then TOTAL RESOLVERS over kind-keyed tables
 * (POD-1105). The tables are now DERIVED from the bundled descriptors:
 * brand hex drives class selection by VALUE, so no harness literal remains
 * and an older client still renders a newer harness (neutrally) inside the
 * schema it already has. Pass a machine's served descriptors when held for
 * newer-harness names; the classes only ever match brands this build knows.
 *
 * Keep the class strings verbatim per brand — these are the concept's
 * pixels, so a "simplification" that collapses two rows changes the design.
 */

/** The tone an unrecognised harness gets: the old non-Claude branch, verbatim. */
const GLYPH_TONE_FALLBACK = 'text-foreground'
const CHIP_TINT_FALLBACK = 'border-border-strong bg-chip text-foreground'
const FLEET_TILE_TINT_FALLBACK = 'border-border-strong bg-chip text-foreground'
/** A parked (hibernated) agent's tile — `KindIcon`'s `dimmed` pair, verbatim. */
const FLEET_TILE_TINT_PARKED = 'border-hairline-bar bg-muted text-muted-foreground/70'
/** Official Grok light mark in both themes: black swirl on a white field.
 *  The dark invert was too loud on Dark Ink. The glyph is `currentColor`. */
const GROK_TILE_TINT = 'border-zinc-950/15 bg-white text-zinc-950'

/**
 * Brand key → classes, by VALUE. Keys are chip-ground hexes from the
 * descriptors (not harness names): the map cannot name a harness it has
 * never heard of, and a newer brand simply misses and falls back.
 */
const CHIP_TINT_BY_BG: Record<string, string> = {
  '#d97757': 'border-claude bg-claude text-white',
  '#ffffff': GROK_TILE_TINT,
}

const GLYPH_TONE_BY_BG: Record<string, string> = {
  '#d97757': 'text-claude',
}

const FLEET_TILE_TINT_BY_BG: Record<string, string> = {
  '#d97757': 'border-claude bg-claude text-white',
  '#ffffff': GROK_TILE_TINT,
}

const BRAND_TEXT_BY_BG: Record<string, string> = {
  '#d97757': 'text-claude',
}

const BRAND_DOT_BY_BG: Record<string, string> = {
  '#d97757': 'bg-claude',
}

/**
 * The wire's harness id as this module accepts it: a known kind, or any string a
 * newer peer might send. Widened on purpose — see the header.
 *
 * Local and unexported by design. POD-397 owns the real `HarnessId` (open,
 * branded) in @podium/protocol; this alias exists only so these five signatures
 * read clearly, and POD-398 can swap it for the real type without touching call
 * sites. It is NOT a second vocabulary.
 */
type WireHarnessKind = AgentKind | (string & {})

function resolvedDescriptors(
  served: readonly HarnessDescriptorWire[] | undefined,
): HarnessDescriptorWire[] {
  return resolveDescriptors(parseServedDescriptors(served ?? []))
}

function brandBgFor(
  kind: WireHarnessKind,
  served: readonly HarnessDescriptorWire[] | undefined,
): string | undefined {
  return resolvedDescriptors(served).find((d) => d.kind === kind)?.brand?.bg
}

/** Glyph colour for an agent-kind icon at rest. Total. */
export function agentGlyphTone(kind: WireHarnessKind, served?: readonly HarnessDescriptorWire[]): string {
  const bg = brandBgFor(kind, served)
  return (bg && GLYPH_TONE_BY_BG[bg]) ?? GLYPH_TONE_FALLBACK
}

/** 20px chip behind the glyph (work-list agent rows): Claude wears its clay,
 *  Grok the light mark, other harnesses a quiet navy — solid fills so a chip
 *  never ghosts through a neighbour. Total. */
export function agentChipTint(kind: WireHarnessKind, served?: readonly HarnessDescriptorWire[]): string {
  const bg = brandBgFor(kind, served)
  return (bg && CHIP_TINT_BY_BG[bg]) ?? CHIP_TINT_FALLBACK
}

/** Stacked fleet-summary tile (sidebar issue rows) — carries its own text tone,
 *  which is why it is not the chip resolver above. Total.
 *
 *  `parked` (POD-756) is the ghost state: the harness is on the task but its
 *  process was stopped to free memory. It drops the brand and takes the muted
 *  fill for EVERY kind — deliberately not a sixth per-kind table, because the
 *  fact being drawn is "this one is asleep", not "this one is Claude". Same two
 *  classes `KindIcon`'s `dimmed` already uses, so a parked agent looks parked
 *  wherever it is drawn. The fill stays SOLID: stacked tiles overlap, and an
 *  opacity ghost would let the neighbour show through it. */
export function agentFleetTileTint(
  kind: WireHarnessKind,
  parked = false,
  served?: readonly HarnessDescriptorWire[],
): string {
  if (parked) return FLEET_TILE_TINT_PARKED
  const bg = brandBgFor(kind, served)
  return (bg && FLEET_TILE_TINT_BY_BG[bg]) ?? FLEET_TILE_TINT_FALLBACK
}

/**
 * Brand text tone APPENDED to an existing class list, or null for a harness that
 * inherits the surrounding tone.
 *
 * Deliberately not {@link agentGlyphTone}: these call sites used to append
 * nothing at all for non-Claude kinds, so returning `text-foreground` here would
 * override an inherited colour and change pixels.
 */
export function agentBrandText(
  kind: WireHarnessKind,
  served?: readonly HarnessDescriptorWire[],
): string | null {
  const bg = brandBgFor(kind, served)
  return (bg && BRAND_TEXT_BY_BG[bg]) ?? null
}

/** Brand dot shown beside the model token, or null for a harness with no brand
 *  mark of its own (the dot is omitted entirely, as before). */
export function agentBrandDot(
  kind: WireHarnessKind,
  served?: readonly HarnessDescriptorWire[],
): string | null {
  const bg = brandBgFor(kind, served)
  return (bg && BRAND_DOT_BY_BG[bg]) ?? null
}

/** An agent-kind icon.
 *
 *  Props stay open (`Record<string, unknown>`) because the table mixes two
 *  families — the hand-drawn brand marks in `lib/icons/AgentIcons` and a lucide
 *  glyph for the shell — whose prop types are compatible in practice and
 *  incompatible to the checker (lucide returns `ReactNode`, the marks return
 *  `Element`; one takes `aria-hidden: boolean`, JSX passes `"true"`). This is
 *  the alias `NewPanelMenu` already used for the same list before POD-591 moved
 *  it here, kept rather than tightened: narrowing buys no safety at call sites
 *  that only ever pass size, class and aria-hidden. */
export type AgentIconComponent = ComponentType<Record<string, unknown>>

/**
 * Bundled brand components for harnesses this build knows (bundled CODE,
 * per the POD-4475 amendment). One quoted key: only `claude-code` needs
 * quotes. A newer harness renders from its served icon DATA instead (see
 * {@link agentIconFor}); nothing here invents a mark for one.
 */
const BUNDLED_ICONS: Record<string, AgentIconComponent> = {
  'claude-code': ClaudeCodeIcon,
  codex: OpenAIcon,
  grok: GrokIcon,
  opencode: OpenCodeIcon,
  cursor: CursorIcon,
  pi: PiIcon,
  shell: SquareTerminal,
}

/** Data-rendered components for served-only icons, cached by icon id: a new
 *  component identity per call would remount the svg on every render. */
const DATA_ICON_CACHE = new Map<string, AgentIconComponent>()

function dataIconFor(descriptor: HarnessDescriptorWire): AgentIconComponent | undefined {
  const { viewBox, d } = descriptor.icon
  if (!viewBox || !d) return undefined
  const cached = DATA_ICON_CACHE.get(descriptor.icon.id)
  if (cached) return cached
  const DataIcon = ((props: Record<string, unknown>) => {
    const { size, width, height, ...rest } = props as {
      size?: number
      width?: number
      height?: number
      [key: string]: unknown
    }
    const dimension = width ?? height ?? size ?? 24
    return createElement(
      'svg',
      {
        xmlns: 'http://www.w3.org/2000/svg',
        viewBox,
        width: width ?? dimension,
        height: height ?? dimension,
        fill: 'currentColor',
        fillRule: 'evenodd',
        ...rest,
      },
      createElement('path', { d, clipRule: 'evenodd' }),
    )
  }) as AgentIconComponent
  DATA_ICON_CACHE.set(descriptor.icon.id, DataIcon)
  return DataIcon
}

/**
 * Harness mark: the bundled component for harnesses this build knows, the
 * served icon DATA for newer ones, `undefined` when neither exists (callers
 * already render a neutral glyph in that case, and inventing a mark for a
 * harness we know nothing about would claim a brand).
 */
export function agentIconFor(
  kind: WireHarnessKind,
  served?: readonly HarnessDescriptorWire[],
): AgentIconComponent | undefined {
  const bundled = BUNDLED_ICONS[kind]
  if (bundled) return bundled
  const descriptor = resolvedDescriptors(served).find((d) => d.kind === kind)
  if (descriptor && descriptor.kind !== 'shell') return dataIconFor(descriptor)
  return undefined
}

