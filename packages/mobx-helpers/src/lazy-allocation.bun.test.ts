/// <reference types="bun" />
// A separate Bun process keeps runner transforms and other tests out of heap deltas.
import { expect, it } from 'bun:test'
import { gcAndSweep, heapStats } from 'bun:jsc'
import { lazy } from './lazy'

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

it('costs nothing per unread object over a plain class', async () => {
  class Plain {
    constructor(readonly a: number, readonly b: number) {}
    get sum() { return this.a + this.b }
    get product() { return this.a * this.b }
    get label() { return `${this.a}:${this.b}` }
  }
  class Lazy {
    constructor(readonly a: number, readonly b: number) {}
    @lazy get sum() { return this.a + this.b }
    @lazy get product() { return this.a * this.b }
    @lazy get label() { return `${this.a}:${this.b}` }
  }
  const N = 20_000
  const heap = () => { gcAndSweep(); return heapStats().heapSize }
  // Every measured object stays alive to the end, so a measurement only ever
  // sees the objects it made and the garbage collector frees only temporaries
  // (the computeds a read outside a reaction holds until the code finishes).
  const alive: object[][] = []
  const bytesPerObject = async (make: (i: number) => object, read: boolean) => {
    await settle()
    const before = heap()
    const objects = Array.from({ length: N }, (_, i) => make(i))
    if (read) for (const object of objects) void (object as Plain).sum
    alive.push(objects)
    // Held reads are released once the code that read them has finished.
    await settle()
    return (heap() - before) / N
  }
  // Warm the outside-read/release path before measuring. Its first invocation
  // leaves engine temporaries collectible by the next allocation batch.
  await bytesPerObject(i => new Lazy(i, 2), true)
  await bytesPerObject(i => new Plain(i, 2), false)
  const warmed = alive.splice(0)
  const extra: number[] = []
  const samples: { plain: number; unread: number; readOutside: number }[] = []
  for (let round = 0; round < 5; round++) {
    const plain = await bytesPerObject(i => new Plain(i, 2), false)
    const unread = await bytesPerObject(i => new Lazy(i, 2), false)
    const readOutside = await bytesPerObject(i => new Lazy(i, 2), true)
    samples.push({ plain, unread, readOutside })
    console.info('lazy allocation round', JSON.stringify({ round, plain, unread, readOutside }))
    expect(plain).toBeGreaterThan(16)
    extra.push(Math.max(Math.abs(unread - plain), Math.abs(readOutside - plain)))
  }
  extra.sort((x, y) => x - y)
  console.info('lazy allocation bytes per object', JSON.stringify({ samples, medianExtra: extra[2] }))
  // Median over interleaved rounds; a slot holder or a kept computed would be ~100+ bytes.
  expect(extra[2]).toBeLessThan(4)
  expect(alive).toHaveLength(15)
  expect(warmed).toHaveLength(2)
})
