import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

/**
 * THE SOURCE EDITOR'S THEME [POD-788].
 *
 * Every colour here is a `var(--syntax-*)` read straight from the shell's theme
 * (index.css, "Syntax channel"), so the editor follows light/dark and every
 * preset with NO JavaScript in the loop: no theme hook, no reconfiguration, no
 * remount when the operator flips the switch — the browser recomputes the
 * cascade and the code changes colour. That is also why this is one extension
 * rather than a light one and a dark one; there is nothing mode-specific left in
 * it to fork.
 *
 * What it replaces: CodeMirror's stock `defaultHighlightStyle`, which is a
 * light-background palette (#708 keywords, #a11 strings) that `basicSetup` was
 * painting unchanged onto our near-black ground — saturated primaries at 13px
 * over navy, with no relationship to anything else in the window.
 */

/** Token colours. Order matters: CodeMirror resolves the FIRST matching rule,
 *  so the specific tags (a definition's name, a control keyword) precede the
 *  broad ones they are a kind of. */
const highlight = HighlightStyle.define([
  // Prose in a code file reads as prose — one tier below body ink, italic.
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: 'var(--syntax-comment)',
    fontStyle: 'italic',
  },
  { tag: [t.docComment, t.docString], color: 'var(--syntax-comment)', fontStyle: 'italic' },

  // Structure stays out of the way: a comma carries no information.
  {
    tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace, t.squareBracket],
    color: 'var(--syntax-punct)',
  },
  {
    tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.compareOperator],
    color: 'var(--syntax-operator)',
  },

  // The one hue the chrome never spends, so it can mean "keyword" outright.
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.moduleKeyword,
      t.operatorKeyword,
      t.definitionKeyword,
      t.modifier,
    ],
    color: 'var(--syntax-keyword)',
  },
  { tag: [t.self, t.null, t.atom], color: 'var(--syntax-keyword)' },

  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syntax-string)' },
  // Literals take the brand hue at document strength — sand, not yellow.
  { tag: [t.number, t.integer, t.float, t.bool, t.unit], color: 'var(--syntax-number)' },
  { tag: [t.escape, t.character], color: 'var(--syntax-number)' },

  // Call sites and definitions carry the activity blue.
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName],
    color: 'var(--syntax-function)',
  },
  {
    tag: [t.definition(t.function(t.variableName))],
    color: 'var(--syntax-function)',
    fontWeight: '600',
  },

  {
    tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)],
    color: 'var(--syntax-type)',
  },
  { tag: [t.propertyName, t.attributeName], color: 'var(--syntax-property)' },
  // A name being INTRODUCED is worth half a weight; a name being used is not.
  {
    tag: [t.definition(t.variableName), t.definition(t.propertyName)],
    color: 'var(--syntax-ink)',
    fontWeight: '600',
  },
  { tag: [t.variableName, t.constant(t.variableName)], color: 'var(--syntax-ink)' },

  // Markup: tags borrow the terracotta the shell already uses for an agent.
  { tag: [t.tagName, t.angleBracket], color: 'var(--syntax-tag)' },
  { tag: [t.heading], color: 'var(--syntax-function)', fontWeight: '600' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '600' },
  { tag: [t.link, t.url], color: 'var(--syntax-function)', textDecoration: 'underline' },
  { tag: [t.strikethrough], textDecoration: 'line-through' },
  { tag: [t.monospace], color: 'var(--syntax-string)' },
  { tag: [t.meta, t.processingInstruction], color: 'var(--syntax-comment)' },

  { tag: [t.invalid], color: 'var(--syntax-invalid)' },
])

/**
 * Editor chrome: type, gutter, selection, cursor.
 *
 * The GUTTER carries no fill and no rule. CodeMirror's default paints it as a
 * second panel with its own border, which on a file already framed by a tab
 * strip and a path bar is a third vertical line in 40 pixels; here it is only
 * dimmer ink in the same ground, and the active line's number comes up to full
 * strength instead — which is the thing you actually look for.
 */
const chrome = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--syntax-ink)',
    fontSize: 'var(--code-type, 15px)',
    height: '100%',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: 'var(--code-leading, 1.7)',
    // The first line should not sit against the path bar, and the last should be
    // scrollable clear of the bottom edge.
    paddingBlock: '10px',
  },
  '.cm-content': {
    caretColor: 'var(--syntax-cursor)',
    // Reading measure, not a stripe: a 15px line wants air on both sides of it.
    paddingInline: '4px 16px',
  },
  '.cm-line': { paddingInline: '6px' },
  '.cm-cursor, .cm-dropCursor': {
    borderLeft: '2px solid var(--syntax-cursor)',
  },
  // CodeMirror renders its own selection layer when the DOM one is unavailable;
  // both spellings need the colour or a selection goes invisible in one of them.
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--syntax-selection)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--syntax-active-line)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--syntax-gutter)',
    border: 'none',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-lineNumbers .cm-gutterElement': { paddingInline: '14px 10px', minWidth: '0' },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--syntax-gutter-active)',
  },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--syntax-punct)' },
  '.cm-selectionMatch, .cm-searchMatch': { backgroundColor: 'var(--syntax-match)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--syntax-selection)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'transparent',
    color: 'var(--syntax-keyword)',
    outline: '1px solid var(--syntax-punct)',
  },
  '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': {
    color: 'var(--syntax-invalid)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--bar)',
    color: 'var(--foreground)',
    borderColor: 'var(--border)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-foreground)',
  },
})

/** Theme + highlighting, in the order CodeMirror wants them: appended AFTER
 *  `basicSetup` so both win over its stock light-background defaults. */
export const editorTheme: Extension[] = [chrome, syntaxHighlighting(highlight)]
