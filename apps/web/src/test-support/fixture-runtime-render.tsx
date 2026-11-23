import { RuntimeProvider } from '@podium/client-core/react'
import { fixtureRoot } from '@podium/client-core/test-support/command-hooks'
import { type RenderResult, render } from '@testing-library/react'
import type { JSX, ReactElement, ReactNode } from 'react'

/**
 * Render inside the product's RuntimeProvider over the shared fixture root
 * (`fixtureRoot`), so a component's runtime hooks (useCommands,
 * useRequestClient, useUiValue, …) run unmocked and read `owner`: its
 * snapshot-era command names (`renameSession`, `startIssueSession`, `trpc`) and
 * any `ui` it carries. `rerender` keeps the provider.
 */
export function fixtureRuntimeRender(owner: object): (ui: ReactElement) => RenderResult {
  const runtime = fixtureRoot(owner)
  function FixtureRuntime({ children }: { children: ReactNode }): JSX.Element {
    return <RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
  }
  return (ui) => render(ui, { wrapper: FixtureRuntime })
}
