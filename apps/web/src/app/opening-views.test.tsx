// @vitest-environment happy-dom
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

for (const [name, factory] of factories) {
  it(`${name}: fifty openings share their context and release every closed model`, async () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const registry = vi.spyOn(pool.sources, 'view')
    const refs: WeakRef<object>[] = []
    const create = (current: MobxPool) => {
      const view = factory(current)
      const owned = {
        view,
        disposed: 0,
        dispose() {
          this.disposed++
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
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      async function cycle() {
        await act(async () =>
          root.render(
            <StrictMode>
              <Opening open />
            </StrictMode>,
          ),
        )
        expect(shown).not.toBeNull()
        expect(shown).not.toBe(previous?.deref())
        previous = new WeakRef(shown!)
        const active = shown as ReturnType<typeof create>
        expect(active.disposed).toBe(0)
        await act(async () =>
          root.render(
            <StrictMode>
              <Opening open={false} />
            </StrictMode>,
          ),
        )
        expect(shown).toBeNull()
        expect(active.disposed).toBe(1)
      }
      for (let n = 0; n < 50; n++) await cycle()
      expect(registry).not.toHaveBeenCalled()
      // Closing the root also releases React's previous-render fiber.
      await act(async () => root.render(null))
      for (let turn = 0; turn < 3; turn++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        ;(globalThis as unknown as { Bun: { gc(force: boolean): void } }).Bun.gc(true)
      }
      const reachable = refs.filter((ref) => ref.deref() !== undefined).length
      console.info('React opening reachability', JSON.stringify({ name, openings: 50, reachable }))
      expect(reachable).toBe(0)
    } finally {
      await act(async () => root.unmount())
      registry.mockRestore()
      pool.dispose()
    }
  })
}
