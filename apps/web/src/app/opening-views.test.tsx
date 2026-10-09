// @vitest-environment happy-dom
import { gcAndSweep, releaseWeakRefs } from 'bun:jsc'
import { useOpeningView } from '@podium/client-graph/react'
import { createIssuePageViews } from '@podium/client-graph/issue-page'
import { createSettingsViews } from '@podium/client-graph/settings-views'
import { createAutomationViews } from '@podium/client-graph/automation-views'
import { createExplorerViews } from '@podium/client-graph/issue-board-cards'
import { MobxPool } from '@podium/client-graph/pool'
import { createSettingsMachineReaders as webMachines } from '../features/settings/settings-machine-readers'
import { createSettingsMachineReaders as phoneMachines } from '../../../mobile/src/screens/settings-machine-readers'
import { act, createContext, useContext, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const factories = [
  ['issue detail, menu and sheet', createIssuePageViews],
  ['explorer companions', createExplorerViews],
  ['settings and setup', createSettingsViews],
  ['automations, dialog and specs', createAutomationViews],
  ['web settings machines', webMachines],
  ['phone settings machines', phoneMachines],
] as const

/** Return from the React exercise before collecting: its assertion locals and
 * root/fiber objects must not become roots in the reachability measurement. */
async function exerciseOpenings(pool: MobxPool, factory: (typeof factories)[number][1]) {
  const registry = vi.spyOn(pool.sources, 'view')
  const refs: WeakRef<object>[] = []
  let disposals = 0
  const create = (current: MobxPool) => {
    const view = factory(current)
    const owned = {
      view,
      disposed: 0,
      dispose() {
        this.disposed++
        disposals++
        view.dispose()
      },
    }
    refs.push(new WeakRef(view))
    return owned
  }
  const Context = createContext<ReturnType<typeof create> | null>(null)
  let previous: WeakRef<object> | null = null
  let shown: object | null = null
  function Leaf() {
    shown = useContext(Context)
    return null
  }
  function Opening({ open }: { open: boolean }) {
    const view = useOpeningView(pool, create, open)
    return (
      <Context.Provider value={view}>
        <Leaf />
      </Context.Provider>
    )
  }
  // Keep matcher and render callbacks synchronous. JSC can retain their
  // arguments in suspended async frames after the opening has closed.
  function checkOpen() {
    expect(shown).not.toBeNull()
    expect(shown).not.toBe(previous?.deref())
    previous = new WeakRef(shown!)
    expect((shown as ReturnType<typeof create>).disposed).toBe(0)
  }
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    async function cycle() {
      const closedBefore = disposals
      await act(() =>
        root.render(
          <StrictMode>
            <Opening open />
          </StrictMode>,
        ),
      )
      checkOpen()
      await act(() =>
        root.render(
          <StrictMode>
            <Opening open={false} />
          </StrictMode>,
        ),
      )
      expect(shown).toBeNull()
      // Keep only the counter across the async close. A strong local holding
      // the last opening here can remain in the suspended test frame during GC.
      expect(disposals - closedBefore).toBe(1)
    }
    for (let n = 0; n < 50; n++) await cycle()
    expect(registry).not.toHaveBeenCalled()
    return refs
  } finally {
    await act(() => root.unmount())
    registry.mockRestore()
  }
}

for (const [name, factory] of factories) {
  it(`${name}: fifty openings share their context and release every closed model`, async () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    try {
      const refs = await exerciseOpenings(pool, factory)
      for (let turn = 0; turn < 3; turn++) {
        // Collect from a separate task while the assertion frame is suspended.
        await new Promise<void>((resolve) => setTimeout(() => {
          releaseWeakRefs()
          gcAndSweep()
          resolve()
        }, 0))
      }
      const retained = refs.flatMap((ref, index) => ref.deref() === undefined ? [] : [index])
      const reachable = retained.length
      console.info('React opening reachability', JSON.stringify({ name, openings: 50, created: refs.length, retained, reachable }))
      expect(reachable).toBe(0)
    } finally {
      pool.dispose()
    }
  })
}
