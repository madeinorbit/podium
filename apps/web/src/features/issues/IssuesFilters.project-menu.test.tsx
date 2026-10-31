// @vitest-environment happy-dom

/**
 * The tasks view's Project filter (POD-6129). Its "Projects" heading is a
 * Base UI GroupLabel, which throws (production error #31) when it is not
 * inside a Group: opening the menu took down the whole interface.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
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

it('handles projects arriving after opening, multiple selections, and clearing the filter', async () => {
  function Filter() {
    const [paths, setPaths] = useState<string[]>([])
    const [selected, setSelected] = useState<string[]>([])
    return (
      <ProjectMenu
        paths={paths}
        selected={selected}
        onChange={setSelected}
        onOpenChange={(open) => {
          if (open) setPaths(['/src/alpha', '/src/beta'])
        }}
      />
    )
  }

  render(<Filter />)
  const trigger = screen.getByRole('button', { name: 'Filter by project' })
  const open = () => {
    if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger)
  }
  open()
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'alpha' }))
  expect(trigger.getAttribute('title')).toBe('1 projects selected')

  open()
  expect(
    (await screen.findByRole('menuitemcheckbox', { name: 'alpha' })).getAttribute('aria-checked'),
  ).toBe('true')
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'beta' }))
  expect(trigger.getAttribute('title')).toBe('2 projects selected')

  open()
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'alpha' }))
  expect(trigger.getAttribute('title')).toBe('1 projects selected')

  open()
  expect(
    (await screen.findByRole('menuitemcheckbox', { name: 'beta' })).getAttribute('aria-checked'),
  ).toBe('true')
  fireEvent.click(screen.getByRole('menuitem', { name: 'All projects' }))
  expect(trigger.getAttribute('title')).toBe('Filter by project')

  open()
  expect(
    (await screen.findByRole('menuitemcheckbox', { name: 'alpha' })).getAttribute('aria-checked'),
  ).toBe('false')
  expect(screen.getByRole('menuitemcheckbox', { name: 'beta' }).getAttribute('aria-checked')).toBe(
    'false',
  )
  expect(screen.queryByRole('menuitem', { name: 'All projects' })).toBeNull()
})
