import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewWorkButton } from './NewWorkButton'

const navigation = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('expo-router', () => ({ usePathname: () => '/work', useRouter: () => navigation }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('one New Task entry flow', () => {
  it('opens the compose route without mounting a second launch/data flow', () => {
    render(<NewWorkButton />)
    fireEvent.click(screen.getByRole('button', { name: 'New work' }))
    expect(navigation.push).toHaveBeenCalledWith({
      pathname: '/new-issue',
      params: { backTo: '/work' },
    })
  })
  it('carries a project-header preset into the same compose route', () => {
    render(
      <NewWorkButton
        repoPath="/repo/podium"
        renderTrigger={(open) => (
          <button type="button" onClick={() => open()}>
            Compose
          </button>
        )}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Compose' }))
    expect(navigation.push).toHaveBeenCalledWith({
      pathname: '/new-issue',
      params: { backTo: '/work', repoPath: '/repo/podium' },
    })
  })

  it('uses the tapped path when a parent sets its preset and opens in the same event', () => {
    function ProjectHeaders() {
      const [repoPath, setRepoPath] = useState<string | null>(null)
      const openProject = useRef<((path: string) => void) | null>(null)
      return (
        <>
          {['/repo/alpha', '/repo/beta'].map((path) => (
            <button
              key={path}
              type="button"
              onClick={() => {
                setRepoPath(path)
                openProject.current?.(path)
              }}
            >
              {path}
            </button>
          ))}
          <NewWorkButton
            repoPath={repoPath}
            renderTrigger={(open) => {
              openProject.current = open
              return null
            }}
          />
        </>
      )
    }
    render(<ProjectHeaders />)
    for (const path of ['/repo/beta', '/repo/alpha', '/repo/beta']) {
      fireEvent.click(screen.getByRole('button', { name: path }))
      expect(navigation.push).toHaveBeenLastCalledWith({
        pathname: '/new-issue',
        params: { backTo: '/work', repoPath: path },
      })
    }
    expect(navigation.push).toHaveBeenCalledTimes(3)
  })
})
