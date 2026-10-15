import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { issueAgentDefaultLabel, issueAgentIcon, issueAgentOptions } from './issue-agents'

it('uses the same Settings harness for the default row label and icon', () => {
  const options = issueAgentOptions('auto', undefined, 'codex')
  expect(options[0]?.label).toBe('Codex (default)')
  expect(options.some((option) => option.value === 'codex')).toBe(false)
  expect(renderToStaticMarkup(<>{options[0]?.icon}</>)).toBe(
    renderToStaticMarkup(<>{issueAgentIcon('codex')}</>),
  )
  expect(issueAgentDefaultLabel('auto', undefined, 'codex')).toBe('Codex (default)')
})
