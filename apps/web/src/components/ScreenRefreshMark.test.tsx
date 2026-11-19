import { treeOf } from '@podium/client-graph/collections'
import { LOADING } from '@podium/client-graph/loading'
import { observer } from '@podium/client-graph/react'
import {
  REFRESH_SCREENS,
  type RefreshScreen,
  refreshingScreenFixture,
} from '@podium/client-graph/refreshing-screen.test.fixture'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ScreenRefreshMark } from './ScreenRefreshMark'

afterEach(cleanup)

const ScreenAnswer = observer(function ScreenAnswer({
  fixture,
  name,
}: {
  fixture: Awaited<ReturnType<typeof refreshingScreenFixture>>
  name: RefreshScreen
}) {
  const answer = fixture.answer(name, 'web')
  return (
    <section>
      <header>
        <ScreenRefreshMark refreshing={fixture.refreshing(name, 'web')} />
      </header>
      <main>{answer === LOADING ? 'Loading' : JSON.stringify(answer)}</main>
    </section>
  )
})

for (const name of REFRESH_SCREENS)
  it(`${name}: one quiet screen mark with cached data offline; reload updates in place`, async () => {
    const fixture = await refreshingScreenFixture()
    fixture.mark(fixture.owned[name])
    const view = render(<ScreenAnswer fixture={fixture} name={name} />)
    try {
      expect(screen.getAllByRole('status', { name: 'Refreshing' })).toHaveLength(1)
      const data = view.container.querySelector('main')!
      expect(data.textContent).toContain('Cached root')
      expect(data.textContent).not.toContain('Loading')
      const slot = view.container.querySelector('[data-screen-refresh]')!
      await act(async () => fixture.land())
      expect(screen.queryByRole('status', { name: 'Refreshing' })).toBeNull()
      expect(view.container.querySelector('main')).toBe(data)
      expect(data.textContent).toContain('Cached root updated')
      expect(data.textContent).not.toContain('Loading')
      expect(view.container.querySelector('[data-screen-refresh]')).toBe(slot)
      await act(async () => fixture.mark(treeOf('other')))
      expect(screen.queryByRole('status', { name: 'Refreshing' })).toBeNull()
      expect(fixture.requested).toEqual([])
    } finally {
      view.unmount()
      fixture.dispose()
    }
  })
