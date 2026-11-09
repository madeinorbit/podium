// @vitest-environment happy-dom
import { asSessionId } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const access = vi.hoisted(() => ({
  httpOrigin: 'http://podium.test',
  openFile: vi.fn(),
  openFileInWorktree: vi.fn(),
}))

vi.mock('@podium/client-core/react', async (importOriginal) => {
  const { fixtureRuntimeHooks } = await import('@podium/client-core/test-support/command-hooks')
  return {
    ...(await importOriginal<typeof import('@podium/client-core/react')>()),
    ...fixtureRuntimeHooks(() => ({ access })),
  }
})

const { MarkdownPreview } = await import('./MarkdownPreview')

describe('MarkdownPreview file links', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    access.openFile.mockReset()
    access.openFileInWorktree.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function click(): void {
    act(() => (container.querySelector('a') as HTMLAnchorElement).click())
  }

  it('opens a sibling link next to the previewed file in a session', () => {
    act(() =>
      root.render(
        <MarkdownPreview
          sessionId={asSessionId('s1')}
          path="/repo/docs/README.md"
          content="[next](next.md)"
        />,
      ),
    )
    click()
    expect(access.openFile).toHaveBeenCalledWith(asSessionId('s1'), '/repo/docs/next.md')
  })

  it('opens a sibling link through the worktree when the preview has no session', () => {
    act(() =>
      root.render(
        <MarkdownPreview
          sessionId={asSessionId('')}
          worktree={{ root: '/repo' }}
          path="/repo/docs/README.md"
          content="[next](next.md)"
        />,
      ),
    )
    click()
    expect(access.openFileInWorktree).toHaveBeenCalledWith({
      root: '/repo',
      path: '/repo/docs/next.md',
    })
  })
})
