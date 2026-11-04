import { asMutationId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  currentWriteProvenance,
  outsideWriteProvenance,
  withWriteProvenance,
} from './write-provenance'

const prov = (id: string) => ({ mutationId: asMutationId(id), causationId: id })
const tick = async () => await new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('write provenance scope (POD-6273)', () => {
  it('two interleaved calls each read their own provenance', async () => {
    const seen: string[] = []
    const call = async (id: string) =>
      await withWriteProvenance(prov(id), async () => {
        await tick()
        seen.push(`${id}:${currentWriteProvenance()?.mutationId}`)
        await tick()
        seen.push(`${id}:${currentWriteProvenance()?.mutationId}`)
      })

    await Promise.all([call('a'), call('b')])

    expect(seen.sort()).toEqual(['a:a', 'a:a', 'b:b', 'b:b'])
    expect(currentWriteProvenance()).toBeUndefined()
  })

  it('closes when the call settles, even for work the call left running', async () => {
    let leaked: Promise<unknown> | undefined
    let releaseLeak!: () => void
    const held = new Promise<void>((resolve) => {
      releaseLeak = resolve
    })

    await withWriteProvenance(prov('m'), async () => {
      leaked = (async () => {
        await held
        return currentWriteProvenance()
      })()
    })
    releaseLeak()

    expect(await leaked).toBeUndefined()
  })

  it('outsideWriteProvenance runs a step with no scope', async () => {
    const inner = await withWriteProvenance(prov('m'), async () =>
      outsideWriteProvenance(() => currentWriteProvenance()),
    )

    expect(inner).toBeUndefined()
  })
})
