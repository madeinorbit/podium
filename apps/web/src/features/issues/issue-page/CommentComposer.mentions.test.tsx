// @vitest-environment happy-dom
/**
 * THE COMMENT BOX COMPLETES MEMBER NAMES (POD-6881, acceptance 5): typing `@`
 * and the start of a name offers the members who can see the task (every
 * active member, design §2.2), and choosing one inserts `@Display Name`, the
 * spelling the server matches when the comment is written.
 */

import { asIssueId } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

const roster = vi.hoisted(() => ({
  members: [
    { id: 'mem_ann', displayName: 'Ann Lee' },
    { id: 'mem_bob', displayName: 'Bob Stone' },
  ],
  loaded: [] as boolean[],
}))

vi.mock('@/lib/member-roster', () => ({
  useMemberRoster: (load?: boolean) => {
    roster.loaded.push(load === true)
    return { members: roster.members, nameOf: () => undefined }
  },
}))
vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPool: () => null }))

import { CommentComposer } from './IssueActivity'

afterEach(() => cleanup())

function Harness({ onPost }: { onPost: (body: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <CommentComposer
      issueId={asIssueId('iss_1')}
      busy={false}
      value={value}
      onChange={setValue}
      onPost={() => onPost(value)}
    />
  )
}

const box = () => screen.getByLabelText('Add a comment') as HTMLTextAreaElement

function type(text: string) {
  const ta = box()
  fireEvent.change(ta, { target: { value: text, selectionStart: text.length } })
  ta.setSelectionRange(text.length, text.length)
  fireEvent.select(ta)
}

it('offers the members whose name starts with what follows @', () => {
  render(<Harness onPost={() => {}} />)
  type('thanks @st')
  expect(screen.getByTestId('at-mention-menu').textContent).toContain('Bob Stone')
  expect(screen.getByTestId('at-mention-menu').textContent).not.toContain('Ann Lee')
  // The composer owns the roster's demand, so the names are there when needed.
  expect(roster.loaded).toContain(true)
})

it('inserts @ and the whole name on Enter, and Enter then belongs to the text again', () => {
  const posted: string[] = []
  render(<Harness onPost={(body) => posted.push(body)} />)
  type('thanks @bo')
  fireEvent.keyDown(box(), { key: 'Enter' })
  expect(box().value).toBe('thanks @Bob Stone ')
  expect(screen.queryByTestId('at-mention-menu')).toBeNull()
  fireEvent.keyDown(box(), { key: 'Enter', metaKey: true })
  expect(posted).toEqual(['thanks @Bob Stone '])
})

it('offers nothing when no member carries the name', () => {
  render(<Harness onPost={() => {}} />)
  type('hi @zed')
  expect(screen.queryByTestId('at-mention-menu')).toBeNull()
})
