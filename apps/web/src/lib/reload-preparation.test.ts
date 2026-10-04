import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('reload preparation', () => {
  it('waits for local durability and coalesces panel and library reloads', async () => {
    const { registerReloadPreparation, withReloadPreparation } = await import(
      './reload-preparation'
    )
    let release!: () => void
    registerReloadPreparation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const navigate = vi.fn()
    const panel = withReloadPreparation(navigate)
    const library = withReloadPreparation(vi.fn())
    expect(panel).toBe(library)
    await Promise.resolve()
    expect(navigate).not.toHaveBeenCalled()
    release()
    await panel
    expect(navigate).toHaveBeenCalledOnce()
    await withReloadPreparation(navigate)
    expect(navigate).toHaveBeenCalledOnce()
  })

  it('ends a stalled save within the budget, retaining the page and allowing retry', async () => {
    const { registerReloadPreparation, withReloadPreparation, RELOAD_SAVE_BUDGET_MS } =
      await import('./reload-preparation')
    let release!: () => void
    const commit = new Promise<void>((resolve) => {
      release = resolve
    })
    registerReloadPreparation(() => commit)
    const navigate = vi.fn()
    const attempt = withReloadPreparation(navigate)
    const failed = expect(attempt).rejects.toThrow('Reload paused')
    await vi.advanceTimersByTimeAsync(RELOAD_SAVE_BUDGET_MS)
    await failed
    expect(navigate).not.toHaveBeenCalled()
    release()
    await withReloadPreparation(navigate)
    expect(navigate).toHaveBeenCalledOnce()
  })

  it('does not navigate after the principal changes during a local save', async () => {
    const { registerReloadPreparation, withReloadPreparation } = await import(
      './reload-preparation'
    )
    let release!: () => void
    registerReloadPreparation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const navigate = vi.fn()
    const attempt = withReloadPreparation(navigate)
    await Promise.resolve()
    registerReloadPreparation(async () => {})
    release()
    await expect(attempt).rejects.toThrow('draft owner changed')
    expect(navigate).not.toHaveBeenCalled()
  })
})
