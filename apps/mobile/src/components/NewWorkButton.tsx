import { useRouter } from 'expo-router'
import { Plus } from 'lucide-react-native'
import { color } from '../theme/theme'
import { Icon } from './Icon'
import { HeaderButton } from './Screen'

/** Every root-screen New Work control enters the same full New Session flow. */
export function NewWorkButton() {
  const router = useRouter()
  return (
    <HeaderButton label="New work" onPress={() => router.push('/new-session')}>
      <Icon as={Plus} size={19} color={color.text} />
    </HeaderButton>
  )
}
