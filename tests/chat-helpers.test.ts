/**
 * scripts/chat-post.mjs, chat-reply.mjs, chat-poll.mjs, agent-message.mjs —
 * the chat helpers agents and cron call. Each test runs the real script with
 * node (no shell) against a real server/index.js bound to an ephemeral port,
 * with AGENT_OFFICE_HOME and HOME pointed at temp dirs.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import { listen, loadOffice, postAuthed, removeOffice, spawnAgent } from './helpers'

const SCRIPTS = fileURLToPath(new URL('../scripts', import.meta.url))
const script = (name: string) => join(SCRIPTS, name)

const tempDirs: string[] = []
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

/** A real server on a free port; the token file written only when asked (start() writes it once bound). */
async function office(withToken: boolean) {
  const o = await loadOffice()
  const port = await listen(o.server.httpServer)
  if (withToken) writeFileSync(join(o.dir, 'auth-token'), o.server.AUTH_TOKEN, { mode: 0o600 })
  const home = mkdtempSync(join(tmpdir(), 'agent-office-chat-helpers-'))
  tempDirs.push(home)
  const env = { ...process.env, HOME: home, USERPROFILE: home, AGENT_OFFICE_HOME: o.dir, AGENT_OFFICE_PORT: String(port) }
  // Async: the server answers on this process's event loop, so a synchronous spawn would deadlock
  const run = (name: string, ...args: string[]) => new Promise<{ code: number | null; out: string; err: string }>(resolve => {
    const child = spawn(process.execPath, [script(name), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('close', code => resolve({ code, out, err }))
  })
  const texts = async () => ((await request(o.server.app).get('/chat')).body.messages as Array<{ text: string }>).map(m => m.text)
  const state = () => JSON.parse(readFileSync(join(o.dir, 'chat-poll-state'), 'utf8'))
  return { o, run, texts, state, env }
}

describe('chat-post.mjs', () => {
  it('/clear wipes the chat history, as the README documents: a slash command goes to POST /chat with the token', async () => {
    const { o, run, texts } = await office(true)
    try {
      await request(o.server.app).post('/chat').send({ sender: 'Antony', text: 'my secret prompt' })
      expect(await texts()).toContain('my secret prompt')

      const res = await run('chat-post.mjs', '/clear')
      expect(res.code).toBe(0)
      expect(res.out).toContain('Posted: /clear')
      expect(await texts()).toEqual(['/clear', '🧹 Chat cleared'])
    } finally {
      removeOffice(o)
    }
  })

  it('a refused command exits 1 with the server\'s reason and deletes nothing; a plain line still posts as Claude', async () => {
    let panelLine = ''
    const { o, run, texts } = await office(false)
    try {
      await request(o.server.app).post('/chat').send({ sender: 'Antony', text: 'keep me' })
      const res = await run('chat-post.mjs', '/clear')
      expect(res.code).toBe(1)
      expect(res.err).toContain(`no office token at ${join(o.dir, 'auth-token')}`)
      expect(res.err).toContain('Failed: HTTP 401: /clear needs the office auth token')
      expect(await texts()).toContain('keep me')
      panelLine = (await texts()).at(-1)!
    } finally {
      removeOffice(o)
    }

    const ok = await office(true)
    try {
      const res = await ok.run('chat-post.mjs', 'build', 'is', 'green')
      expect(res.code).toBe(0)
      expect(res.out).toContain('Posted: build is green')
      expect(await ok.texts()).toContain('build is green')
    } finally {
      removeOffice(ok.o)
    }

    // The panel's line names the command that works (server/index.js, checked last)
    expect(panelLine).toContain('scripts/chat-post.mjs /clear')
  })

  it('truncates a long line to its first ten words, leaves a short one alone, and prints usage without arguments', async () => {
    const { o, run, texts } = await office(true)
    try {
      const twelve = 'one two three four five six seven eight nine ten eleven twelve'
      expect((await run('chat-post.mjs', twelve)).code).toBe(0)
      expect((await run('chat-post.mjs', `${twelve} thirteen`)).out).toContain('Posted: one two three four five six seven eight nine ten...')
      const all = await texts()
      expect(all).toContain(twelve)
      expect(all).toContain('one two three four five six seven eight nine ten...')

      const usage = await run('chat-post.mjs')
      expect(usage.code).toBe(1)
      expect(usage.out).toContain('Usage: node chat-post.mjs <message>')
    } finally {
      removeOffice(o)
    }
  })

  it('a plain line to a dead port reports on stderr but exits 0; a command exits 1', async () => {
    const { o, run } = await office(true)
    try {
      await new Promise(resolve => o.server.httpServer.close(resolve))
      const plain = await run('chat-post.mjs', 'hello')
      expect(plain.code).toBe(0)
      expect(plain.err).toContain('Failed:')
      expect((await run('chat-post.mjs', '/status')).code).toBe(1)
    } finally {
      removeOffice(o)
    }
  })
})

describe('chat-reply.mjs', () => {
  it('posts as an assistant with the token, then moves the poll state past its own message', async () => {
    const { o, run, state } = await office(true)
    try {
      writeFileSync(join(o.dir, 'chat-poll-state'), JSON.stringify({ last_seen_timestamp: 5, consecutive_idle_count: 7, paused: false }))
      const before = Date.now()
      const res = await run('chat-reply.mjs', 'all done here')
      expect(res.code).toBe(0)
      expect(res.out).toContain('Sent: all done here')

      const msgs = (await request(o.server.app).get('/chat')).body.messages
      expect(msgs).toEqual([expect.objectContaining({ sender: 'Claude', role: 'assistant', text: 'all done here' })])
      expect(state()).toMatchObject({ last_seen_timestamp: expect.any(Number), consecutive_idle_count: 0, paused: false })
      expect(state().last_seen_timestamp).toBeGreaterThanOrEqual(before)
    } finally {
      removeOffice(o)
    }
  })

  it('creates no poll state when there is none, prints usage without arguments, and fails (exit 1) when the office refuses', async () => {
    const { o, run } = await office(true)
    try {
      expect((await run('chat-reply.mjs', 'hi')).code).toBe(0)
      expect(existsSync(join(o.dir, 'chat-poll-state'))).toBe(false)
      const usage = await run('chat-reply.mjs')
      expect(usage.code).toBe(1)
      expect(usage.out).toContain("Usage: node chat-reply.mjs 'message'")
    } finally {
      removeOffice(o)
    }

    const noToken = await office(false)
    try {
      const res = await noToken.run('chat-reply.mjs', 'hi')
      expect(res.code).toBe(1)
      expect(res.err).toContain('no office token at')
      expect(res.err).toContain('Failed: HTTP 401')
      expect(await noToken.texts()).toEqual([])
    } finally {
      removeOffice(noToken.o)
    }
  })
})

describe('chat-poll.mjs', () => {
  it('prints only what a person typed, remembers it, then counts idle runs and goes quiet after ten', async () => {
    const { o, run, state } = await office(true)
    try {
      const post = (body: object) => request(o.server.app).post('/chat').send(body)
      await post({ sender: 'Antony', text: 'is prod ok?' })
      await post({ sender: 'Antony', text: '/status' })
      await postAuthed(o.server, '/chat/reply', { sender: 'Claude', role: 'assistant', text: 'an agent line' })
      await postAuthed(o.server, '/chat/reply', { sender: 'Reviewer', role: 'code-reviewer', recipient: 'Nobody', text: 'directed line' })

      const first = await run('chat-poll.mjs')
      expect(first.code).toBe(0)
      expect(first.out.trim().split(/\r?\n/)).toEqual(['NEW: Antony: is prod ok?'])
      expect(state().consecutive_idle_count).toBe(0)

      const second = await run('chat-poll.mjs')
      expect(second.out.trim()).toBe('No new messages. (idle count: 1)')
      expect(state().consecutive_idle_count).toBe(1)

      writeFileSync(join(o.dir, 'chat-poll-state'), JSON.stringify({ ...state(), consecutive_idle_count: 10 }))
      expect((await run('chat-poll.mjs')).out).toBe('')
      expect(state().consecutive_idle_count).toBe(11)
    } finally {
      removeOffice(o)
    }
  })

  it('exits 0 silently when paused or when the office is down, and does not advance the state', async () => {
    const { o, run, state } = await office(true)
    try {
      await request(o.server.app).post('/chat').send({ sender: 'Antony', text: 'still there?' })
      writeFileSync(join(o.dir, 'chat-poll-state'), JSON.stringify({ last_seen_timestamp: 0, consecutive_idle_count: 3, paused: true }))
      const paused = await run('chat-poll.mjs')
      expect(paused).toEqual({ code: 0, out: '', err: '' })
      expect(state().consecutive_idle_count).toBe(3)

      writeFileSync(join(o.dir, 'chat-poll-state'), JSON.stringify({ last_seen_timestamp: 0, consecutive_idle_count: 3, paused: false }))
      await new Promise(resolve => o.server.httpServer.close(resolve))
      const down = await run('chat-poll.mjs')
      expect(down).toEqual({ code: 0, out: '', err: '' })
      expect(state().consecutive_idle_count).toBe(3)
    } finally {
      removeOffice(o)
    }
  })

  it('starts from a fresh state when there is no state file', async () => {
    const { o, run, state } = await office(true)
    try {
      const res = await run('chat-poll.mjs')
      expect(res.out.trim()).toBe('No new messages. (idle count: 1)')
      expect(state()).toEqual({ last_seen_timestamp: 0, consecutive_idle_count: 1, paused: false })
    } finally {
      removeOffice(o)
    }
  })
})

describe('agent-message.mjs', () => {
  async function pair() {
    const w = await office(true)
    spawnAgent(w.o.server, { id: 'agent-rev', name: 'Reviewer', role: 'code-reviewer', task: 'review auth.ts' })
    spawnAgent(w.o.server, { id: 'agent-dbg', name: 'Debugger', role: 'debugger', task: 'fix token refresh' })
    return w
  }

  it('sends a directed message, lists the office, reads the inbox and clears the unread badge (unless --peek)', async () => {
    const w = await pair()
    try {
      const sent = await w.run('agent-message.mjs', '--from', 'Reviewer', '--role', 'code-reviewer', '--to', 'Debugger',
        '--type', 'review_request', 'can you check the token refresh in auth.ts?')
      expect(sent.code).toBe(0)
      expect(sent.out).toMatch(/^#\d+ -> Debugger: delivered\r?\n$/)
      const id = sent.out.match(/^#(\d+)/)![1]

      const who = await w.run('agent-message.mjs', '--who')
      expect(who.code).toBe(0)
      const lines = who.out.trim().split(/\r?\n/)
      expect(lines).toHaveLength(2)
      expect(lines.find(l => l.startsWith('Debugger'))).toMatch(/^Debugger     debugger               \S+ +✉ 1   fix token refresh$/)

      const peek = await w.run('agent-message.mjs', '--inbox', 'Debugger', '--peek')
      expect(peek.out.trim()).toBe(`#${id} [review_request] Reviewer: can you check the token refresh in auth.ts?`)
      const stillUnread = (await request(w.o.server.app).get('/agents')).body.agents.find((a: any) => a.name === 'Debugger').unread
      expect(stillUnread).toBe(1)

      const read = await w.run('agent-message.mjs', '--inbox', 'Debugger', '--since', '0')
      expect(read.out.trim()).toBe(peek.out.trim())
      const cleared = (await request(w.o.server.app).get('/agents')).body.agents.find((a: any) => a.name === 'Debugger').unread
      expect(cleared).toBe(0)
    } finally {
      removeOffice(w.o)
    }
  })

  it('threads a reply and queues a message for a recipient who is not in the office', async () => {
    const w = await pair()
    try {
      const first = await w.run('agent-message.mjs', '--from', 'Reviewer', '--to', 'Debugger', 'first')
      const id = first.out.match(/^#(\d+)/)![1]
      await w.run('agent-message.mjs', '--from', 'Debugger', '--to', 'Reviewer', '--reply-to', id, '--type', 'question', 'why?')
      const inbox = await w.run('agent-message.mjs', '--inbox', 'Reviewer', '--peek')
      expect(inbox.out.trim()).toMatch(new RegExp(`^#\\d+ \\[question\\] Debugger \\(re #${id}\\): why\\?$`))

      const queued = await w.run('agent-message.mjs', '--to', 'Ghost', 'anyone?')
      expect(queued.code).toBe(0)
      expect(queued.out).toMatch(/^#\d+ -> Ghost: queued \(recipient not in the office\)\r?\n$/)
    } finally {
      removeOffice(w.o)
    }
  })

  it('exits 1 with the office\'s reason: the stale-token hint on 401, a plain message when the server is down', async () => {
    const w = await office(false)
    try {
      const res = await w.run('agent-message.mjs', '--to', 'Debugger', 'hi')
      expect(res.code).toBe(1)
      expect(res.err.trim()).toBe(`office refused: Unauthorized — the office token at ${join(w.o.dir, 'auth-token')} is missing or stale (is the server running?)`)

      // Reads need no token
      expect((await w.run('agent-message.mjs', '--who')).code).toBe(0)

      await new Promise(resolve => w.o.server.httpServer.close(resolve))
      const down = await w.run('agent-message.mjs', '--who')
      expect(down.code).toBe(1)
      expect(down.err.trim()).toBe(`office server is not running on port ${w.env.AGENT_OFFICE_PORT}`)
    } finally {
      removeOffice(w.o)
    }
  })

  it('prints help and exits 1 without a task, and exits 2 on a bad type or an unknown flag', async () => {
    const w = await office(true)
    try {
      const none = await w.run('agent-message.mjs')
      expect(none.code).toBe(1)
      expect(none.out).toContain('usage: agent-message.mjs')
      expect((await w.run('agent-message.mjs', '--to', 'x')).code).toBe(1)

      const badType = await w.run('agent-message.mjs', '--to', 'x', '--type', 'shout', 'hi')
      expect(badType.code).toBe(2)
      expect(badType.err).toContain("invalid choice: 'shout'")
      expect((await w.run('agent-message.mjs', '--bogus')).code).toBe(2)
      expect((await w.run('agent-message.mjs', '--help')).code).toBe(0)
    } finally {
      removeOffice(w.o)
    }
  })
})
