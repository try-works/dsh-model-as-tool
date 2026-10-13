/** Print what each standard contract advertises vs enforces only at runtime. */
import { projectToDsh, STANDARD_CONTRACTS } from '../packages/tool-mode-contracts/src/index.ts'

for (const contract of STANDARD_CONTRACTS) {
  const projection = projectToDsh(contract)
  console.log(`${contract.toolName}:`)
  console.log(`  advertised      : ${Object.keys(projection.parameters).join(', ')}`)
  console.log(`  runtime-enforced: ${projection.runtimeEnforced.join(', ') || '(none)'}`)
  const required = Object.entries(projection.parameters)
    .filter(([, value]) => value.required === true)
    .map(([name]) => name)
  console.log(`  required        : ${required.join(', ') || '(none)'}`)
}
