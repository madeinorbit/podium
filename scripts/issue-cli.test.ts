import { describe, expect, it, vi } from 'vitest'
import { parseIssueArgs, runIssueCli } from './issue-cli'

describe('parseIssueArgs', () => {
  it('parses the command, positionals, --flag value, --flag=value, and --bool', () => {
    const r = parseIssueArgs(['create', '--title', 'Fix login', '--priority=0', '--json'])
    expect(r.command).toBe('create')
    expect(r.args.title).toBe('Fix login')
    expect(r.args.priority).toBe('0')
    expect(r.args.json).toBe(true)
  })
})

describe('runIssueCli', () => {
  const client = {
    issues: { ready: { query: vi.fn(async () => [{ seq: 1, title: 'A', priority: 0 }]) } },
  } as any

  it('runs a known command and returns its text', async () => {
    const out = await runIssueCli(['ready', '--repoPath', '/r'], client)
    expect(out).toContain('A')
  })

  it('issue help lists the command names', async () => {
    const out = await runIssueCli(['help'], client)
    expect(out).toContain('ready')
    expect(out).toContain('create')
  })

  it('unknown command returns a helpful error', async () => {
    const out = await runIssueCli(['nope'], client)
    expect(out.toLowerCase()).toContain('unknown')
  })
})
