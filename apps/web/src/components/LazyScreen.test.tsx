// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { Component, type ReactNode, Suspense } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { lazyScreen } from './LazyScreen'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('keeps an unvisited offline screen in its shell, then renders it on online', async () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const load = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module: /screen.js'))
    .mockResolvedValue({ default: () => <p>Local screen data</p> })
  const Screen = lazyScreen(load)
  render(
    <div>
      <nav>App shell</nav>
      <Suspense fallback={null}>
        <Screen />
      </Suspense>
    </div>,
  )
  expect(await screen.findByText('This screen is not available offline.')).toBeTruthy()
  expect(screen.getByText('App shell')).toBeTruthy()
  expect(load).toHaveBeenCalledOnce()
  await act(async () => {
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('online'))
  })
  expect(await screen.findByText('Local screen data')).toBeTruthy()
  expect(load).toHaveBeenCalledTimes(2)
})

it('passes real module errors to the enclosing error boundary', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  class Parent extends Component<{ children: ReactNode }, { error: boolean }> {
    override state = { error: false }
    static getDerivedStateFromError() {
      return { error: true }
    }
    override render() {
      return this.state.error ? <p>Real module error</p> : this.props.children
    }
  }
  const Screen = lazyScreen(async () => {
    throw new Error('module evaluation failed')
  })
  render(
    <Parent>
      <Suspense fallback={null}>
        <Screen />
      </Suspense>
    </Parent>,
  )
  await waitFor(() => expect(screen.getByText('Real module error')).toBeTruthy())
  expect(screen.queryByText('This screen is not available offline.')).toBeNull()
})
