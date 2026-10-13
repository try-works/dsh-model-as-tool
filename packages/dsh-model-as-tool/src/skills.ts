/**
 * Skill publication: teaches an agent when and how to use each model tool.
 *
 * A tool schema tells the model what it *can* call; a skill tells it when the
 * call is the right move, when it is the wrong one, and how the result should be
 * used downstream. This module renders one skill body per registered model from
 * the catalog plus that model's playbook entry.
 *
 * @module @try-works/dsh-model-as-tool/skills
 */

import type { ModelCatalogEntry } from './types.ts'
import type { ModelPlaybook } from './playbook.ts'

/**
 * Render the instruction body for one model's skill.
 *
 * The body is deliberately procedural: it names the tool, states the trigger
 * conditions, states the anti-triggers, and describes what to do with the
 * result. Sections with no content are omitted rather than rendered empty, so a
 * sparse playbook still produces a clean skill.
 * @param entry - the catalog entry.
 * @param playbook - the model's playbook, when one is authored.
 * @returns the markdown skill body.
 */
export function renderSkillBody(entry: ModelCatalogEntry, playbook?: ModelPlaybook): string {
  const lines: string[] = []
  lines.push(`# ${entry.name}`, '')
  lines.push(entry.summary, '')
  lines.push(`Call the \`${entry.tool.name}\` tool. ${entry.tool.returns}`, '')

  lines.push('## When to use', '')
  if (playbook !== undefined && playbook.whenToUse.length > 0) {
    for (const item of playbook.whenToUse) lines.push(`- ${item}`)
  } else if (entry.skill.whenToUse !== undefined) {
    lines.push(`- ${entry.skill.whenToUse}`)
  } else {
    lines.push(`- ${entry.summary}`)
  }
  lines.push('')

  if (playbook !== undefined && playbook.whenNotToUse.length > 0) {
    lines.push('## When not to use', '')
    for (const item of playbook.whenNotToUse) lines.push(`- ${item}`)
    lines.push('')
  }

  if (playbook !== undefined && playbook.useCases.length > 0) {
    lines.push('## Use cases', '')
    for (const item of playbook.useCases) lines.push(`- ${item}`)
    lines.push('')
  }

  lines.push('## Calling it', '')
  lines.push(`- Tool: \`${entry.tool.name}\``)
  lines.push(`- Primary input: ${entry.input}`)
  lines.push(`- Runs: ${describeRoute(entry)}`)
  lines.push('')
  for (const [name, param] of Object.entries(entry.tool.params)) {
    lines.push(`- \`${name}\` (${param.type ?? 'string'}): ${param.description}`)
  }
  lines.push('')

  if (playbook !== undefined && playbook.workflow.length > 0) {
    lines.push('## Workflow', '')
    playbook.workflow.forEach((step, index) => lines.push(`${index + 1}. ${step}`))
    lines.push('')
  }

  if (playbook !== undefined && playbook.pairsWith.length > 0) {
    lines.push('## Pairs with', '')
    for (const item of playbook.pairsWith) lines.push(`- ${item}`)
    lines.push('')
  }

  if (playbook !== undefined && playbook.caveats.length > 0) {
    lines.push('## Caveats', '')
    for (const item of playbook.caveats) lines.push(`- ${item}`)
    lines.push('')
  }

  lines.push('## Licensing', '')
  lines.push(
    `The ${entry.name} weights are licensed under the Desert Ant Labs Source-Available License `
    + `(https://license.desertant.com/1.0), not an open-source license. Inference is unlimited and free below `
    + '100,000 monthly active devices per platform per model; attribution is required and the models may not be '
    + 'redistributed or re-hosted as a service. Run it locally through this tool rather than proxying it to others.',
    '',
  )
  return lines.join('\n')
}

/** A short human description of how this model reaches its runtime. */
function describeRoute(entry: ModelCatalogEntry): string {
  switch (entry.windowsSupport) {
    case 'native-node':
      return `in-process through ${entry.npmPackage}`
    case 'onnxruntime-node':
      return `in-process through ${entry.npmPackage} with ${entry.requiresRuntime.join(', ')}`
    case 'browser-only':
      return `in-process through ${entry.npmPackage}${entry.npmSubpath ?? ''} on linux-x64, linux-arm64 and darwin-arm64`
    case 'apple-only':
      return 'on Apple platforms only, through the Swift SDK; not available to this process'
    case 'no-sdk':
      return 'nowhere yet: the weights are published but no SDK ships them'
    /* v8 ignore next -- closed union; a new member must fail compilation here. */
    default:
      return 'by an unspecified route'
  }
}
