import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require_ = createRequire(import.meta.url)
const chunk = '/mobile/_expo/static/js/web/screen-hash.js'
const paths = { '42': chunk }

/** Exercise Metro's actual CommonJS entry, with only Expo's final require stubbed. */
function loader(load: (bundle: string) => Promise<void>, platform = 'web') {
  const expo = Object.assign(vi.fn(() => Promise.resolve('screen')), {
    unstable_importMaybeSync: vi.fn(() => 'screen'),
    prefetch: vi.fn(), unstable_resolve: vi.fn(), unstable_createWorker: vi.fn(),
  })
  const module = { exports: {} as typeof expo }
  const environment = {
    document, window, setTimeout, clearTimeout,
    __METRO_GLOBAL_PREFIX__: '',
    globalThis: { __loadBundleAsync: load },
    process: { env: { EXPO_OS: platform } },
  }
  const dependencies = new Map<string, unknown>()
  function evaluate(path: string): unknown {
    if (dependencies.has(path)) return dependencies.get(path)
    const child = { exports: {} }
    runInNewContext(readFileSync(path, 'utf8'), {
      ...environment, module: child,
      require: (name: string) => evaluate(require_.resolve(name)),
    }, { filename: path })
    dependencies.set(path, child.exports)
    return child.exports
  }
  runInNewContext(readFileSync(require_.resolve('./async-require-load-first.js'), 'utf8'), {
    ...environment, module,
    require: (name: string) => name === 'expo/internal/async-require-module'
      ? expo : evaluate(require_.resolve(name)),
  })
  return { asyncRequire: module.exports, expo }
}

function interrupted() {
  return Object.assign(new Error('Loading module failed.'), { name: 'AsyncRequireError', type: 'error' })
}

beforeEach(() => { vi.useFakeTimers(); document.body.replaceChildren() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); document.body.replaceChildren() })

describe('phone lazy chunk recovery', () => {
  it('keeps the import pending and the retry state visible until a cut link recovers', async () => {
    const load = vi.fn().mockRejectedValueOnce(interrupted()).mockResolvedValue(undefined)
    const { asyncRequire, expo } = loader(load)
    const result = asyncRequire(42, paths)
    void result.catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(document.body.textContent).toContain('Connection interrupted')
    expect(expo).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(load).toHaveBeenCalledTimes(2)
    await expect(result).resolves.toBe('screen')
    expect(document.body.textContent).toBe('')
    expect(expo).toHaveBeenCalledTimes(1)
  })

  it('bounds automatic retries and lets Retry resume the same pending import', async () => {
    const load = vi.fn().mockRejectedValue(interrupted())
    const { asyncRequire } = loader(load)
    const result = asyncRequire(42, paths)
    void result.catch(() => {})
    let settled = false
    void result.then(() => { settled = true }, () => { settled = true })
    await vi.advanceTimersByTimeAsync(7000)
    expect(load).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(60000)
    expect(load).toHaveBeenCalledTimes(4)
    expect(settled).toBe(false)
    expect(document.body.textContent).toContain('Check your connection, then retry.')
    load.mockResolvedValue(undefined)
    document.querySelector<HTMLButtonElement>('button')!.click()
    await expect(result).resolves.toBe('screen')
    expect(document.body.textContent).toBe('')
  })

  it('shares one download and retry across async and maybe-sync imports of the same chunk', async () => {
    const load = vi.fn().mockRejectedValueOnce(interrupted()).mockResolvedValue(undefined)
    const { asyncRequire } = loader(load)
    const first = asyncRequire(42, paths)
    const second = asyncRequire.unstable_importMaybeSync(42, paths)
    void first.catch(() => {}); void Promise.resolve(second).catch(() => {})
    await vi.advanceTimersByTimeAsync(1000)
    await expect(Promise.all([first, second])).resolves.toEqual(['screen', 'screen'])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('recovers promptly when the browser comes online without overlapping the backoff', async () => {
    const load = vi.fn().mockRejectedValueOnce(interrupted()).mockResolvedValue(undefined)
    const { asyncRequire } = loader(load)
    const result = asyncRequire(42, paths)
    void result.catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    window.dispatchEvent(new Event('online'))
    await expect(result).resolves.toBe('screen')
    await vi.advanceTimersByTimeAsync(7000)
    expect(load).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toBe('')
  })

  it('retains the recovery surface while another chunk is still unavailable', async () => {
    const load = vi.fn(async (bundle: string) => { if (bundle === chunk) throw interrupted() })
    const { asyncRequire } = loader(load)
    const stuck = asyncRequire(42, paths)
    void stuck.catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    await expect(asyncRequire(43, { '43': '/other.js' })).resolves.toBe('screen')
    expect(document.body.textContent).toContain('Connection interrupted')
    load.mockResolvedValue(undefined)
    document.querySelector<HTMLButtonElement>('button')!.click()
    await expect(stuck).resolves.toBe('screen')
    expect(document.body.textContent).toBe('')
  })

  it('leaves module evaluation errors rejected without a recovery loop', async () => {
    const failure = new Error('Broken module factory')
    const load = vi.fn().mockRejectedValue(failure)
    const { asyncRequire } = loader(load)
    await expect(asyncRequire(42, paths)).rejects.toBe(failure)
    await vi.advanceTimersByTimeAsync(7000)
    expect(load).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toBe('')
  })

  it('delegates imports without a split path and leaves native exports intact', async () => {
    const load = vi.fn().mockResolvedValue(undefined)
    const { asyncRequire, expo } = loader(load)
    await expect(asyncRequire(42, null)).resolves.toBe('screen')
    expect(asyncRequire.unstable_importMaybeSync(42, null)).toBe('screen')
    expect(load).not.toHaveBeenCalled()
    expect(asyncRequire.prefetch).toBe(expo.prefetch)
    const native = loader(load, 'ios')
    expect(native.asyncRequire).toBe(native.expo)
  })
})
