#!/usr/bin/env node
/**
 * The `dsh-tool-mode` executable (EXT-31).
 *
 * A thin shim: it wires real process streams into the tested CLI and translates
 * the returned code into an exit status. All the logic lives in the library, so
 * every path — including the refusals — is exercised by tests rather than only by
 * running the binary by hand.
 */

import { runToolModeCli } from '../lib/cli.js'

const code = await runToolModeCli(
  process.argv.slice(2),
  {
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
  },
)
process.exitCode = code
