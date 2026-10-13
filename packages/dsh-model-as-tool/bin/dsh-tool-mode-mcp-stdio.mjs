#!/usr/bin/env node
/**
 * The `dsh-tool-mode-mcp-stdio` executable (MCP-03, P26-08).
 *
 * This file owns the one property that cannot be tested from the library: that
 * STDOUT CARRIES PROTOCOL TRAFFIC AND NOTHING ELSE. Everything written here goes
 * through two explicitly separate streams, and nothing in this process writes to
 * stdout except a protocol frame — not a banner, not a version, not a warning.
 *
 * The endpoint and token come from the environment, which is how an MCP client
 * launches a stdio server. A missing token is reported on STDERR and the process
 * exits non-zero: an unattended launch must fail with guidance rather than hang
 * waiting for a credential nobody will supply (P26-16).
 */

import { createStdioBridge } from '../lib/mcp/stdio.js'

const url = process.env.DSH_TOOL_MODE_MCP_URL ?? 'http://127.0.0.1:3765/mcp'
const token = process.env.DSH_TOOL_MODE_MCP_TOKEN

/** Diagnostics. NEVER stdout. */
const diagnostic = line => process.stderr.write(`${line}\n`)

if (token === undefined || token.length === 0) {
  // P26-16: unattended operation must fail with setup guidance, never hang.
  diagnostic('dsh-tool-mode-mcp-stdio: no credential configured.')
  diagnostic('  Set DSH_TOOL_MODE_MCP_TOKEN to the token the operator configured for this client,')
  diagnostic('  and DSH_TOOL_MODE_MCP_URL if the endpoint is not http://127.0.0.1:3765/mcp.')
  process.exit(2)
}

const bridge = createStdioBridge(
  {
    url,
    token,
    fetch: async (target, init) => {
      const response = await fetch(target, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal,
      })
      const headers = {}
      response.headers.forEach((value, key) => { headers[key] = value })
      return { status: response.status, headers, body: await response.text() }
    },
  },
  {
    // The ONLY writer to stdout in this process.
    protocol: line => process.stdout.write(`${line}\n`),
    diagnostic,
  },
)

// Newline-delimited input. Chunk boundaries are not frame boundaries, so a partial
// line is buffered until its newline arrives.
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    void bridge.handleLine(line).then(output => {
      if (output !== undefined) process.stdout.write(`${output}\n`)
    }).catch(error => {
      // A bridge fault is a diagnostic; the protocol channel stays clean.
      diagnostic(`bridge error: ${error instanceof Error ? error.message : String(error)}`)
    })
    index = buffer.indexOf('\n')
  }
})

process.stdin.on('end', () => {
  // P26-08: EOF shuts down BRIDGE-OWNED requests without killing the shared host.
  bridge.close()
  diagnostic('stdin closed; bridge-owned requests aborted')
  process.exit(0)
})
