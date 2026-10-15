// @vitest-environment happy-dom

/**
 * The tasks view's Project filter (POD-6129). Its "Projects" heading is a
 * Base UI GroupLabel, which throws (production error #31) when it is not
 * inside a Group: opening the menu took down the whole interface.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectMenu } from './IssuesFilters'

afterEach(cleanup)

it('opens with its Projects heading and toggles a project', async () => {
  const onChange = vi.fn()
  render(<ProjectMenu paths={['/src/alpha', '/src/beta']} selected={[]} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Filter by project' }))
  await screen.findByRole('menuitemcheckbox', { name: 'alpha' })
  expect(screen.getByText('Projects')).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'beta' }))
  expect(onChange).toHaveBeenCalledWith(['/src/beta'])
})

it('opens with its Projects heading when there are no projects', async () => {
  render(<ProjectMenu paths={[]} selected={[]} onChange={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Filter by project' }))
  await screen.findByRole('menuitem', { name: 'No projects' })
  expect(screen.getByText('Projects')).toBeTruthy()
})
