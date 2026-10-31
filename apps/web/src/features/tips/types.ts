import type { ReactNode } from 'react'

export type TipId =
  | 'first-prompt'
  | 'first-send'
  | 'ask-anything'
  | 'team-forms'
  | 'first-proposal'
  | 'first-offer'
  | 'first-artifact'
export const TIP_IDS: readonly TipId[] = [
  'first-prompt',
  'first-send',
  'ask-anything',
  'team-forms',
  'first-proposal',
  'first-offer',
  'first-artifact',
]
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
  onShow?(): void
  onHide?(): void
}
export interface TipMoment {
  active: boolean
  cards: readonly TipCard[]
}
