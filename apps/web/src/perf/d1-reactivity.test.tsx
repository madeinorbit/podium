import { act, cleanup, render } from '@testing-library/react'
import { registerProofSuite } from '../../../../packages/client-core/proofs/d1/suite'
registerProofSuite('web', { act, cleanup, render })
