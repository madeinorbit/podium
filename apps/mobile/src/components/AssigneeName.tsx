import { observer } from 'mobx-react-lite'
import { type StyleProp, Text, type TextStyle } from 'react-native'
import { memberDisplayName, useMemberRosterReader } from '../client/member-roster'

/**
 * WHO ELSE'S TASK THIS IS, ON A PHONE ROW (POD-6297, after POD-6294). On a
 * shared instance a row that belongs to another member names its assignee:
 * under All users on Tasks, and on the few rows of someone else's work the
 * viewer's personal Work list keeps (the owner badge). The viewer's own rows
 * carry no name, and a one-member instance shows none.
 *
 * `prefix` is the separator the row puts before the name (Work rows run their
 * facts together with a middle dot).
 */
export const AssigneeName = observer(function AssigneeName({
  assignee,
  prefix = '',
  style,
}: {
  assignee: string | null | undefined
  prefix?: string
  style?: StyleProp<TextStyle>
}) {
  const roster = useMemberRosterReader()
  if (!roster?.shared || !assignee || assignee === roster.currentMemberId) return null
  const name = memberDisplayName(roster, assignee)
  return (
    <Text style={style} numberOfLines={1} accessibilityLabel={`Assigned to ${name}`}>
      {`${prefix}${name}`}
    </Text>
  )
})
