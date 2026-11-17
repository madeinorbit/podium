import { Spacer, VStack } from '@expo/ui/swift-ui'
import {
  accessibilityIdentifier,
  frame,
  listRowInsets,
  onAppear,
  onDisappear,
  onGeometryChange,
} from '@expo/ui/swift-ui/modifiers'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { useRowPrime } from '../lib/use-row-prime'
import { listRowHairline } from './list-row-press.ios'
import type { MissionProposalSlotProps } from './mission-proposal-slot.types'

/** The shared native row window bounds rich swipe/menu trees while cells keep their measured heights. */
export const MissionProposalSlot = observer(function MissionProposalSlot({
  id,
  window,
  prime,
  first = false,
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
        frame({ minHeight: 52, maxWidth: Infinity, alignment: 'leading' }),
        onAppear(() => window.appear(id, owner)),
        onDisappear(() => {
          unprime()
          window.disappear(id, owner)
        }),
        onGeometryChange((geometry) => {
          if (shown && geometry.height > 0) setHeight(geometry.height)
        }),
        // The system card (no listRowBackground, so the row Button's touch-down
        // highlight shows) and inset; the row draws its own separator.
        listRowInsets({ leading: 16, trailing: 12, top: 0, bottom: 0 }),
        listRowHairline({ leading: 32, first }),
        accessibilityIdentifier(`deck-proposal-slot-${id}`),
      ]}
    >
      {shown ? children : <Spacer modifiers={[frame({ height })]} />}
    </VStack>
  )
})
