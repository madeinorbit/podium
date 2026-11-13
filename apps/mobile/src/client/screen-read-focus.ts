import { useStoreHandle } from '@podium/client-core/react'
import type { IssueId, SessionId } from '@podium/model'
import { NavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext'
import { useContext, useLayoutEffect } from 'react'
import { useProjectionFocus } from './projection-focus'

/** Phone routes supply the current task/session focus. */
export const noScreenFocus = () => null

/** Focus includes the parent tab and the top stack route. Read the navigator
 * again at acknowledgement time, even if native freeze delays a React commit.
 * AppState visibility remains the shared runtime's existing platform input. */
export function useScreenReadFocus(
  issueId?: string,
  sessionId?: SessionId,
  mode: 'chat' | 'native' = 'chat',
): void {
  const owner = useStoreHandle()
  const navigation = useContext(NavigationContext)
  const focused = useProjectionFocus()
  useLayoutEffect(() => {
    if (!navigation || !focused || (!issueId && !sessionId)) return
    let release: (() => void) | undefined
    const blur = () => {
      release?.()
      release = undefined
    }
    const focus = () => {
      if (release || !navigation.isFocused()) return
      release = owner.attachScreenFocus(
        () =>
          navigation.isFocused()
            ? {
                ...(issueId ? { issueId: issueId as IssueId } : {}),
                ...(sessionId ? { focusedSessionId: sessionId } : {}),
              }
            : null,
        mode,
      )
    }
    const offFocus = navigation.addListener('focus', focus)
    const offBlur = navigation.addListener('blur', blur)
    focus()
    return () => {
      offFocus()
      offBlur()
      blur()
    }
  }, [owner, navigation, focused, issueId, sessionId, mode])
}
