import { autorun, createAtom, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { createFieldInputs } from './field-inputs'

it('releases borrowed field demand and compares only fields still observed', () => {
  const owner = createAtom('owner')
  const inputs = createFieldInputs<{ title: string; prefix: string }>(
    ['title', 'prefix'], { title: 'before', prefix: 'POD' }, 'fields',
    (key) => key === 'prefix' ? owner : undefined,
  )
  const title = vi.fn(() => inputs.row.title), prefix = vi.fn(() => inputs.row.prefix)
  const stopTitle = autorun(title), stopPrefix = autorun(prefix)
  try {
    runInAction(() => inputs.set('title', 'after'))
    expect(title).toHaveBeenCalledTimes(2)
    expect(prefix).toHaveBeenCalledTimes(1)
    stopPrefix()
    const read = vi.fn((key: 'title' | 'prefix') => key === 'title' ? 'latest' : 'NEW')
    runInAction(() => inputs.replace(read))
    expect(title.mock.results.at(-1)?.value).toBe('latest')
    expect(read.mock.calls.every(([key]) => key === 'title')).toBe(true)
    expect(prefix).toHaveBeenCalledTimes(1)
    const reopen = autorun(prefix)
    expect(prefix.mock.results.at(-1)?.value).toBe('NEW')
    reopen()
  } finally { stopTitle(); stopPrefix() }
})
