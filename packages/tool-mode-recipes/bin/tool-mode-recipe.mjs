#!/usr/bin/env node
/**
 * `tool-mode-recipe` — the recipe authoring CLI (RCP-08).
 *
 * A thin argv/stdio wrapper over the compiled library, so the packed artifact
 * works under plain Node with no TypeScript loader.
 */

import { runRecipeCli } from '../lib/cli.js'

const exit = await runRecipeCli(process.argv.slice(2), {
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
})
process.exitCode = exit
