import { Stack } from 'expo-router/stack'
import { NewIssueScreen } from '../src/screens/NewIssueScreen'
import { color } from '../src/theme/theme'

export default function NewTaskRoute() {
  return (
    <>
      <Stack.Screen
        options={{
          presentation: 'formSheet',
          sheetAllowedDetents: [1],
          sheetGrabberVisible: false,
          title: 'New Task',
          contentStyle: { backgroundColor: color.groupedCard },
        }}
      />
      <NewIssueScreen />
    </>
  )
}
