import { plainFamilyProcedures } from '../plain-command/family'
import { HARNESS_INSTALL_FAMILY } from './install-actions'
export const harnessInstallProcedures = () => plainFamilyProcedures(HARNESS_INSTALL_FAMILY, {})
