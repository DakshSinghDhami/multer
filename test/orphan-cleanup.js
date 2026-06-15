/* eslint-env mocha */

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import { PassThrough } from 'node:stream'
import { promisify } from 'node:util'

import FormData from 'form-data'

import * as util from './_util.js'
import multer from '../index.js'

function getLength (form) {
  return promisify(form.getLength).call(form)
}

function createAbortStream (maxBytes, aborter, delay) {
  let bytesPassed = 0

  return new PassThrough({
    transform (chunk, _, cb) {
      if (bytesPassed + chunk.length < maxBytes) {
        bytesPassed += chunk.length
        this.push(chunk)
        return cb()
      }

      const bytesLeft = maxBytes - bytesPassed

      if (bytesLeft) {
        bytesPassed += bytesLeft
        this.push(chunk.slice(0, bytesLeft))
      }

      // Optionally wait before aborting so that any earlier file has time to
      // finish flushing to disk, exercising the "already-settled file" path.
      if (delay) {
        setTimeout(() => aborter(this), delay)
      } else {
        process.nextTick(() => aborter(this))
      }
    }
  })
}

function tmpSnapshot () {
  return new Set(fs.readdirSync(os.tmpdir()))
}

describe('Orphan file cleanup on abort/error', () => {
  it('should not leave orphan temp files when client aborts mid-upload', async () => {
    const before = tmpSnapshot()

    const form = new FormData()
    const parser = multer().single('file')

    form.append('file', util.file('large'))

    const length = await getLength(form)
    const req = createAbortStream(length - 100, (stream) => stream.emit('aborted'))

    req.headers = {
      'content-type': `multipart/form-data; boundary=${form.getBoundary()}`,
      'content-length': length
    }

    const result = promisify(parser)(form.pipe(req), null)

    await assert.rejects(result, (err) => err.code === 'CLIENT_ABORTED')

    await new Promise((resolve) => setTimeout(resolve, 200))

    const after = tmpSnapshot()
    const leaked = [...after].filter((name) => !before.has(name))

    assert.deepStrictEqual(leaked, [], `Orphan tmpfiles left after client abort: ${leaked.join(', ')}`)
  })

  it('should not leave orphan temp files when the request errors mid-upload', async () => {
    const before = tmpSnapshot()

    const form = new FormData()
    const parser = multer().single('file')

    form.append('file', util.file('large'))

    const length = await getLength(form)
    const req = createAbortStream(length - 100, (stream) => stream.emit('error', new Error('TEST_ERROR')))

    req.headers = {
      'content-type': `multipart/form-data; boundary=${form.getBoundary()}`,
      'content-length': length
    }

    const result = promisify(parser)(form.pipe(req), null)

    await assert.rejects(result, (err) => err.message === 'TEST_ERROR')

    await new Promise((resolve) => setTimeout(resolve, 200))

    const after = tmpSnapshot()
    const leaked = [...after].filter((name) => !before.has(name))

    assert.deepStrictEqual(leaked, [], `Orphan tmpfiles left after request error: ${leaked.join(', ')}`)
  })

  it('should not leave orphan temp files for files already written when a later file aborts', async () => {
    const before = tmpSnapshot()

    const form = new FormData()
    const parser = multer().array('file', 2)

    // First file is small and finishes writing to disk; the second is large
    // and the request errors midway through it.
    form.append('file', util.file('small'))
    form.append('file', util.file('large'))

    const length = await getLength(form)
    const req = createAbortStream(length - 100, (stream) => stream.emit('error', new Error('TEST_ERROR')), 60)

    req.headers = {
      'content-type': `multipart/form-data; boundary=${form.getBoundary()}`,
      'content-length': length
    }

    const result = promisify(parser)(form.pipe(req), null)

    await assert.rejects(result, (err) => err.message === 'TEST_ERROR')

    await new Promise((resolve) => setTimeout(resolve, 200))

    const after = tmpSnapshot()
    const leaked = [...after].filter((name) => !before.has(name))

    assert.deepStrictEqual(leaked, [], `Orphan tmpfiles left for already-written file: ${leaked.join(', ')}`)
  })
})
