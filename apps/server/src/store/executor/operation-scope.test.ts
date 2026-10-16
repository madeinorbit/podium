import { describe, expect, it } from 'vitest'
import { currentOperation, holdOperation, operationSlot, withOperation, withOwnOperation } from './operation-scope'

/** POD-6189: an operation is a memo lifetime that ends when its work settles. */
describe('withOperation', () => {
  const counter = operationSlot(() => ({ n: 0 }))

  it('gives one memo to the whole operation, across awaits, and joins a nested one', async () => {
    await withOperation(async () => {
      const outer = currentOperation()
      currentOperation()!.slot(counter).n += 1
      await Promise.resolve()
      await withOperation(async () => {
        expect(currentOperation()).toBe(outer)
        currentOperation()!.slot(counter).n += 1
      })
      expect(currentOperation()!.slot(counter).n).toBe(2)
    })
  })

  it('has none outside, and a new one for the next operation', async () => {
    expect(currentOperation()).toBeUndefined()
    const ids: number[] = []
    await withOperation(async () => ids.push(currentOperation()!.id))
    await withOperation(async () => ids.push(currentOperation()!.id))
    expect(ids[0]).not.toBe(ids[1])
  })

  it('is gone for work the operation left running', async () => {
    let later: Promise<unknown> | undefined
    await withOperation(async () => {
      currentOperation()!.slot(counter).n += 1
      later = new Promise((resolve) => setTimeout(() => resolve(currentOperation()), 5))
    })
    expect(await later).toBeUndefined()
  })

  it('ends when its function throws, synchronously or not', async () => {
    let held: unknown
    expect(() => withOperation(() => {
      held = currentOperation()
      throw new Error('sync')
    })).toThrow('sync')
    await expect(withOperation(async () => {
      throw new Error('async')
    })).rejects.toThrow('async')
    expect(held).toBeDefined()
    expect(currentOperation()).toBeUndefined()
  })
})

describe('holdOperation', () => {
  const memo = operationSlot(() => ({ hits: 0 }))

  it('keeps the operation open for work it started, and no longer', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let seenWhileHeld: unknown
    let seenAfter: unknown
    await withOperation(async () => {
      currentOperation()!.slot(memo).hits += 1
      holdOperation(held)
      void held.then(() => {
        seenAfter = currentOperation()
      })
      setTimeout(() => {
        seenWhileHeld = currentOperation()?.slot(memo).hits
        release()
      }, 5)
    })
    await held
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(seenWhileHeld).toBe(1)
    // Work queued on the held step itself runs after the release: ended.
    expect(seenAfter).toBeUndefined()
    await new Promise<void>((resolve) => setTimeout(() => {
      expect(currentOperation()).toBeUndefined()
      resolve()
    }, 1))
  })

  it('does nothing outside an operation', () => {
    expect(() => holdOperation(Promise.resolve())).not.toThrow()
  })
})

describe('withOwnOperation', () => {
  it('starts a new operation inside an open one, and leaves the outer one open', async () => {
    await withOperation(async () => {
      const outer = currentOperation()
      await withOwnOperation(async () => {
        expect(currentOperation()).toBeDefined()
        expect(currentOperation()).not.toBe(outer)
      })
      expect(currentOperation()).toBe(outer)
    })
  })
})
