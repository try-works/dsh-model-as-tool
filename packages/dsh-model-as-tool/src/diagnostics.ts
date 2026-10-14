/**
 * The settings/diagnostic surface (OBS-04).
 *
 * OBS-04 names, item by item, what an operator must be able to SEE. A surface that answers
 * "is it on?" but not "which client may call what, and exactly why is this not supported here?"
 * leaves an operator guessing, so each item below is reported with the fact that makes it
 * actionable rather than a bare boolean.
 *
 * DESIGN CONSTRAINTS, because a diagnostic surface is unusually easy to get wrong:
 *
 *  - **It reports STATE, never credentials.** It names authorized clients and grants; it
 *    never echoes a token. A diagnostic surface is the single most likely place for a secret
 *    to leak, because its whole purpose is to be displayed.
 *  - **Unsupported is always paired with WHY.** OBS-04 asks for "exact unsupported-platform
 *    reasons", and a bare `supported: false` sends an operator to the source to find out.
 *  - **Unknown is its own state.** A fact that cannot be determined is reported as unknown
 *    rather than defaulted to false, because "not supported" and "not checked" call for
 *    different actions.
 *
 * @module @try-works/dsh-model-as-tool/diagnostics
 */

/** One capability this deployment either has, lacks, or has not determined. */
export interface CapabilityReport {
  /** The capability, in the vocabulary OBS-04 uses. */
  readonly capability: string
  /** Whether it is available HERE. */
  readonly state: 'available' | 'unavailable' | 'unknown'
  /**
   * Why, whenever the state is not `available`.
   *
   * Never omitted for `unavailable`: an operator cannot act on a fact they cannot explain,
   * and OBS-04 asks for the EXACT reason.
   */
  readonly reason?: string
}

/** Inputs the surface reports on. */
export interface DiagnosticInputs {
  /** Whether the MCP surface is mounted. */
  readonly mcpMounted: boolean
  /** Where it listens, when it does. */
  readonly mcpEndpoint?: string
  /** Whether the endpoint requires a credential. */
  readonly mcpRequiresCredential?: boolean
  /** Client identities currently authorized, if the deployment tracks them. */
  readonly authorizedClients?: readonly string[]
  /** Tool names exported to clients. */
  readonly exportedTools: readonly string[]
  /** Tools registered on the host but deliberately NOT exported. */
  readonly withheldTools?: readonly string[]
  /** Per-model preparation state. */
  readonly preparation?: readonly { readonly modelId: string; readonly prepared: boolean; readonly reason?: string }[]
  /** The implementation each contract currently resolves to. */
  readonly selectedImplementations?: readonly { readonly contractId: string; readonly implementationId: string }[]
  /** Installed extensions and whether they are active. */
  readonly extensions?: readonly { readonly extensionId: string; readonly version: string; readonly activation: string }[]
  /** Whether the deployment can remove an extension, and whether it protects built-ins. */
  readonly uninstall?: { readonly available: boolean; readonly builtInsProtected: boolean; readonly reason?: string }
  /** Location and network requirements. */
  readonly requirements?: { readonly localOnly: boolean; readonly networkOrigins: readonly string[] }
  /** Code Mode permission and backend readiness. */
  readonly codeMode?: { readonly permitted: boolean; readonly backendReady: boolean; readonly reason?: string }
  /** Platform facts, so an unsupported reason can name the platform it refers to. */
  readonly platform: { readonly os: string; readonly arch: string; readonly nodeVersion: string }
}

/** The reported surface. */
export interface DiagnosticReport {
  readonly platform: DiagnosticInputs['platform']
  readonly mcp: {
    readonly mounted: boolean
    readonly endpoint: string | null
    readonly requiresCredential: boolean | null
    readonly authorizedClients: readonly string[]
    readonly exportedTools: readonly string[]
    readonly withheldTools: readonly string[]
  }
  readonly preparation: readonly { readonly modelId: string; readonly prepared: boolean; readonly reason: string | null }[]
  readonly implementations: readonly { readonly contractId: string; readonly implementationId: string }[]
  readonly extensions: readonly { readonly extensionId: string; readonly version: string; readonly activation: string }[]
  readonly capabilities: readonly CapabilityReport[]
  readonly uninstall: DiagnosticInputs['uninstall'] | null
  readonly requirements: DiagnosticInputs['requirements'] | null
  readonly codeMode: DiagnosticInputs['codeMode'] | null
}

/**
 * Build the diagnostic report.
 *
 * @param inputs - the observed state.
 * @returns everything OBS-04 names, with a reason wherever something is not available.
 */
