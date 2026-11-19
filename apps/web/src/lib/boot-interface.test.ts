import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const seam = vi.hoisted(() => ({
  reload: vi.fn(async () => {}),
  save: vi.fn(async () => {}),
  bundle: vi.fn(() => 'bundle+old'),
  digest: vi.fn(() => '1111111'),
  native: vi.fn(() => undefined),
  iteration: vi.fn(() => false),
  listen: vi.fn(),
}))
vi.mock('./force-reload', () => ({ forceReload: seam.reload }))
vi.mock('./reload-preparation', () => ({ prepareForReload: seam.save }))
vi.mock('./logging/build-version', () => ({
  pageBundleVersion: seam.bundle,
  pageBuildDigest: seam.digest,
}))
vi.mock('./nativeDesktop', () => ({ nativeDesktopBridge: seam.native }))
vi.mock('./iteration-mode', () => ({ isIterationMode: seam.iteration }))
vi.mock('@podium/client-core/service-worker', () => ({
  serviceWorkerContainer: () => ({ addEventListener: seam.listen }),
}))

const served = (bundle = 'bundle+new', digest = '2222222') =>
  Response.json({ sourceDigest: digest, web: { present: true, bundle, digest } })

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  sessionStorage.clear()
  seam.bundle.mockReturnValue('bundle+old')
  seam.digest.mockReturnValue('1111111')
  seam.save.mockResolvedValue(undefined)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => served()),
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('repairs a stale page before sign-in, once even when boot is requested twice', async () => {
  const { repairInterfaceOnBoot } = await import('./boot-interface')
  localStorage.setItem('unsent-draft', 'keep')
  const origin = window.location.origin
  expect(await Promise.all([repairInterfaceOnBoot(origin), repairInterfaceOnBoot(origin)])).toEqual(
    ['reloading', 'reloading'],
  )
  expect(seam.reload).toHaveBeenCalledExactlyOnceWith('boot-interface-mismatch')
  expect(fetch).toHaveBeenCalledWith(
    `${origin}/version`,
    expect.objectContaining({ cache: 'no-store' }),
  )
  expect(localStorage.getItem('unsent-draft')).toBe('keep')
  localStorage.removeItem('unsent-draft')
})

it('keeps a matching interface and a different-origin website', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => served('bundle+old', '1111111')),
  )
  let boot = await import('./boot-interface')
  expect(await boot.repairInterfaceOnBoot(window.location.origin)).toBe('ready')
  expect(seam.reload).not.toHaveBeenCalled()
  vi.resetModules()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => served()),
  )
  boot = await import('./boot-interface')
  expect(await boot.repairInterfaceOnBoot('https://another.example')).toBe('ready')
  expect(seam.reload).not.toHaveBeenCalled()
})

it('does not loop against the same served build, and permits a later build', async () => {
  let boot = await import('./boot-interface')
  await boot.repairInterfaceOnBoot(window.location.origin)
  vi.resetModules()
  boot = await import('./boot-interface')
  await expect(boot.repairInterfaceOnBoot(window.location.origin)).rejects.toThrow(
    'The current interface could not be loaded',
  )
  expect(seam.reload).toHaveBeenCalledTimes(1)
  vi.resetModules()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => served('bundle+later', '3333333')),
  )
  boot = await import('./boot-interface')
  expect(await boot.repairInterfaceOnBoot(window.location.origin)).toBe('reloading')
  expect(seam.reload).toHaveBeenCalledTimes(2)
})

it('bounds an unreachable version request and ignores its late stale answer', async () => {
  let respond!: (value: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve
        }),
    ),
  )
  const boot = await import('./boot-interface')
  const check = boot.repairInterfaceOnBoot(window.location.origin)
  await vi.advanceTimersByTimeAsync(boot.INTERFACE_CHECK_MS)
  expect(await check).toBe('ready')
  respond(served())
  await vi.advanceTimersByTimeAsync(0)
  expect(seam.reload).not.toHaveBeenCalled()
})

it('lets the activated worker identify a current page and respects refused edit saves', async () => {
  const { installInterfaceIdentityResponder } = await import('./boot-interface')
  installInterfaceIdentityResponder()
  const handler = seam.listen.mock.calls[0]![1] as (event: unknown) => void
  const postMessage = vi.fn()
  handler({
    data: { type: 'podium:interface-build', target: 'bundle+old' },
    ports: [{ postMessage }],
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(postMessage).toHaveBeenLastCalledWith({ bundle: 'bundle+old', mayReload: true })
  expect(seam.save).not.toHaveBeenCalled()
  seam.save.mockRejectedValueOnce(new Error('unsaved editor'))
  handler({
    data: { type: 'podium:interface-build', target: 'bundle+new' },
    ports: [{ postMessage }],
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(postMessage).toHaveBeenLastCalledWith({ bundle: 'bundle+old', mayReload: false })
})
