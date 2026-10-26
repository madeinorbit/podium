import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { issuePageCommands } from '../issue-page-commands'
import { IssueParentBranch } from './IssueParentBranch'

vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPool: () => null }))

afterEach(cleanup)

const issue = makeIssue({ id: 'i-1', parentBranch: 'issue/12-stack', repoId: null } as never)

async function typeBranch(name: string) {
  fireEvent.click(screen.getByTestId('parent-branch-trigger'))
  const field = await screen.findByLabelText('Branch name')
  fireEvent.change(field, { target: { value: name } })
  fireEvent.keyDown(field, { key: 'Enter' })
  return field as HTMLInputElement
}

it("lists a stacked task's stored parent, checked", async () => {
  render(<IssueParentBranch issue={issue} busy={false} commands={{} as never} />)
  fireEvent.click(screen.getByTestId('parent-branch-trigger'))
  const row = await screen.findByRole('menuitem', { name: /issue\/12-stack/ })
  expect(row.querySelector('[aria-label="Current"]')).not.toBeNull()
})

it('keeps the picker open until the edit is queued', async () => {
  let land: () => void = () => {}
  const setParentBranch = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        land = resolve
      }),
  )
  render(<IssueParentBranch issue={issue} busy={false} commands={{ setParentBranch } as never} />)
  await typeBranch('release')
  expect(setParentBranch).toHaveBeenCalledWith('release')
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(screen.getByRole('menu')).toBeTruthy()
  land()
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
})

// A server refusal comes later, through the outbox's recovery notice
// (kernel-outbox.refusal-release.test.ts); only a failed enqueue lands here.
it('shows a failed enqueue inline and keeps the typed name', async () => {
  const setParentBranch = vi.fn(async () => {
    throw new Error('Could not queue the change.')
  })
  render(<IssueParentBranch issue={issue} busy={false} commands={{ setParentBranch } as never} />)
  const field = await typeBranch('nope')
  expect((await screen.findByRole('alert')).textContent).toBe('Could not queue the change.')
  expect(field.value).toBe('nope')
})

it('setParentBranch hands the enqueue promise, and its rejection, to the caller', async () => {
  const refusal = new Error('could not queue')
  const updateIssue = vi.fn(async () => {
    throw refusal
  })
  const commands = issuePageCommands({ issue, updateIssue } as never)
  await expect(commands.setParentBranch('main')).rejects.toBe(refusal)
  expect(updateIssue).toHaveBeenCalledWith('i-1', { parentBranch: 'main' })
})
