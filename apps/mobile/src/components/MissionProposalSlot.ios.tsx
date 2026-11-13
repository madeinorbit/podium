import { Spacer, VStack } from '@expo/ui/swift-ui'
import {
  accessibilityIdentifier,
  frame,
  listRowBackground,
  listRowInsets,
  listRowSeparatorTint,
  onAppear,
  onDisappear,
  onGeometryChange,
} from '@expo/ui/swift-ui/modifiers'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { useRowPrime } from '../lib/use-row-prime'
import { deckColor } from './deck-colors'
import type { MissionProposalSlotProps } from './mission-proposal-slot.types'

/** The shared native row window bounds rich swipe/menu trees while cells keep their measured heights. */
export const MissionProposalSlot = observer(function MissionProposalSlot({
  id,
  window,
  prime,
  children,
}: MissionProposalSlotProps) {
  const active = window.has(id)
  const [primed, unprime] = useRowPrime(prime)
  const [owner] = useState(() => ({}))
  useEffect(() => () => window.disappear(id, owner), [window, id, owner])
  const [height, setHeight] = useState(44)
  const shown = active || primed
  return (
    <VStack
      spacing={0}
      modifiers={[
        frame({ maxWidth: Infinity, alignment: 'leading' }),
        onAppear(() => window.appear(id, owner)),
        onDisappear(() => {
          unprime()
          window.disappear(id, owner)
        }),
        onGeometryChange((geometry) => {
          if (shown && geometry.height > 0) setHeight(geometry.height)
        }),
        listRowBackground(deckColor.proposalFill),
        listRowSeparatorTint(deckColor.proposalRing),
        listRowInsets({ leading: 12, trailing: 12, top: 0, bottom: 0 }),
        accessibilityIdentifier(`deck-proposal-slot-${id}`),
      ]}
    >
      {shown ? children : <Spacer modifiers={[frame({ height })]} />}
    </VStack>
  )
})
