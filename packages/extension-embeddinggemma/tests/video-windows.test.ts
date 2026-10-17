import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { planMomentsWindows } from '../src/vectors.ts'
import { sampleVideoFrames } from '../src/media.ts'

/**
 * A minimal RIFF/AVI with uncompressed DIB frames (the same layout as the
 * embedding-real suite's generator, parameterized): solid-color 24 bpp frames
 * at the declared fps.
 */
function miniAvi(options: { seconds: number; fps: number; width: number; height: number }): { path: string; frames: number } {
  const { seconds, fps, width, height } = options
  const stride = Math.ceil((width * 3) / 4) * 4
  const frameBytes = stride * height
  const chunk = (id: string, payload: Buffer) => {
    const head = Buffer.alloc(8)
    head.write(id, 0, 'ascii')
    head.writeUInt32LE(payload.byteLength, 4)
    return Buffer.concat([head, payload, payload.byteLength % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)])
  }
  const movi: Buffer[] = []
  for (let i = 0; i < seconds * fps; i += 1) {
    const rows = Buffer.alloc(frameBytes)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const base = y * stride + x * 3
        rows.writeUInt8(i % 2 === 0 ? 40 : 220, base)
        rows.writeUInt8(80, base + 1)
        rows.writeUInt8(200, base + 2)
      }
    }
    movi.push(chunk('00db', rows))
  }
  const avih = Buffer.alloc(40)
  avih.writeUInt32LE(Math.round(1_000_000 / fps), 0)
  avih.writeUInt32LE(seconds * fps, 16)
  avih.writeUInt32LE(width, 32)
  avih.writeUInt32LE(height, 36)
  const strh = Buffer.alloc(56)
  strh.write('vids', 0, 'ascii')
  strh.write('DIB ', 4, 'ascii')
  strh.writeUInt32LE(seconds * fps, 20)
  strh.writeUInt32LE(Math.round(1_000_000 / fps), 24)
  const strf = Buffer.alloc(40)
  strf.writeUInt32LE(40, 0)
  strf.writeUInt32LE(width, 4)
  strf.writeUInt32LE(height, 8)
  strf.writeUInt16LE(1, 12)
  strf.writeUInt16LE(24, 14)
  strf.writeUInt32LE(0, 16)
  const hdrl = chunk('LIST', Buffer.concat([
    Buffer.from('hdrl', 'ascii'),
    chunk('avih', avih),
    chunk('LIST', Buffer.concat([Buffer.from('strl', 'ascii'), chunk('strh', strh), chunk('strf', strf)])),
  ]))
  const moviList = chunk('LIST', Buffer.concat([Buffer.from('movi', 'ascii'), ...movi]))
  const bytes = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('AVI ', 'ascii'), hdrl, moviList])
  const dir = mkdtempSync(join(tmpdir(), 'laya-moments-avi-'))
  const path = join(dir, 'clip.avi')
  writeFileSync(path, bytes)
  return { path, frames: seconds * fps }
}

test('planMomentsWindows: stride advance + the FINAL clipped window appears exactly once', () => {
  // 10 s at 3 s windows / 3 s stride -> windows [0,3), [3,6), [6,9) + the
  // clipped tail [7,10).
  const windows = planMomentsWindows(10, 3, 3, 256)
  assert.deepEqual(windows, [
    { start: 0, end: 3 },
    { start: 3, end: 6 },
    { start: 6, end: 9 },
    { start: 7, end: 10 },
  ])
  // An exact fit does NOT add a duplicate tail.
  assert.deepEqual(planMomentsWindows(9, 3, 3, 256), [
    { start: 0, end: 3 },
    { start: 3, end: 6 },
    { start: 6, end: 9 },
  ])
  // The per-call cap refuses rather than silently truncating (MOD-08).
  assert.throws(() => planMomentsWindows(100, 1, 1, 4), /over the 4-window limit/)
})

test('sampleVideoFrames(range) keeps the 1 fps samples inside the window only', async () => {
  const { path, frames } = miniAvi({ seconds: 4, fps: 8, width: 48, height: 48 })
  const whole = await sampleVideoFrames(path)
  assert.equal(whole.samples.length, 4) // 1 fps over 4 s
  assert.equal(whole.frames, frames)
  const windowed = await sampleVideoFrames(path, { startSeconds: 1, endSeconds: 2 })
  // The window [1,2) contains exactly the sample at t=1.
  assert.deepEqual(windowed.sampleTimestamps, [1])
  // The FULL container metadata is kept for the window planner.
  assert.equal(windowed.frames, whole.frames)
  // A range past the end clips to the reachable samples.
  const tail = await sampleVideoFrames(path, { startSeconds: 3.5, endSeconds: 9 })
  assert.deepEqual(tail.sampleTimestamps, [])
})
