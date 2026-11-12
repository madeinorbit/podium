import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { noticeScreenLayout } from './notice-screen-layout'

afterEach(cleanup)

it.each([
  '(tabs)',
  'session/[id]',
  'index',
])('keeps %s content free of floating delivery banners', (name) => {
  const child = <div>Content</div>
  const layout = noticeScreenLayout({
    route: { name },
    options: { headerTransparent: true },
    children: child,
  })
  expect(layout).toBe(child)
  const view = render(layout)
  expect(view.getByText('Content')).toBeTruthy()
  expect(view.queryByRole('alert')).toBeNull()
})
