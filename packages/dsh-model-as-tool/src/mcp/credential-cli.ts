/**
 * The HUMAN-ONLY credential CLI (SEC-01).
 *
 * The model-visible `model_tools credentials` surface REFUSES generation: a
 * generated secret must never enter a model transcript. This module is the
 * operator's terminal instead — it generates over the durable store and prints
 * the secret EXACTLY ONCE to stdout, with the same stream discipline as the
 * stdio bridge: stdout carries the credential and nothing else; every
 * diagnostic goes to stderr. The secret is never logged, never persisted
 * anywhere beyond the owner-only store document, and cannot be recovered —
 * a lost secret is replaced by revoking and regenerating.
 *
 * Usage:
 *   dsh-tool-mode-credentials generate --scheme static-token --client-id <id>
 *   dsh-tool-mode-credentials generate --scheme oauth-resource-server --client-id <id> [--scope a,b,c]
 *   dsh-tool-mode-credentials list [--store <path>]
 *   dsh-tool-mode-credentials revoke --client-id <id> [--store <path>]
 *
 * Exit codes: 0 done; 1 the operation failed (corrupt store, duplicate id,
 * persistence failure); 2 usage.
 *
 * @module @try-works/dsh-model-as-tool/mcp/credential-cli
 */

import {
  createFileCredentialStore,
  defaultCredentialStoreFile,
  generateCredential,
  type CredentialScheme,
} from './credential-store.ts'

/** The two streams the CLI owns, so a test can capture them separately. */
export interface CliStreams {
  /** The credential output — stdout in production, never anything else. */
  out(line: string): void
  /** Diagnostics and usage — stderr in production. */
  err(line: string): void
}

const USAGE = [
  'usage:',
  '  dsh-tool-mode-credentials generate --scheme static-token --client-id <id>',
  '  dsh-tool-mode-credentials generate --scheme oauth-resource-server --client-id <id> [--scope a,b,c]',
  '  dsh-tool-mode-credentials list [--store <path>]',
  '  dsh-tool-mode-credentials revoke --client-id <id> [--store <path>]',
  'The generated secret is printed ONCE to stdout and is never echoed again;',
  'a lost secret is replaced by revoking the client and generating a new one.',
].join('\n')

/** Parse `--flag value` pairs; repeated flags keep the last value. */
function parseArgs(argv: readonly string[]): Map<string, string> {
  const pairs = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(token)}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`the flag ${token} needs a value`)
    pairs.set(token.slice(2), value)
    i += 1
  }
  return pairs
}

/**
 * Run the credential CLI.
 * @param argv - the process arguments, without the executable.
 * @param streams - the two streams (stdout/stderr in production).
 * @returns the process exit code.
 */
export function runCredentialsCli(argv: readonly string[], streams: CliStreams): number {
  const command = argv[0]
  let pairs: Map<string, string>
  try {
    pairs = parseArgs(argv.slice(1))
  } catch (error) {
    streams.err(error instanceof Error ? error.message : String(error))
    streams.err(USAGE)
    return 2
  }

  const storeFile = pairs.get('store') ?? defaultCredentialStoreFile()
  let store
  try {
    store = createFileCredentialStore(storeFile)
  } catch (error) {
    streams.err(`cannot open the credential store: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  if (command === 'generate') {
    const scheme = pairs.get('scheme')
    const clientId = pairs.get('client-id')
    if (scheme !== 'static-token' && scheme !== 'oauth-resource-server') {
      streams.err('generate requires --scheme static-token or --scheme oauth-resource-server')
      streams.err(USAGE)
      return 2
    }
    if (clientId === undefined || clientId.length === 0) {
      streams.err('generate requires --client-id')
      streams.err(USAGE)
      return 2
    }
    const scope = pairs.get('scope') === undefined
      ? undefined
      : pairs.get('scope')!.split(',').map(name => name.trim()).filter(name => name.length > 0)
    try {
      const generated = generateCredential(store, {
        clientId,
        scheme: scheme as CredentialScheme,
        ...scope === undefined ? {} : { scope },
      })
      // THE ONCE-ONLY OUTPUT. Nothing else in this process writes to stdout.
      streams.out('Generated credential (SEC-01).')
      streams.out(`clientId: ${generated.clientId}`)
      streams.out(`scheme: ${generated.scheme}`)
      streams.out(`scope: ${generated.scope.join(' ')}`)
      streams.out(`secret: ${generated.secret}`)
      streams.out('SHOWN ONCE: store the secret now. It is never echoed again and cannot be recovered;')
      streams.out('a lost secret is replaced by revoking this client and generating a new credential.')
      return 0
    } catch (error) {
      streams.err(`generation refused: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }

  if (command === 'list') {
    try {
      const entries = store.list()
      streams.out(`${entries.length} live client credential(s):`)
      for (const entry of entries) {
        streams.out(`- ${entry.clientId} (${entry.scheme}, ${entry.createdAt})`)
      }
      return 0
    } catch (error) {
      streams.err(`list failed: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }

  if (command === 'revoke') {
    const clientId = pairs.get('client-id')
    if (clientId === undefined || clientId.length === 0) {
      streams.err('revoke requires --client-id')
      streams.err(USAGE)
      return 2
    }
    try {
      const existed = store.get(clientId) !== undefined
      store.delete(clientId)
      streams.out(existed ? `revoked ${clientId}` : `no credential for ${clientId}; nothing to revoke`)
      return 0
    } catch (error) {
      streams.err(`revoke refused: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }

  streams.err(`unknown command ${JSON.stringify(command ?? '')}`)
  streams.err(USAGE)
  return 2
}
