import { describe, expect, it } from 'vitest'

import { elidePathHead, looksLikePath, NOTICE_PATH_CHARS } from './notice-path'

const WORKTREE = '/home/podium/podium/.worktrees/issue-1155-composer-focus-hint-shortcut'

describe('looksLikePath', () => {
  it('accepts the shapes a worktree destination actually arrives in', () => {
    expect(looksLikePath(WORKTREE)).toBe(true)
    expect(looksLikePath('/')).toBe(true)
    expect(looksLikePath('~/podium')).toBe(true)
    expect(looksLikePath('C:\\Users\\podium\\podium')).toBe(true)
    expect(looksLikePath('C:/Users/podium/podium')).toBe(true)
  })

  it('rejects the prose descriptions that share the surface', () => {
    // Both of these are real toast descriptions (BrowserOpenOverlay).
    expect(looksLikePath('Review the destination before opening it in your browser.')).toBe(false)
    expect(looksLikePath('Allow popups for Podium, then retry Open.')).toBe(false)
  })

  it('rejects a path with whitespace rather than guess', () => {
    // A sentence that opens with a slash is far likelier than a path with a
    // space in it, and getting this wrong sets prose in monospace.
    expect(looksLikePath('/home/podium/my worktree')).toBe(false)
  })

  it('rejects a relative path — only an absolute one is a destination', () => {
    expect(looksLikePath('apps/web/src')).toBe(false)
    expect(looksLikePath('./apps')).toBe(false)
  })
})

describe('elidePathHead', () => {
  it('leaves a path that already fits completely alone', () => {
    expect(elidePathHead('/home/podium/podium', 56)).toBe('/home/podium/podium')
  })

  it('cuts at a separator, never mid-segment', () => {
    const out = elidePathHead(WORKTREE, 56)
    expect(out).toBe('…/.worktrees/issue-1155-composer-focus-hint-shortcut')
    expect(out.length).toBeLessThanOrEqual(56)
    // Every surviving segment is whole — the defect this replaces was
    // "…odium/podium/.worktrees/…", a path cut through the middle of a word.
    for (const seg of out.replace('…/', '').split('/')) {
      expect(WORKTREE.split('/')).toContain(seg)
    }
  })

  it('keeps as many leading segments as the budget allows', () => {
    // A bigger budget buys back the segments a smaller one had to drop.
    expect(elidePathHead(WORKTREE, 68)).toBe(
      '…/podium/podium/.worktrees/issue-1155-composer-focus-hint-shortcut',
    )
  })

  it('falls back to the bare last segment when even that is over budget', () => {
    // CSS ellipsis is the backstop here; the helper must not return "…/" alone.
    expect(elidePathHead(WORKTREE, 10)).toBe('…/issue-1155-composer-focus-hint-shortcut')
  })

  it('defaults to the budget the toast box is sized for', () => {
    expect(elidePathHead(WORKTREE)).toBe(elidePathHead(WORKTREE, NOTICE_PATH_CHARS))
  })

  it('survives trailing and doubled separators', () => {
    expect(elidePathHead(`${WORKTREE}/`, 56)).toBe(
      '…/.worktrees/issue-1155-composer-focus-hint-shortcut',
    )
  })
})
