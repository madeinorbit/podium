/**
 * Bun userland polyfill so `node-pty` can read the PTY master under `bun --bun`.
 *
 * node-pty sets O_NONBLOCK on the master fd then wraps it in `new tty.ReadStream(fd)`.
 * Under Node, `tty.ReadStream` extends `net.Socket` and uses libuv polling — it never
 * sees EAGAIN and never owns the fd. Under Bun ≤1.3.14, `tty.ReadStream` is backed by
 * `fs.ReadStream`; threadpool `fs.read` returns EAGAIN when no data is buffered, which
 * bubbles to `errorOrDestroy`, destroys the stream, and closes the fd. Result: silent
 * PTYs (empty onData), SIGHUP exits, and later resize EBADF.
 *
 * Upstream: https://github.com/oven-sh/bun/issues/25822
 * Fix (not yet in a released Bun as of 1.3.14): https://github.com/oven-sh/bun/pull/29114
 *
 * This module mirrors that PR's externally-visible behaviour for node-pty only:
 * patch `require('tty').ReadStream` under Bun so non-blocking reads retry EAGAIN and
 * the stream never closes the caller-owned fd. No-op under Node / when already patched.
 */

import { createRequire } from 'node:module'
import fs from 'node:fs'
import tty from 'node:tty'

const POLYFILL_FLAG = Symbol.for('podium.bunNodePtyTtyPolyfill')

type PolyfillState = {
  closed: boolean
  retryTimer: ReturnType<typeof setTimeout> | null
  stream: { destroyed?: boolean; fd?: number } | null
}

function createTtyReadStreamFs(): { state: PolyfillState; fs: typeof fs } {
  const state: PolyfillState = { closed: false, retryTimer: null, stream: null }
  return {
    state,
    fs: {
      ...fs,
      open: fs.open.bind(fs),
      close(fd: number, cb?: (err: NodeJS.ErrnoException | null) => void) {
        // Caller owns the fd (node-pty's master); do not close it.
        state.closed = true
        if (state.retryTimer) {
          clearTimeout(state.retryTimer)
          state.retryTimer = null
        }
        if (typeof cb === 'function') process.nextTick(cb, null)
      },
      read(
        fd: number,
        buf: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
        position: number | null,
        cb: (err: NodeJS.ErrnoException | null, bytesRead: number, buffer: NodeJS.ArrayBufferView) => void,
      ) {
        const retry = () => {
          state.retryTimer = null
          if (
            state.closed ||
            state.stream?.destroyed ||
            (state.stream && state.stream.fd !== undefined && state.stream.fd !== fd)
          ) {
            return
          }
          fs.read(fd, buf, offset, length, position, (er, bytesRead, buffer) => {
            if (state.closed || state.stream?.destroyed) return
            if (er && (er.code === 'EAGAIN' || er.code === 'EWOULDBLOCK')) {
              state.retryTimer = setTimeout(retry, 10)
              state.retryTimer.unref?.()
              return
            }
            cb(er, bytesRead, buffer)
          })
        }
        retry()
      },
    } as typeof fs,
  }
}

/** Bun accepts a custom `fs` + autoClose on ReadStream; Node typings do not. */
type BunReadStreamOpts = {
  fd: number
  fs: typeof fs
  autoClose: boolean
}

function patchedReadStream(this: unknown, fd: number): fs.ReadStream {
  const wrapper = createTtyReadStreamFs()
  // Bun's fs.ReadStream accepts a custom `fs` implementation (same as the upstream fix).
  const ReadStreamCtor = fs.ReadStream as unknown as new (
    path: null,
    opts: BunReadStreamOpts,
  ) => fs.ReadStream
  const stream = new ReadStreamCtor(null, {
    fd,
    fs: wrapper.fs,
    autoClose: false,
  })
  const ttyStream = stream as fs.ReadStream & {
    isRaw: boolean
    isTTY: boolean
    setRawMode: (flag: boolean) => fs.ReadStream
  }
  ttyStream.isRaw = false
  ttyStream.isTTY = typeof tty.isatty === 'function' ? tty.isatty(fd) : true
  ttyStream.setRawMode = function setRawMode(flag: boolean) {
    this.isRaw = !!flag
    return this
  }
  wrapper.state.stream = stream
  stream.once('close', () => {
    wrapper.state.closed = true
    if (wrapper.state.retryTimer) {
      clearTimeout(wrapper.state.retryTimer)
      wrapper.state.retryTimer = null
    }
  })
  return stream
}

/**
 * Idempotent. Under Bun, replaces `require('tty').ReadStream` with a node-pty-safe
 * implementation. Safe to call from any node-pty entry path (backend load, raw imports).
 */
export function ensureBunNodePtyTtyPolyfill(): void {
  if (typeof process.versions.bun !== 'string') return
  const req = createRequire(import.meta.url)
  // node-pty does `require('tty')` then `new tty.ReadStream(fd)` at spawn time — patch
  // the CJS module object that require returns (same object as `node:tty` under Bun).
  const ttyMod = req('tty') as typeof tty & { [POLYFILL_FLAG]?: boolean; ReadStream: unknown }
  if (ttyMod[POLYFILL_FLAG]) return

  // Constructor form: node-pty uses `new tty.ReadStream(term.fd)`. Returning an object
  // from a constructor replaces `this`, which is what we want (the fs.ReadStream).
  function ReadStream(this: unknown, fd: number) {
    return patchedReadStream.call(this, fd)
  }
  ReadStream.prototype = fs.ReadStream.prototype
  Object.setPrototypeOf(ReadStream, fs.ReadStream)

  ttyMod.ReadStream = ReadStream as unknown as typeof tty.ReadStream
  ;(tty as { ReadStream: typeof tty.ReadStream }).ReadStream =
    ReadStream as unknown as typeof tty.ReadStream
  ttyMod[POLYFILL_FLAG] = true
}
