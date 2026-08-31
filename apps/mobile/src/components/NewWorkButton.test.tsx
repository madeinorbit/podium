/**
 * THE LAUNCH SHEET AFTER THE WIZARD [POD-1354].
 *
 * Two claims, and the first is the one the operator complained about: a project
 * list with ONE row in it is not a decision, so the sheet states the project and
 * starts from it. The second is the converse — where the choice is real, the
 * field is still a control.
 */

import type { GitRepositoryWire } from '@podium/model'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'

afterEach(cleanup)

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('./BottomSheet', () => ({
  BottomSheet: ({
    visible,
    head,
    children,
  }: {
    visible: boolean
    head?: ReactNode
    children: ReactNode
  }) =>
    visible ? (
      <div>
        {head}
        {children}
      </div>
    ) : null,
}))
vi.mock('expo-router', () => ({
  usePathname: () => '/work',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

const { NewWorkButton } = await import('./NewWorkButton')

function repo(path: string): GitRepositoryWire {
  return {
    path,
    kind: 'repository',
    branch: 'main',
    repoId: `repo_${path.split('/').pop()}`,
    machineId: 'mine',
    worktrees: [{ path: `${path}-wt`, branch: 'feature' }],
  } as unknown as GitRepositoryWire
}

describe('the phone launch sheet', () => {
  it('states the only project and starts from it, instead of asking for it', async () => {
    await renderWithMobileStore(<NewWorkButton />, { repos: [repo('/home/dev/podium')] })
    fireEvent.click(screen.getByLabelText('New work'))

    // Named on the primary control, so the sheet still says where this lands.
    expect(screen.getByLabelText('Start in podium')).toBeTruthy()
    // Present, but inert: a picker over a list of one is a tap the app collects
    // on the way to doing the only thing it could have done.
    const project = screen.getByLabelText('Project, podium')
    expect(project.getAttribute('role')).not.toBe('button')
    // And the wizard's last step is gone with it.
    expect(screen.queryByLabelText('Choose project')).toBeNull()
  })

  it('keeps the project a control when the choice is real', async () => {
    await renderWithMobileStore(<NewWorkButton />, {
      repos: [repo('/home/dev/podium'), repo('/home/dev/shared')],
    })
    fireEvent.click(screen.getByLabelText('New work'))

    const project = screen.getByLabelText(/^Project, /)
    expect(project.getAttribute('role')).toBe('button')
    fireEvent.click(project)
    expect(screen.getByLabelText('shared')).toBeTruthy()
    expect(screen.getByLabelText('podium')).toBeTruthy()
  })

  it('offers the shell inside the model list rather than as a second control', async () => {
    await renderWithMobileStore(<NewWorkButton />, { repos: [repo('/home/dev/podium')] })
    fireEvent.click(screen.getByLabelText('New work'))
    expect(screen.queryByLabelText('Shell')).toBeNull()

    fireEvent.click(screen.getByLabelText('Model, Auto'))
    fireEvent.click(screen.getByLabelText('No agent Shell'))
    expect(screen.getByLabelText('Model, Shell')).toBeTruthy()
  })
})
