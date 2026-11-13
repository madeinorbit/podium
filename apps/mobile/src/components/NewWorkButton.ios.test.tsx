import { createRequire } from 'node:module'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const navigation = vi.hoisted(() => ({ navigate: vi.fn(), push: vi.fn() }))
vi.mock('expo-router', () => ({
  usePathname: () => '/work',
  useRouter: () => ({ push: navigation.push }),
  useNavigation: (parent: string) => {
    expect(parent).toBe('/')
    return { navigate: navigation.navigate }
  },
}))
const { NewWorkButton } = await import('./NewWorkButton.ios')
const require = createRequire(import.meta.url)
const { StackRouter } = require('expo-router/build/react-navigation/routers/StackRouter')

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

it('opens on the first cold-start tap without waiting for the global router ref or catalog', () => {
  const router = StackRouter({ initialRouteName: '(tabs)' })
  const options = {
    routeNames: ['(tabs)', 'new-issue'],
    routeParamList: {},
    routeGetIdList: {},
  }
  let state = router.getInitialState(options)
  navigation.navigate.mockImplementation((name: string, params: Record<string, string>) => {
    state = router.getStateForAction(
      state,
      { type: 'NAVIGATE', payload: { name, params } },
      options,
    )
  })
  // The mounted root context is available while Expo's separate container ref
  // is still null. A router.push routed through that queue would be dropped.
  navigation.push.mockImplementation(() => {})
  render(<NewWorkButton />)
  fireEvent.click(screen.getByRole('button', { name: 'New work' }))
  expect(state.routes[state.index]).toMatchObject({
    name: 'new-issue',
    params: { backTo: '/work' },
  })
  expect(navigation.push).not.toHaveBeenCalled()
  for (let tap = 0; tap < 5; tap++)
    fireEvent.click(screen.getByRole('button', { name: 'New work' }))
  expect(state.routes).toHaveLength(2)
})

it('carries the project tapped in the same native header event to the root compose route', () => {
  render(
    <NewWorkButton
      repoPath="/repo/previous"
      renderTrigger={(open) => (
        <button type="button" onClick={() => open('/repo/tapped')}>
          New work in project
        </button>
      )}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'New work in project' }))
  expect(navigation.navigate).toHaveBeenCalledWith('new-issue', {
    backTo: '/work',
    repoPath: '/repo/tapped',
  })
})
