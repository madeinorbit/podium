// @vitest-environment happy-dom
import type { ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { asUserId } from '@podium/model/browser'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HeaderHostIndicators } from '../src/features/machines/HostIndicators'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import { createHeaderFixture } from './header-fixture'

// Only the startup switch changes. Both arms use the real runtime, header
// source/projections, hooks and components against the same synthetic inputs.
const choice = vi.hoisted(() => ({ mode: 'legacy' as 'legacy' | 'pool' }))
vi.mock('@/lib/header-data-layer', () => ({
  initializeHeaderDataLayer: () => {},
  headerDataLayer: () => choice.mode,
  headerCheckRequested: () => false,
}))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false, addEventListener() {}, removeEventListener() {},
  })
})
afterEach(cleanup)

/** Text and DOM order that an operator can see, independent of generated ids
 * and data-layer implementation. Screen-reader status text is not visible. */
function renderedHeader(element: Element): unknown {
  const children = [...element.childNodes].flatMap((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim()
      return text ? [text] : []
    }
    if (!(node instanceof Element) || node.matches('.sr-only, [hidden]')) return []
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return []
    return [renderedHeader(node)]
  })
  return { tag: element.tagName, class: element.getAttribute('class'), children }
}

async function mount(mode: 'legacy' | 'pool') {
  choice.mode = mode
  const fixture = createHeaderFixture(6, 6)
  const failures: string[] = []
  let ready = false
  let runtime: ClientRuntime | undefined
  function Header() {
    const owner = useStoreHandle() as ClientRuntime
    const pool = useWorklistPool()
    useEffect(() => {
      runtime = owner
      ready = mode === 'legacy' || pool !== null
    }, [owner, pool])
    return <HeaderHostIndicators />
  }
  const view = render(
    <StoreProvider principal={asClientPrincipal(asUserId(`header-parity-${mode}`))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={fixture.api} createReplicaFn={() => fixture.newReplica()} networkEnabled={false}
      onFatalError={(error) => failures.push(error)}
      attachRuntime={(owner) => {
        fixture.bindHub(owner.hub)
        fixture.publishMachines()
        fixture.publishMetrics(0)
        return attachWorklistPool(owner, (error) => failures.push(error.message))
      }}>
      <Header />
    </StoreProvider>,
  )
  await waitFor(() => {
    expect(ready).toBe(true)
    expect(view.container.querySelectorAll('.header-machine-name')).toHaveLength(3)
    expect(view.container.querySelector('.header-quota-label')?.textContent?.toUpperCase()).toBe('QUOTA')
    expect(view.container.querySelectorAll('.header-mark')).toHaveLength(16)
  }, { timeout: 15000 })
  expect(failures).toEqual([])
  return { ...view, fixture, runtime: runtime! }
}

describe('old and pool header rendering', () => {
  it('preserves visible names, QUOTA, labels and element order across both paths', async () => {
    const old = await mount('legacy')
    const before = renderedHeader(old.container.querySelector('.header-host-indicators')!)
    const text = old.container.textContent
    old.unmount()
    const pool = await mount('pool')
    expect(renderedHeader(pool.container.querySelector('.header-host-indicators')!)).toEqual(before)
    expect(pool.container.textContent).toBe(text)
    expect([...pool.container.querySelectorAll('.header-machine-name')].map((node) => node.textContent))
      .toEqual(['Host 1', 'Host 2', 'Host 3'])
    expect([...pool.container.querySelectorAll('.header-quota-chip .header-quota-label')]
      .map((node) => node.textContent?.toUpperCase())).toEqual(['QUOTA'])
    for (const chip of pool.container.querySelectorAll('.header-machine-chip')) {
      expect([...chip.querySelectorAll('.header-mark')].map((node) => node.textContent))
        .toEqual(['MEM', 'LOAD', 'DISK', 'AGT', 'IDLE'])
    }
  }, 30000)

  it.each(['legacy', 'pool'] as const)('%s shows df disk usage and keeps an unknown disk distinct from empty', async (mode) => {
    const header = await mount(mode)
    const chip = header.container.querySelector('.header-machine-chip')!
    const disk = () => chip.querySelector('.header-machine-meters > .header-readout:nth-child(3)')!
    expect(disk().textContent).toBe('DISK60%')
    expect(disk().querySelector<HTMLElement>('.header-meter > span')?.style.width).toBe('60%')
    expect(chip.getAttribute('aria-label')).toContain('disk')

    await act(async () => {
      const metrics = header.runtime.hostMetrics.getSnapshot()
      const { disk: _disk, ...unknown } = metrics[0]!
      header.runtime.hostMetrics.publish([unknown, ...metrics.slice(1)])
    })
    expect(disk().textContent).toBe('DISKN/A')
    expect(disk().querySelector('.header-meter > span')).toBeNull()
    expect(chip.getAttribute('aria-label')).toContain('disk usage unavailable')
    await act(async () => {
      const metrics = header.runtime.hostMetrics.getSnapshot()
      header.runtime.hostMetrics.publish([
        { ...metrics[0]!, disk: { path: '/synthetic', totalBytes: 100, usedBytes: 0, availableBytes: 90 } },
        ...metrics.slice(1),
      ])
    })
    expect(disk().textContent).toBe('DISK0%')
    expect(disk().querySelector<HTMLElement>('.header-meter > span')?.style.width).toBe('0%')
  }, 30000)
})
