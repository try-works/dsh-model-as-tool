#!/usr/bin/env node
/**
 * The `dsh-tool-mode-credentials` executable (SEC-01).
 *
 * The HUMAN-ONLY credential surface: the model-visible `model_tools`
 * management action refuses generation (a generated secret must never enter a
 * model transcript), and this CLI is the operator's terminal instead. The
 * stream discipline is the stdio bridge's own: STDOUT carries the credential
 * (the secret exactly once) and nothing else; diagnostics and usage go to
 * stderr. The secret is never logged and never recoverable.
 */

import { runCredentialsCli } from '../lib/mcp/credential-cli.js'

const exit = runCredentialsCli(process.argv.slice(2), {
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
})

process.exit(exit)
