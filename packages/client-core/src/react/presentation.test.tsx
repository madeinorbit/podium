// @vitest-environment happy-dom
import { asUserId } from '@podium/model'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import { createEffectiveChanges, type EffectiveReadView } from '../engine/effective-changes'
import { asClientPrincipal } from '../principal'
import { createPresentationModel } from '../presentation/model'
import { StoreProvider, usePresentationCell, usePresentationModel } from './provider'

const fixture = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('../engine/runtime', () => ({ createClientRuntime: (init: unknown) => fixture.create(init) }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const seed = (value: string): EffectiveReadView => {
  const local = { drafts: { s: value }, view: 'workspace', dockTab: 'superagent', focusedPane: 'A', split: false, superOpen: false, workspaces: {} }
  return { commit: {}, ids: () => [], row: () => undefined,
    local: key => (local[key as keyof typeof local] ?? null) as never }
}

describe('D5 presentation React binding', () => {
  it('passes the default-off flag, switches principal ownership and binds addressed cells', () => {
    const instances: Array<{ source: ReturnType<typeof createEffectiveChanges>; destroy: ReturnType<typeof vi.fn> }> = []
    fixture.create.mockImplementation((init: { presentationModel: boolean }) => {
      const source = createEffectiveChanges(seed(`principal-${instances.length}`))
      const adapter = init.presentationModel ? createPresentationModel(source) : undefined
      const destroy = vi.fn(() => { adapter?.destroy(); source.destroy() })
      instances.push({ source, destroy })
      return { presentation: adapter?.model, start: () => adapter?.start(), dispose: () => adapter?.stop(), destroy }
    })
    function Draft() {
      const model = usePresentationModel()!
      const text = usePresentationCell(model.draft('s'))
      return <span>{text}</span>
    }
    const config = { httpOrigin: 'http://test', wsClientUrl: 'ws://test' }
    const api = {} as PodiumClientApi
    const props = { config, api, onFatalError: () => {}, createReplicaFn: () => { throw new Error('mock') } }
    const a = asClientPrincipal(asUserId('a')), b = asClientPrincipal(asUserId('b'))
    const rendered = render(<StoreProvider {...props} principal={a}><span>off</span></StoreProvider>)
    expect(fixture.create.mock.calls[0]![0].presentationModel).toBe(false)
    rendered.rerender(<StoreProvider {...props} principal={a} presentationModel><Draft /></StoreProvider>)
    expect(instances[0]!.destroy).toHaveBeenCalledOnce()
    expect(rendered.container.textContent).toBe('principal-1')
    act(() => instances[1]!.source.publish({ type: 'replace', reason: 'bootstrap', view: seed('updated') }))
    expect(rendered.container.textContent).toBe('updated')
    rendered.rerender(<StoreProvider {...props} principal={b} presentationModel><Draft /></StoreProvider>)
    expect(instances[1]!.destroy).toHaveBeenCalledOnce()
    expect(rendered.container.textContent).toBe('principal-2')
    act(() => instances[1]!.source.publish({ type: 'replace', reason: 'rescope', view: seed('late') }))
    expect(rendered.container.textContent).toBe('principal-2')
    rendered.rerender(<StoreProvider {...props} principal={null} presentationModel><Draft /></StoreProvider>)
    expect(instances[2]!.destroy).toHaveBeenCalledOnce()
    expect(rendered.container.textContent).toBe('')
  })
})
