import { closeSync, fsyncSync, openSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fsyncDirectory } from './durable-fs'

vi.mock('node:fs', () => ({
  closeSync: vi.fn(),
  fsyncSync: vi.fn(),
  openSync: vi.fn(() => 42),
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('fsyncDirectory', () => {
  it('does not attempt unsupported directory operations on Windows', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    fsyncDirectory('directory')
    expect(openSync).not.toHaveBeenCalled()
    expect(fsyncSync).not.toHaveBeenCalled()
  })

  it('flushes and closes directories on POSIX', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    fsyncDirectory('directory')
    expect(openSync).toHaveBeenCalledWith('directory', 'r')
    expect(fsyncSync).toHaveBeenCalledWith(42)
    expect(closeSync).toHaveBeenCalledWith(42)
  })

  it('propagates POSIX flush failures and still closes the handle', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    const failure = new Error('flush failed')
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw failure })
    expect(() => fsyncDirectory('directory')).toThrow(failure)
    expect(closeSync).toHaveBeenCalledWith(42)
  })
})
