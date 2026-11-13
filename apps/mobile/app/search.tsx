import { Redirect, useLocalSearchParams } from 'expo-router'
import {
  readWorkNavigation,
  type WorkRouteParams,
  workFilterParams,
} from '../src/screens/work-navigation'

/** Old search links open Work, retaining any saved Work query and lane. */
export default function SearchRedirect() {
  const params = useLocalSearchParams<WorkRouteParams>()
  return (
    <Redirect href={{ pathname: '/work', params: workFilterParams(readWorkNavigation(params)) }} />
  )
}
