#!/usr/bin/env node
/**
 * Reference Desert Ant bridge — run this on a machine that can execute the
 * models (an Apple silicon Mac for Title/Uhm, or any macOS/Linux box with the
 * Desert Ant CLI installed), and point the DSH plugin at it:
 *
 *   # on the Mac
 *   curl -fsSL https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-cli/main/install.sh | sh
 *   node desert-ant-bridge.mjs --token "$(openssl rand -hex 16)"
 *
 *   # in the DSH profile
 *   - id: model-tools
 *     config:
 *       remote:
 *         endpoint: http://mac-studio.local:8787
 *         token: <the token printed above>
 *
 * Contract (POST /invoke):
 *   { "model": "title", "verb": "title", "input": "<text or [paths]>", "options": { "max-tokens": "96" } }
 *   → 200 { "ok": true,  "result": <the CLI's JSON> }
 *   → 4xx { "ok": false, "error": "<message>" }
 *
 * GET /health → { ok: true, models: [...] } lists the verbs this host can run.
 *
 * SECURITY: this executes the Desert Ant CLI with arguments supplied by the
 * caller. It is meant for a trusted LAN, so it binds to loopback by default and
 * requires a bearer token. Do not expose it to the internet.
 *
 * LICENCE: the Desert Ant models are source-available and may not be re-hosted
 * as a service for others. Run this for yourself, on your own machines.
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const PORT = Number(flag('port', '8787'))
const HOST = flag('host', '127.0.0.1')
const TOKEN = flag('token', process.env.DESERT_ANT_BRIDGE_TOKEN ?? '')
const MAX_BODY = 8 * 1024 * 1024

/**
 * The CLI to drive. Normally just `desertant`, but a JSON array supplies fixed
 * leading arguments, which is what lets a wrapper be used — for example
 * `--cli '["node","/opt/desertant/cli.js"]'` or a version-manager shim.
 */
const cliSpec = flag('cli', 'desertant')
const CLI_ARGV = cliSpec.trimStart().startsWith('[') ? JSON.parse(cliSpec) : [cliSpec]
if (!Array.isArray(CLI_ARGV) || CLI_ARGV.length === 0 || CLI_ARGV.some(v => typeof v !== 'string')) {
  console.error('--cli must be a command name or a JSON array of strings')
  process.exit(2)
}
const [CLI, ...CLI_PREFIX] = CLI_ARGV

if (TOKEN.length === 0) {
  console.error('refusing to start without a token: pass --token <secret> or set DESERT_ANT_BRIDGE_TOKEN')
  process.exit(2)
}

/** Run the CLI with argv and resolve its exit code and output. */
function runCli(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI, [...CLI_PREFIX, ...argv], { shell: false })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => reject(new Error(`cannot run "${CLI}": ${error.message}`)))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/** Build the CLI argv from one request, mirroring the plugin's own mapping. */
function buildArgv(body) {
  const verb = body.verb
  if (typeof verb !== 'string' || !/^[a-z0-9-]+$/.test(verb)) {
    throw new Error('verb must be a lowercase model verb')
  }
  const inputs = Array.isArray(body.input) ? body.input : [body.input]
  if (inputs.length === 0 || inputs.some(value => typeof value !== 'string' || value.length === 0)) {
    throw new Error('input must be a non-empty string or a list of non-empty strings')
  }
  // `--` terminates option parsing so a path or text that begins with a dash is
  // never read as a flag.
  const argv = [verb, ...inputs]
  const options = body.options ?? {}
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('options must be an object')
  }
  for (const [key, value] of Object.entries(options)) {
    if (!/^[a-z0-9-]+$/.test(key)) throw new Error(`invalid option name "${key}"`)
    if (typeof value !== 'string') throw new Error(`option "${key}" must be a string`)
    argv.push('--option', `${key}=${value}`)
  }
  argv.push('--json', '--quiet')
  return argv
}

const server = createServer((request, response) => {
  const send = (status, payload) => {
    const body = JSON.stringify(payload)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    response.end(body)
  }

  if (request.method === 'GET' && request.url === '/health') {
    runCli(['models', '--json'])
      .then(outcome => send(200, { ok: outcome.code === 0, models: safeParse(outcome.stdout) }))
      .catch(error => send(500, { ok: false, error: error.message }))
    return
  }

  if (request.method !== 'POST' || !request.url?.startsWith('/invoke')) {
    send(404, { ok: false, error: 'POST /invoke' })
    return
  }

  const authorization = request.headers.authorization ?? ''
  if (authorization !== `Bearer ${TOKEN}`) {
    send(401, { ok: false, error: 'bad or missing bearer token' })
    return
  }

  let raw = ''
  let tooLarge = false
  request.setEncoding('utf8')
  request.on('data', (chunk) => {
    raw += chunk
    if (raw.length > MAX_BODY) {
      tooLarge = true
      request.destroy()
    }
  })
  request.on('end', async () => {
    if (tooLarge) {
      send(413, { ok: false, error: 'body too large' })
      return
    }
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      send(400, { ok: false, error: 'body must be JSON' })
      return
    }
    let argv
    try {
      argv = buildArgv(body)
    } catch (error) {
      send(400, { ok: false, error: error.message })
      return
    }
    try {
      const outcome = await runCli(argv)
      if (outcome.code !== 0) {
        // The CLI's own stderr is the most useful message; it already
        // distinguishes a runtime failure (1) from a usage error (64).
        send(502, { ok: false, error: `exit ${outcome.code}: ${outcome.stderr.trim() || 'no detail'}` })
        return
      }
      const result = safeParse(outcome.stdout)
      if (result === undefined) {
        send(502, { ok: false, error: 'the CLI produced no JSON on stdout' })
        return
      }
      send(200, { ok: true, result })
    } catch (error) {
      send(500, { ok: false, error: error.message })
    }
  })
})

/** Parse JSON, or undefined when the text is not JSON. */
function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

server.listen(PORT, HOST, () => {
  console.log(`desert-ant bridge listening on http://${HOST}:${PORT}`)
  console.log(`  CLI:   ${[CLI, ...CLI_PREFIX].join(' ')}`)
  console.log('  POST /invoke   (Authorization: Bearer <token>)')
  console.log('  GET  /health')
})
