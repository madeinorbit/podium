import type { ReactNode } from 'react'

export type FirstFlightId =
  | 'first-prompt'
  | 'first-send'
  | 'ask-anything'
  | 'team-forms'
  | 'first-proposal'
  | 'first-offer'
  | 'first-artifact'
/** A moment outside the First Flights tour: same engine and log, never in its count. */
export type TipId = FirstFlightId | 'github-star'
export const TIP_IDS: readonly FirstFlightId[] = [
  'first-prompt',
  'first-send',
  'ask-anything',
  'team-forms',
  'first-proposal',
  'first-offer',
  'first-artifact',
]
export const ALL_TIP_IDS: readonly TipId[] = [...TIP_IDS, 'github-star']
export type TipOutcome = 'shown' | 'finished' | 'dismissed' | 'skipped-all'
export interface TipLog {
  /** False until account state has loaded. The engine never shows a tip before ready. */
  readonly ready: boolean
  /** Tips switched on for this person. */
  readonly enabled: boolean
  isSeen(id: TipId): boolean
  /** Anything but 'shown' marks the moment seen. 'skipped-all' marks every moment seen and turns tips off. */
  record(id: TipId, outcome: TipOutcome): void
  setEnabled(on: boolean): void
}
export interface TipCard {
  anchor: string
  title: string
  body: string
  extra?: ReactNode
  cta?: { label: string; onClick(): void }
  /** A card outside First Flights: its own heading, and a plain way to decline
   *  in place of Skip tips, with no paper plane flying to the tour badge. */
  standalone?: { eyebrow: string; declineLabel: string }
  onShow?(): void
  onHide?(): void
}
export interface TipMoment {
  active: boolean
  cards: readonly TipCard[]
}
