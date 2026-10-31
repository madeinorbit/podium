import { describe, expect, it } from 'vitest'
import { classifyMailCommand, countInboxNotes, mailReceipts, parseMailSent } from './mail-command'

describe('classifyMailCommand', () => {
  it('reads both send forms', () => {
    expect(classifyMailCommand(`podium mail send --to POD-2128 --body 'Landed the fix'`)).toEqual({
      op: 'send',
      to: 'issue:POD-2128',
      preview: 'Landed the fix',
    })
    expect(
      classifyMailCommand(
        `podium issue mail send pod-2128 --body "Ready for review" --outside-scope`,
      ),
    ).toEqual({ op: 'send', to: 'issue:POD-2128', preview: 'Ready for review' })
    expect(classifyMailCommand('podium mail send --to=#12 --expect-response --body=hi')).toEqual({
      op: 'send',
      to: 'issue:#12',
      preview: 'hi',
    })
    expect(classifyMailCommand('podium mail send --to 4f1c-9a --body x')).toMatchObject({
      to: 'session:4f1c-9a',
    })
  })

  it('reads a reply and both inbox forms', () => {
    expect(classifyMailCommand(`podium mail reply msg_ab12 --body 'done'`)).toEqual({
      op: 'reply',
      replyTo: 'msg_ab12',
      preview: 'done',
    })
    expect(classifyMailCommand('podium issue mail inbox')).toEqual({ op: 'inbox' })
    expect(classifyMailCommand('podium mail inbox --issue POD-3')).toEqual({ op: 'inbox' })
    expect(classifyMailCommand('cd /repo/wt && podium issue mail inbox 2>&1')).toEqual({
      op: 'inbox',
    })
  })

  it('keeps a body it cannot read out of the preview', () => {
    const heredoc = [
      `podium issue mail send POD-2140 --body "$(cat <<'EOF'`,
      'Handoff: all green',
      'EOF',
      ')"',
    ].join('\n')
    expect(classifyMailCommand(heredoc)).toEqual({ op: 'send', to: 'issue:POD-2140' })
    expect(classifyMailCommand('podium mail send --to POD-1 --body "$NOTE"')).toEqual({
      op: 'send',
      to: 'issue:POD-1',
    })
    expect(classifyMailCommand(`podium mail send --to POD-1 --body 'line one\nline two'`)).toEqual({
      op: 'send',
      to: 'issue:POD-1',
      preview: 'line one',
    })
    expect(
      classifyMailCommand(`podium mail send --to POD-1 --body 'it'\\''s ready; ship it && go'`),
    ).toEqual({ op: 'send', to: 'issue:POD-1', preview: "it's ready; ship it && go" })
  })

  it('reads past heredoc bodies inside a command substitution', () => {
    for (const body of ["it's done", 'one unmatched ( paren', 'a ) and a " too']) {
      const command = [
        `podium mail send --to POD-2140 --body "$(cat <<'EOF'`,
        body,
        'EOF',
        ')" --expect-response',
      ].join('\n')
      expect(classifyMailCommand(command), body).toEqual({ op: 'send', to: 'issue:POD-2140' })
    }
    expect(
      classifyMailCommand(`podium mail send --to POD-1 --body "$(cat <<'EOF'\nnever closed (\n)"`),
    ).toBeNull()
  })

  it('does not match look-alikes', () => {
    for (const command of [
      `echo 'podium mail send --to POD-1 --body x'`,
      `grep -rn "podium mail send" docs`,
      'podium mail show msg_1',
      'podium mail status msg_1',
      'podium issue mail claim msg_1',
      'podium issue mail send',
      'podium mail send --body x',
      'podium mail send --to "$TARGET" --body x',
      'podium issue mail reply msg_1 --body x',
      'podium mail inbox --help',
      'podium issue update --id 1 --stage review && podium issue mail send POD-1 --body x',
      'podium mail send --to POD-1 --body x | tee out.txt',
      'podiumx mail send --to POD-1 --body x',
      `podium mail send --to POD-1 --body 'unterminated`,
    ]) {
      expect(classifyMailCommand(command), command).toBeNull()
    }
  })
})

