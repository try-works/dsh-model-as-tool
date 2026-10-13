/**
 * `@try-works/tool-mode-contracts` — model-free standard tool contracts.
 *
 * This package contains no model bindings, no weights and no host code. It is the
 * shared vocabulary that the Tool Mode host registers, that MCP clients read, and
 * that extension packages implement against (DECL-01).
 *
 * @module @try-works/tool-mode-contracts
 */

export {
  assertValidContract,
  assertValidInput,
  assertValidOutput,
  ContractError,
  ContractViolationError,
  TOOL_META_SCHEMA,
  type ToolContract,
} from './registry.ts'

export { withMeta, type ExecutionLocation, type ToolMeta } from './meta.ts'

export {
  crossFieldRules,
  ProjectionError,
  projectToDsh,
  toDshParameters,
  type CrossFieldRule,
  type DshParameters,
  type DshProjection,
} from './dsh.ts'

export { sttTranscribe, STT_ADMITTED_FORMATS } from './contracts/stt-transcribe.ts'
export { langDetect } from './contracts/lang-detect.ts'

import { sttTranscribe } from './contracts/stt-transcribe.ts'
import { langDetect } from './contracts/lang-detect.ts'
import type { ToolContract } from './registry.ts'

/**
 * The standard contracts every Tool Mode host knows how to register.
 *
 * A host iterates this list; it does not switch on model names, which is what
 * ARCH-02 and EXT-01 require of model-independent code.
 */
export const STANDARD_CONTRACTS: readonly ToolContract[] = [sttTranscribe, langDetect]
