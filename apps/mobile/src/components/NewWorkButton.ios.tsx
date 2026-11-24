import { useNavigation, usePathname } from 'expo-router'
import type { NavigationProp } from 'expo-router/react-navigation'
import type { ReactNode } from 'react'
import { color } from '../theme/theme'
import { Icon } from './Icon'
import { Plus } from './icons'
import { HeaderButton } from './Screen'

type ComposeRoutes = { 'new-issue': { backTo: string; repoPath?: string } }

/** Use the mounted root stack, before Expo's global navigation ref is published.
 * Its imperative routing queue otherwise consumes early taps with a null ref. */
export function NewWorkButton({
  size = 28,
  renderTrigger,
  repoPath,
}: {
  size?: 28 | 32 | 34
  renderTrigger?: (open: (tappedRepoPath?: string) => void) => ReactNode
  repoPath?: string | null
}) {
  const navigation = useNavigation<NavigationProp<ComposeRoutes>>('/')
  const pathname = usePathname()
  const open = (tappedRepoPath?: string) => {
    const project = tappedRepoPath ?? repoPath
    navigation.navigate('new-issue', {
      backTo: pathname,
      ...(project ? { repoPath: project } : {}),
    })
  }
  return renderTrigger ? (
    renderTrigger(open)
  ) : (
    <HeaderButton label="New work" onPress={() => open()} size={size}>
      <Icon as={Plus} size={19} color={color.text} />
    </HeaderButton>
  )
}