describe('parseMailSent', () => {
  it('reads the id and recipient each CLI prints', () => {
    expect(parseMailSent('sent msg_9 to POD-7 (delivered)')).toEqual({
      id: 'msg_9',
      to: 'issue:POD-7',
    })
    expect(parseMailSent('replied msg_4 to issue:POD-3 (acked msg_1)')).toEqual({
      id: 'msg_4',
      to: 'issue:POD-3',
    })
    expect(parseMailSent('sent msg_9 (delivered)')).toEqual({ id: 'msg_9' })
    expect(
      parseMailSent('mail QUEUED for POD-7 (msg_1) — on its way, NOT yet confirmed; …'),
    ).toEqual({ id: 'msg_1', to: 'issue:POD-7' })
    expect(parseMailSent('{"command":"send","ok":true,"data":{"id":"msg_2","ok":true}}')).toEqual({
      id: 'msg_2',
    })
    expect(parseMailSent('podium mail: send was not accepted')).toBeNull()
  })

  it('reads --json receipts, raw or inside a Codex result object, keeping a reply a reply', () => {
    const sent = JSON.stringify({ command: 'send', ok: true, data: { id: 'msg_2', ok: true } })
    const replied = JSON.stringify({
      command: 'reply',
      ok: true,
      data: { id: 'msg_3', ok: true, to: 'issue:POD-3' },
    })
    expect(mailReceipts(sent)).toEqual([{ id: 'msg_2', op: 'send' }])
    expect(mailReceipts(replied)).toEqual([{ id: 'msg_3', op: 'reply', to: 'issue:POD-3' }])
    const wrapped = `Script completed\nOutput:\n${JSON.stringify({ exit_code: 0, output: `${sent}\n` })}`
    expect(mailReceipts(wrapped)).toEqual([{ id: 'msg_2', op: 'send' }])
    expect(mailReceipts(JSON.stringify({ ok: false, error: 'not accepted' }))).toEqual([])
  })

  it('reads receipts out of Codex exec result objects', () => {
    // text(await tools.exec_command(…)) prints the result object.
    const object = `Script completed\nOutput:\n${JSON.stringify({
      exit_code: 0,
      output: 'sent msg_9 to POD-2140 (delivered)\n',
      wall_time: 0.4,
    })}`
    expect(parseMailSent(object)).toEqual({ id: 'msg_9', to: 'issue:POD-2140' })
    // text(result.output) prints the output itself.
    expect(parseMailSent('Script completed\nOutput:\nsent msg_9 to POD-2140 (delivered)')).toEqual({
      id: 'msg_9',
      to: 'issue:POD-2140',
    })
    // A call that exited non-zero has no receipt, whatever its output says.
    const failed = JSON.stringify({ exit_code: 1, output: 'sent msg_9 to POD-2140 (delivered)' })
    expect(parseMailSent(failed)).toBeNull()
    expect(
      mailReceipts('replied msg_4 to issue:POD-3 (acked msg_1)\nmail QUEUED for POD-7 (msg_5) — …'),
    ).toEqual([
      { id: 'msg_4', op: 'reply', to: 'issue:POD-3' },
      { id: 'msg_5', op: 'send', to: 'POD-7' },
    ])
  })
})

describe('countInboxNotes', () => {
  it('counts both inbox listings', () => {
    expect(
      countInboxNotes(
        'msg_1 issue:POD-2 -> session:s1\n  status: confirmed — …\n  captured=…\n' +
          'msg_2 superagent -> session:s1\n  status: confirmed — …',
      ),
    ).toBe(2)
    expect(
      countInboxNotes('* msg_1 agent:POD-2 2026-10-26T10:00:00Z\n  hello\n  msg_1 quoted'),
    ).toBe(1)
    expect(countInboxNotes('  msg_1 agent:POD-2 2026-10-26T10:00:00Z\n  hello')).toBe(1)
    expect(
      countInboxNotes(
        '  msg_1 agent:POD-2 2026-10-26T10:00:00Z\n  seen\n* msg_2 agent:POD-4 2026-10-26T10:01:00Z\n  new',
      ),
    ).toBe(2)
    expect(countInboxNotes('(no mail)')).toBe(0)
    expect(countInboxNotes('(no messages)')).toBe(0)
    expect(countInboxNotes('{"command":"inbox","ok":true,"data":[{},{}]}')).toBe(2)
    expect(countInboxNotes('podium: relay unavailable')).toBeUndefined()
  })
})
