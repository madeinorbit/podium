import { expect, it } from 'vitest'
import { claudeRecordToItems } from '../../../harness/src/adapters/claude-code/transcript'
import { transcriptSystemText } from './transcript-system-text'

it('hides the successful compaction stdout captured by the simulator', () => {
  expect(
    transcriptSystemText(
      'Compacted (ctrl+o to see full summary)\nPreCompact [http://127.0.0.1:45977/hooks/abc] completed successfully',
    ),
  ).toBe('')
})

it('filters the exact simulator stdout shape after the shared Claude reader removes its wrapper and ANSI', () => {
  const command = `if [ -z "home" ]; then ${'third-party-hook; '.repeat(130)}printf '{}'; fi`
  const lines = [
    'Compacted (ctrl+o to see full summary)',
    'PreCompact [http://127.0.0.1:45977/hooks/session] completed successfully: {}',
    `PostCompact [${command}] completed successfully: {}`,
    'PostCompact [http://127.0.0.1:45977/hooks/session] completed successfully: {}',
  ]
  const items = claudeRecordToItems({
    type: 'user',
    uuid: 'simulator-stdout',
    message: {
      role: 'user',
      content: `<local-command-stdout>${lines.map((line) => `\u001b[2m${line}\u001b[22m`).join('\n')}</local-command-stdout>`,
    },
  })
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ role: 'system', text: lines.join('\n') })
  expect(transcriptSystemText(items[0]?.text ?? '')).toBe('')
})

it('keeps failed hooks, error stdout and multiline failure details beside successful hooks', () => {
  const failed = 'PostCompact [third-party-hook] failed: exit 1\nError: failed to save context'
  expect(transcriptSystemText(`PreCompact [hook] completed successfully: {}\n${failed}`)).toBe(
    failed,
  )
  expect(
    transcriptSystemText('PostCompact [hook] completed successfully: Error: refused'),
  ).toContain('Error: refused')
  expect(transcriptSystemText('PreCompact [hook] completed successfully:\nError: refused')).toBe(
    'Error: refused',
  )
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
