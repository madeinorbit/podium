import { expect, it } from 'vitest'
import { transcriptSystemText } from './transcript-system-text'

it('hides the successful compaction stdout captured by the simulator', () => {
  expect(
    transcriptSystemText(
      'Compacted (ctrl+o to see full summary)\nPreCompact [http://127.0.0.1:45977/hooks/abc] completed successfully',
    ),
  ).toBe('')
})

it('keeps hook failures and other command output, including mixed output', () => {
  expect(
    transcriptSystemText('PreCompact [hook.sh] completed successfully\nError: hook failed'),
  ).toBe('Error: hook failed')
  expect(transcriptSystemText('PreCompact [hook.sh] failed\nA stop hook halted the agent')).toBe(
    'PreCompact [hook.sh] failed\nA stop hook halted the agent',
  )
  expect(
    transcriptSystemText('The PreCompact [hook.sh] completed successfully example.'),
  ).toContain('example.')
})
