import { usePathname, useRouter } from 'expo-router'
import type { ReactNode } from 'react'
import { color } from '../theme/theme'
import { Icon } from './Icon'
import { Plus } from './icons'
import { HeaderButton } from './Screen'

/** Both entry points open the same native New Task compose sheet. */
export function NewWorkButton({
  size = 28,
  renderTrigger,
  repoPath,
}: {
  size?: 28 | 32 | 34
  renderTrigger?: (open: () => void) => ReactNode
  repoPath?: string | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const open = () =>
    router.push({
      pathname: '/new-issue',
      params: {
        backTo: pathname,
        ...(repoPath ? { repoPath } : {}),
      },
    })
  return renderTrigger ? (
    renderTrigger(open)
  ) : (
    <HeaderButton label="New work" onPress={open} size={size}>
      <Icon as={Plus} size={19} color={color.text} />
    </HeaderButton>
  )
}
