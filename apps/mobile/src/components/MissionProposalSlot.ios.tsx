import { HStack, Image, Spacer, VStack } from '@expo/ui/swift-ui'
import {
  accessibilityIdentifier,
  font,
  frame,
  listRowBackground,
  listRowInsets,
  onAppear,
  onDisappear,
  onGeometryChange,
} from '@expo/ui/swift-ui/modifiers'
import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { useRowPrime } from '../lib/use-row-prime'
import { color } from '../theme/theme'
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
        // The deck's card and the system separator, inset to the title as
        // List draws it; the leading column matches task rows (16 + 20 + 12).
        listRowBackground(color.groupedCard),
        listRowInsets({ leading: 16, trailing: 16, top: 0, bottom: 0 }),
        accessibilityIdentifier(`deck-proposal-slot-${id}`),
      ]}
    >
      {shown ? (
        children
      ) : (
        // The same leading ring column as the drawn row: List insets a row's
        // separator past a leading Image once, so a cell first drawn as this
        // placeholder keeps its separator at the title like its neighbours.
        <HStack spacing={12} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}>
          <Image
            systemName="circle"
            color="transparent"
            modifiers={[font({ textStyle: 'footnote' }), frame({ width: 20 })]}
          />
          <Spacer modifiers={[frame({ height })]} />
        </HStack>
      )}
    </VStack>
  )
})
