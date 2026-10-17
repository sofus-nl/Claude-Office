/**
 * hooks/office-client.mjs — what the hook and the status line share: request
 * signing (byte-for-byte what the old Python signed) and the bounded request
 * that must still deliver the event when the server is busy.
 */

import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { officeHome, officeUrl, readToken, send, signHeaders } from '../hooks/office-client.mjs'

const CLIENT = fileURLToPath(new URL('../hooks/office-client.mjs', import.meta.url))
const HOME = mkdtempSync(join(tmpdir(), 'agent-office-client-'))
afterAll(() => rmSync(HOME, { recursive: true, force: true }))
afterEach(() => vi.useRealTimers())

describe('office-client: where and who', () => {
  it('officeHome: AGENT_OFFICE_HOME wins', () => {
    expect(officeHome({ AGENT_OFFICE_HOME: HOME })).toBe(HOME)
  })

  it('officeUrl: the override wins, else 127.0.0.1 on AGENT_OFFICE_PORT (default 3334)', () => {
    expect(officeUrl('/event', 'http://x:1/e', {})).toBe('http://x:1/e')
    expect(officeUrl('/event', undefined, { AGENT_OFFICE_PORT: '4000' })).toBe('http://127.0.0.1:4000/event')
    expect(officeUrl('/status', '', {})).toBe('http://127.0.0.1:3334/status')
  })

  it('readToken: the trimmed token file, or empty without one', () => {
    expect(readToken({ AGENT_OFFICE_HOME: HOME })).toBe('')
    writeFileSync(join(HOME, 'auth-token'), 'tok-abc\n')
    expect(readToken({ AGENT_OFFICE_HOME: HOME })).toBe('tok-abc')
  })
})

describe('office-client: signHeaders', () => {
  // Reference values computed with the Python signer the bash hook used
  // (hooks/agent-tracker.sh _hmac_sha256_hex) for ts 1700000000000.
  it('signs exactly what the Python signed, non-ASCII body included', () => {
    vi.useFakeTimers({ now: 1700000000000 })
    const body = '{"type":"agent_working","text":"café — 🦀"}'
    expect(signHeaders('tok-123', 'POST', 'http://127.0.0.1:3334/event?x=1', body)).toEqual({
      'X-Office-Timestamp': '1700000000000',
      'X-Office-Signature': 'ea3826bdc1ae7b6bb8487d266aa44717cd4fc93019732160ece448ca84709973',
    })
    expect(signHeaders('tok-123', 'GET', 'http://127.0.0.1:3334/permission/p1?wait=20')['X-Office-Signature'])
      .toBe('2aa6f03439a1fb63687aa313e38d8b8efe6a59fbc1933f2688f51b8adf246c06')
  })

  it('no token: no headers (the request goes out unsigned)', () => {
    expect(signHeaders('', 'POST', 'http://127.0.0.1:3334/event', '{}')).toEqual({})
  })
})

describe('office-client: send', () => {
  it('a signed non-ASCII body arrives whole and verifies the way the server checks it', async () => {
    let seen: { raw: Buffer, headers: Record<string, unknown>, url?: string } | null = null
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        seen = { raw: Buffer.concat(chunks), headers: req.headers, url: req.url }
        res.end('{"ok":true}')
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/event`
    const body = JSON.stringify({ type: 'agent_working', text: 'café — 🦀' })
    const res = await send(url, { method: 'POST', body, headers: signHeaders('tok-123', 'POST', url, body) })
    server.close()
    expect(res).toEqual({ status: 200, body: '{"ok":true}' })
    expect(seen!.raw.toString('utf8')).toBe(body)
    const h = seen!.headers
    const expected = createHmac('sha256', 'tok-123')
      .update(`POST\n${seen!.url}\n${h['x-office-timestamp']}\n`).update(seen!.raw).digest('hex')
    expect(h['x-office-signature']).toBe(expected)
  })

  it('resolves null within its bound against a server that never answers', async () => {
    const server = createServer(() => {})
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/event`
    const t0 = Date.now()
    expect(await send(url, { method: 'POST', body: '{}', timeoutMs: 300 })).toBeNull()
    expect(Date.now() - t0).toBeLessThan(1000)
    server.closeAllConnections()
    server.close()
  })

  it('resolves null when nothing listens, over http or https', async () => {
    expect(await send('http://127.0.0.1:9/event', { method: 'POST', body: '{}' })).toBeNull()
    expect(await send('https://127.0.0.1:9/event', { method: 'POST', body: '{}' })).toBeNull()
  })

  it('resolves null for a URL node cannot request, never throws', async () => {
    expect(await send('ftp://127.0.0.1/event', { method: 'POST', body: '{}' })).toBeNull()
  })

  it('every event reaches a server whose event loop is busy, one short-lived process per event (as hooks run)', async () => {
    // The server busy-waits 80 ms of every 100 ms in its own process; each
    // client is a fresh node that sends one event and exits, like a hook run.
    const serverSrc = `
      const http = require('node:http'); let n = 0
      const s = http.createServer((q, r) => { q.resume(); q.on('end', () => { n++; r.end('ok') }) })
      s.listen(0, '127.0.0.1', () => process.stdout.write(String(s.address().port) + '\\n'))
      setInterval(() => { const t = Date.now(); while (Date.now() - t < 80); }, 100)
      process.stdin.on('data', () => process.stdout.write('count ' + n + '\\n'))`
    const server = spawn(process.execPath, ['-e', serverSrc], { stdio: ['pipe', 'pipe', 'inherit'] })
    const lines: string[] = []
    let wake: () => void = () => {}
    server.stdout.setEncoding('utf8').on('data', (d: string) => { lines.push(...d.split('\n').filter(Boolean)); wake() })
    const nextLine = () => new Promise<string>(r => {
      const check = () => { const l = lines.shift(); if (l) r(l); else wake = check }
      check()
    })
    const port = Number(await nextLine())
    const clientSrc = `import(${JSON.stringify(pathToFileURL(CLIENT).href)}).then(m =>
      m.send('http://127.0.0.1:${port}/event', { method: 'POST', body: '{"type":"x"}' }))`
    const runs = 20
    for (let i = 0; i < runs; i++) {
      await new Promise(r => spawn(process.execPath, ['-e', clientSrc], { stdio: 'ignore' }).on('exit', r))
    }
    server.stdin.write('\n')
    const count = await nextLine()
    server.kill()
    expect(count).toBe(`count ${runs}`)
  }, 60_000)
})
