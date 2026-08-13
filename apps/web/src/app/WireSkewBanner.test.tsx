import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reportSkew, resetSkewNotice } from './skew-notice'
import { SKEW_BANNER_HEIGHT_VAR, skewBannerHeightValue, WireSkewBanner } from './WireSkewBanner'

const clearedValue = () => document.documentElement.style.getPropertyValue(SKEW_BANNER_HEIGHT_VAR)

beforeEach(() => {
  resetSkewNotice()
  document.documentElement.style.removeProperty(SKEW_BANNER_HEIGHT_VAR)
})

afterEach(() => {
  cleanup()
  resetSkewNotice()
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
})
