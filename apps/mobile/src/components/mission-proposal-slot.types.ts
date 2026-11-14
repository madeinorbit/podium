import type { RowWindow } from '@podium/client-graph/row-window'
import type { ReactNode } from 'react'

export interface MissionProposalSlotProps {
  id: string
  window: RowWindow<string>
  prime: boolean
  /** The card's first row draws no separator above itself. */
  first?: boolean
  children: ReactNode
}
