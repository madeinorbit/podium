import { treeOf } from '@podium/client-graph/collections'
import { LOADING } from '@podium/client-graph/loading'
import { observer } from '@podium/client-graph/react'
import {
  REFRESH_SCREENS,
  type RefreshScreen,
  refreshingScreenFixture,
} from '@podium/client-graph/refreshing-screen.test.fixture'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Text } from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'
import { Screen } from './Screen'

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}))
vi.mock('./icons', () => ({ ChevronLeft: () => null }))
afterEach(cleanup)

const PhoneAnswer = observer(function PhoneAnswer({
  fixture,
  name,
}: {
  fixture: Awaited<ReturnType<typeof refreshingScreenFixture>>
  name: RefreshScreen
}) {
  const answer = fixture.answer(name, 'phone')
  return (
    <Screen title={name} refreshing={fixture.refreshing(name, 'phone')}>
      <Text testID="screen-answer">{answer === LOADING ? 'Loading' : JSON.stringify(answer)}</Text>
    </Screen>
  )
})

for (const name of REFRESH_SCREENS)
  it(`${name}: phone shows cached data and one refreshing mark, then updates the same content`, async () => {
    const fixture = await refreshingScreenFixture()
    fixture.mark(fixture.owned[name])
    const view = render(<PhoneAnswer fixture={fixture} name={name} />)
    try {
      expect(screen.getAllByLabelText('Refreshing')).toHaveLength(1)
      const data = screen.getByTestId('screen-answer')
      const slot = screen.getByTestId('screen-refresh-mark')
      expect(data.textContent).toContain('Cached root')
      expect(data.textContent).not.toContain('Loading')
      await act(async () => fixture.land())
      expect(screen.queryByLabelText('Refreshing')).toBeNull()
      expect(screen.getByTestId('screen-answer')).toBe(data)
      expect(screen.getByTestId('screen-refresh-mark')).toBe(slot)
      expect(data.textContent).toContain('Cached root updated')
      expect(data.textContent).not.toContain('Loading')
      await act(async () => fixture.mark(treeOf('other')))
      expect(screen.queryByLabelText('Refreshing')).toBeNull()
      expect(fixture.requested).toEqual([])
    } finally {
      view.unmount()
      fixture.dispose()
    }
  })
