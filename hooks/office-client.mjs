/**
 * What the hook (agent-tracker.mjs) and the status line (status-line.mjs)
 * share to talk to the office server: where it listens, the token, request
 * signing and one bounded HTTP request. Node builtins only — this module is
 * loaded on every hook run, so it stays cheap to import.
 *
 * The token never travels: each request is SIGNED with it,
 * HMAC-SHA256(token, METHOD\npath\ntimestamp\nbody), and the server verifies
 * that over the raw body within ±60 s (server/index.js requestSignature).
 */

import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The office state dir, resolved exactly as the server does: AGENT_OFFICE_HOME,
 * else ~/.agent-office (homedir() is $HOME on POSIX, %USERPROFILE% on Windows).
 */
export function officeHome(env = process.env) {
  return env.AGENT_OFFICE_HOME || join(homedir(), '.agent-office')
}

/**
 * The URL of an office endpoint: the override (AGENT_OFFICE_EVENT_URL or
 * AGENT_OFFICE_STATUS_URL) wins, else 127.0.0.1 on AGENT_OFFICE_PORT (default
 * 3334). 127.0.0.1, not 'localhost': that can resolve to ::1 first, which
 * would let a squatter on [::1] win the name while the office runs on IPv4.
 */
export function officeUrl(endpoint, override, env = process.env) {
  return override || `http://127.0.0.1:${env.AGENT_OFFICE_PORT || 3334}${endpoint}`
}

/** The office token, or '' when there is no token file. */
export function readToken(env = process.env) {
  try {
    return readFileSync(join(officeHome(env), 'auth-token'), 'utf8').trim()
  } catch {
    return ''
  }
}

/** The path and query of a URL, as the server sees it in req.originalUrl. */
function urlPath(url) {
  const u = new URL(url)
  return u.pathname + u.search
}

/**
 * The two signing headers for a request, or {} without a token (the request
 * then goes out unsigned and the server answers 401, which callers ignore).
 */
export function signHeaders(token, method, url, body = '') {
  if (!token) return {}
  const ts = String(Date.now())
  const sig = createHmac('sha256', token)
    .update(`${method}\n${urlPath(url)}\n${ts}\n`)
    .update(body)
    .digest('hex')
  return { 'X-Office-Timestamp': ts, 'X-Office-Signature': sig }
}

/**
 * One HTTP request, bounded at timeoutMs. Resolves { status, body } once the
 * response is read, or null on any error or timeout — never rejects. Callers
 * that do not care about the answer still wait for it: exiting once the
 * request is written loses events whenever the server is busy (measured
 * 29/100 delivered against a busy event loop), where the old backgrounded
 * curl lived on until the server answered.
 */
export function send(url, { method = 'GET', body = '', headers = {}, timeoutMs = 1000 } = {}) {
  return new Promise(resolve => {
    let done = false
    const finish = value => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const data = Buffer.from(body, 'utf8')
    const req = httpRequest(url, {
      method,
      headers: { ...(data.length ? { 'Content-Type': 'application/json' } : {}), 'Content-Length': data.length, ...headers },
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', () => finish(null))
    })
    const timer = setTimeout(() => { req.destroy(); finish(null) }, timeoutMs)
    req.on('error', () => finish(null))
    req.end(data)
  })
}
