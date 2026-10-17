import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const hostDir = dirname(dirname(fileURLToPath(import.meta.url)))
rmSync(join(hostDir, 'lib'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
console.log('build: cleaned lib')