export function buildDiagnostics(inputs: DiagnosticInputs): DiagnosticReport {
  const capabilities: CapabilityReport[] = [
    inputs.mcpMounted
      ? { capability: 'mcp', state: 'available' }
      : {
        capability: 'mcp',
        state: 'unavailable',
        reason: 'no MCP surface is mounted in this deployment, so no client can call these tools',
      },
    /*
     * The endpoint is reported separately from `mcp` because a mounted surface with no
     * endpoint is a real state: the host composes tools for its own agent and serves nothing.
     */
    inputs.mcpEndpoint === undefined
      ? { capability: 'mcp-endpoint', state: 'unavailable', reason: 'the mounted MCP surface exposes no network endpoint' }
      : { capability: 'mcp-endpoint', state: 'available' },
    inputs.mcpRequiresCredential === true
      ? { capability: 'mcp-authorization', state: 'available' }
      : inputs.mcpRequiresCredential === false
        ? {
          capability: 'mcp-authorization',
          state: 'unavailable',
          reason: 'the endpoint accepts unauthenticated requests, so any local caller may invoke these tools',
        }
        // `unknown` rather than `false`: a fact that was not determined is not a fact that is
        // absent, and the two call for different actions.
        : { capability: 'mcp-authorization', state: 'unknown', reason: 'the deployment did not report whether a credential is required' },
  ]

  if (inputs.codeMode !== undefined) {
    capabilities.push(inputs.codeMode.permitted && inputs.codeMode.backendReady
      ? { capability: 'code-mode', state: 'available' }
      : {
        capability: 'code-mode',
        state: 'unavailable',
        reason: inputs.codeMode.reason
          ?? (inputs.codeMode.permitted
            ? 'generated-code execution is permitted but no backend is ready to run it'
            : 'generated-code execution is not permitted in this deployment'),
      })
  }

  return {
    platform: inputs.platform,
    mcp: {
      mounted: inputs.mcpMounted,
      endpoint: inputs.mcpEndpoint ?? null,
      requiresCredential: inputs.mcpRequiresCredential ?? null,
      authorizedClients: [...(inputs.authorizedClients ?? [])],
      exportedTools: [...inputs.exportedTools],
      withheldTools: [...(inputs.withheldTools ?? [])],
    },
    preparation: (inputs.preparation ?? []).map(entry => ({
      modelId: entry.modelId,
      prepared: entry.prepared,
      // A prepared model has nothing to explain; an unprepared one must say what is missing.
      reason: entry.prepared ? null : entry.reason ?? 'no reason was reported, which is itself a defect in the caller',
    })),
    implementations: [...(inputs.selectedImplementations ?? [])],
    extensions: [...(inputs.extensions ?? [])],
    capabilities,
    uninstall: inputs.uninstall ?? null,
    requirements: inputs.requirements ?? null,
    codeMode: inputs.codeMode ?? null,
  }
}

/**
 * The exact reason something is unsupported on THIS platform.
 *
 * Exists as a function because OBS-04 asks for the reason to be EXACT, and an exact reason has
 * to name the platform it is about — "unsupported" against an unnamed platform sends an
 * operator to compare their machine against a document.
 *
 * @param subject - what is unsupported.
 * @param supportedOn - the platforms it does work on.
 * @param platform - the platform being reported.
 * @returns a reason naming both sides of the mismatch.
 */
export function unsupportedReason(
  subject: string,
  supportedOn: readonly { readonly os: string; readonly arch: string }[],
  platform: { readonly os: string; readonly arch: string },
): string {
  const supported = supportedOn.map(entry => `${entry.os}/${entry.arch}`)
  if (supported.length === 0) {
    // A different sentence, because "no platform supports this" is not a mismatch.
    return `${subject} declares no supported platform, so it cannot run anywhere`
  }
  return `${subject} supports ${supported.join(', ')} but this host is ${platform.os}/${platform.arch}`
}

/**
 * Whether the deployment may retain request and response BODIES (OBS-03).
 *
 * OBS-03's operative sentence is a refusal, not a preference: where an operator's no-retention
 * policy cannot be honoured together with DSH's requirement that model-visible inputs be
 * reconstructable, harness-backed execution must be REFUSED rather than bodies silently
 * logged or DSH bypassed. This returns the decision so the caller cannot soften it into a
 * warning.
 *
 * @param policy - the deployment's retention policy.
 * @returns whether harness-backed execution is permitted.
 */
export function harnessExecutionDecision(
  policy: { readonly retainsBodies: boolean; readonly requiresReconstructableInputs: boolean },
): { readonly permitted: boolean; readonly reason?: string } {
  if (!policy.retainsBodies && policy.requiresReconstructableInputs) {
    return {
      permitted: false,
      reason:
        'the deployment does not retain bodies while DSH requires model-visible inputs to be '
        + 'reconstructable, so harness-backed execution is refused here rather than logging '
        + 'bodies against the policy or bypassing DSH',
    }
  }
  return { permitted: true }
}
