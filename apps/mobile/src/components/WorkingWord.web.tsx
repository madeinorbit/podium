import { memo, useInsertionEffect } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { color } from '../theme/theme'
import { type WorkingWordProps, workingWordPhase } from './WorkingWord.shared'

/** The mobile web deck uses desktop's compositor-only sweep and motion query. */
export const WorkingWord = memo(function WorkingWord({
  children,
  seed,
  active = true,
  style,
  numberOfLines,
  maxFontSizeMultiplier,
  glint = children,
}: WorkingWordProps) {
  const reduced = useReduceMotion()
  useInsertionEffect(() => {
    if (document.getElementById('deck-working-word-style')) return
    const sheet = document.createElement('style')
    sheet.id = 'deck-working-word-style'
    sheet.textContent = `
      .deck-word-window { position: absolute; inset: 0; width: 40%; overflow: hidden;
        opacity: .75; pointer-events: none; animation: deck-word-window 2.2s ease-in-out infinite; }
      .deck-word-copy { display: flex; flex-direction: column; width: 250%; animation: deck-word-copy 2.2s ease-in-out infinite; }
      @keyframes deck-word-window { 0% { transform: translateX(-100%); }
        66%, 100% { transform: translateX(250%); } }
      @keyframes deck-word-copy { 0% { transform: translateX(40%); }
        66%, 100% { transform: translateX(-100%); } }
      @media (prefers-reduced-motion: reduce) { .deck-word-window { display: none; } }
    `
    document.head.appendChild(sheet)
  }, [])
  const textProps = { numberOfLines, maxFontSizeMultiplier }
  const delay = `${workingWordPhase(seed) * -2.2}s`
  return (
    <View style={styles.word} testID={active ? 'working-word' : undefined} pointerEvents="none">
      <Text {...textProps} style={style}>
        {children}
      </Text>
      {active && !reduced ? (
        <span
          className="deck-word-window"
          aria-hidden="true"
          data-testid="working-word-glint"
          style={{ animationDelay: delay }}
        >
          <span className="deck-word-copy" style={{ animationDelay: delay }}>
            <Text {...textProps} style={[style, { color: color.text }]}>
              {glint}
            </Text>
          </span>
        </span>
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create({ word: { flexShrink: 1, minWidth: 0, overflow: 'hidden' } })
