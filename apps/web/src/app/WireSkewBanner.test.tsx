import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerUpdatePanelOpener } from '@/features/updates/open-panel'
import { APP_START_FALLBACK_ID, AppStarted } from './AppStarted'
import { reportSkew, resetSkewNotice } from './skew-notice'
import { SKEW_BANNER_HEIGHT_VAR, skewBannerHeightValue, WireSkewBanner } from './WireSkewBanner'

const clearedValue = () => document.documentElement.style.getPropertyValue(SKEW_BANNER_HEIGHT_VAR)
const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
const mainSource = readFileSync(resolve(process.cwd(), 'src/app/main.tsx'), 'utf8')

function installAppStartFallback(): HTMLElement {
  const page = new DOMParser().parseFromString(indexHtml, 'text/html')
  const fallback = page.getElementById(APP_START_FALLBACK_ID)
  const script = page.querySelector<HTMLScriptElement>('[data-app-start-fallback-script]')
  if (!(fallback instanceof HTMLElement) || !script?.textContent) {
    throw new Error('index.html is missing the app-start fallback or its timer')
  }
  document.body.replaceChildren(fallback)
  Function(script.textContent)()
  return fallback
}

beforeEach(() => {
  resetSkewNotice()
  document.documentElement.style.removeProperty(SKEW_BANNER_HEIGHT_VAR)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  resetSkewNotice()
})

describe('the app-start fallback', () => {
  it('stays silent when the app mounts before the delay', () => {
    vi.useFakeTimers()
    installAppStartFallback()
    expect(mainSource).toContain('<AppStarted />')

    render(<AppStarted />)

    expect(document.getElementById(APP_START_FALLBACK_ID)).toBeNull()
    vi.advanceTimersByTime(4000)
    expect(document.getElementById(APP_START_FALLBACK_ID)).toBeNull()
  })

  it('appears after the delay when nothing mounts, in normal document flow', () => {
    vi.useFakeTimers()
    const fallback = installAppStartFallback()

    expect(fallback.hidden).toBe(true)
    vi.advanceTimersByTime(3999)
    expect(fallback.hidden).toBe(true)
    vi.advanceTimersByTime(1)
    expect(fallback.hidden).toBe(false)
    expect(fallback.style.position).toBe('')
    expect(fallback.textContent).toContain('Podium’s app did not start.')
    expect(fallback.textContent).toContain('Reload')
    expect(fallback.textContent).not.toContain('update panel')
    expect(fallback.textContent).not.toContain('Repair and reload')
  })
})

describe('the space the skew banner reserves', () => {
  it('rounds a fractional height UP', () => {
    // Down would leave a sliver of the command bar under the banner, which is
    // the whole complaint. A fraction is normal: the banner's height comes from
    // a line-height, not a round number of pixels.
    expect(skewBannerHeightValue(41.2)).toBe('42px')
    expect(skewBannerHeightValue(40)).toBe('40px')
  })

  it('reserves nothing while there is no banner', () => {
    render(<WireSkewBanner />)
    expect(screen.queryByTestId('wire-skew-banner')).toBeNull()
    // Absent, not "0px": the CSS fallback is what makes an unbannered app pay
    // nothing, and a written 0px would hide a stuck property.
    expect(clearedValue()).toBe('')
  })

  it('publishes the height the app must keep clear while the banner is up', () => {
    reportSkew({
      source: 'boot-digest',
      message: 'This page and your server are out of sync.',
      severe: true,
    })
    render(<WireSkewBanner />)
    expect(screen.getByTestId('wire-skew-banner')).toBeTruthy()
    // jsdom lays nothing out, so the measured height is 0 — what this pins is
    // that the property is WRITTEN while the banner is mounted. Its value under
    // a real layout is verified in the browser.
    expect(clearedValue()).not.toBe('')
  })

  it('takes the space back when the banner goes', () => {
    reportSkew({
      source: 'boot-digest',
      message: 'This page and your server are out of sync.',
      severe: true,
    })
    const view = render(<WireSkewBanner />)
    expect(clearedValue()).not.toBe('')
    view.unmount()
    // A property left behind would push the app down by a banner that is no
    // longer there — a dead stripe nobody can explain.
    expect(clearedValue()).toBe('')
  })

  it('resets caches when a dormant update panel opener exists', async () => {
    const opener = vi.fn(() => false)
    const unregister = vi.fn().mockResolvedValue(true)
    const cacheDelete = vi.fn().mockResolvedValue(true)
    const reload = vi.fn()
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistrations: vi.fn().mockResolvedValue([{ unregister }]) },
    })
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue(['podium-precache', 'podium-runtime']),
      delete: cacheDelete,
    })
    vi.stubGlobal('location', { reload })
    const unregisterPanel = registerUpdatePanelOpener(opener, () => false)

    reportSkew({
      source: 'assets-replaced',
      severe: false,
      message: 'The server is serving a newer web build.',
    })
    render(<WireSkewBanner />)

    const button = screen.getByRole('button', { name: 'Reload' })
    button.click()
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))

    expect(opener).toHaveBeenCalledTimes(1)
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(cacheDelete).toHaveBeenCalledTimes(2)
    unregisterPanel()
  })

  it('opens the visible stale-assets panel before falling back to cache reset', () => {
    const opener = vi.fn(() => true)
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    const unregisterPanel = registerUpdatePanelOpener(opener, () => true)

    reportSkew({
      source: 'assets-replaced',
      severe: false,
      message: 'The server is serving a newer web build.',
    })
    render(<WireSkewBanner />)

    const button = screen.getByRole('button', { name: 'Show update' })
    button.click()

    expect(opener).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
    unregisterPanel()
  })
})
