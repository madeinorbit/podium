import { expect, it, vi } from 'vitest'
import { barrier, settle } from '../../store/executor/harness'
import { disposeOracles, makeOracle, MUST_NOT_CHANGE } from './oracle-support'

it(`${MUST_NOT_CHANGE}: returns a teardown promise that waits for registry disposal`, async () => {
  const oracle = await makeOracle()
  const original = oracle.reg.dispose.bind(oracle.reg)
  const held = barrier()
  let work = Promise.resolve()
  let finished = false
  const spy = vi.spyOn(oracle.reg, 'dispose').mockImplementation(() => {
    work = (async () => {
      await held.wait()
      await original()
      finished = true
    })()
    return work
  })
  try {
    let settled = false
    const closing = disposeOracles().then(() => {
      settled = true
    })
    await settle()
    expect(settled).toBe(false)
    held.release()
    await closing
    expect(finished).toBe(true)
  } finally {
    held.release()
    await work
    spy.mockRestore()
    await oracle.store.close()
  }
})
