/**
 * scripts/chat-ai-watcher.mjs — the real watcher against a real
 * server/index.js bound to an ephemeral port (AGENT_OFFICE_PORT), with
 * HOME/AGENT_OFFICE_HOME in a temp dir and a fake `claude` (a node script
 * passed through CHAT_AI_CLAUDE) that logs its argv and stdin, so nothing
 * reaches the real ~/.agent-office or the real CLI.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listen, loadOffice, postAuthed, removeOffice, spawnAgent, type Office } from './helpers'

const WATCHER = fileURLToPath(new URL('../scripts/chat-ai-watcher.mjs', import.meta.url))
const STOP = fileURLToPath(new URL('../scripts/stop-office.mjs', import.meta.url))

/** The real stop script against an office dir: { code, out }. */
function runStop(officeDir: string) {
  return new Promise<{ code: number | null; out: string }>(resolve => {
    const child = spawn(process.execPath, [STOP], { env: { ...process.env, HOME: officeDir, USERPROFILE: officeDir, AGENT_OFFICE_HOME: officeDir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    child.stdout.setEncoding('utf8').on('data', d => { out += d })
    child.stderr.setEncoding('utf8').on('data', d => { out += d })
    child.on('close', code => resolve({ code, out }))
  })
}
const WIN = process.platform === 'win32'

// Fake `claude`: logs every call (one JSON object per line: argv and stdin)
// and its pid, thinks for $FAKE_CLAUDE_DIR/delay seconds when that file
// exists (as a child process, whose pid it writes too, so a tree kill can be
// told from a kill of the fake alone), then answers from $FAKE_CLAUDE_DIR/mode
// — "ok" prints a reply, "empty" fails like a CLI that is not logged in.
const FAKE_CLAUDE = `
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.FAKE_CLAUDE_DIR
const read = name => existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').trim() : ''
let stdin = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) stdin += chunk
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\\n')
appendFileSync(join(dir, 'claude.pids'), process.pid + '\\n')
const delay = Number(read('delay') || 0)
if (delay) {
  const think = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ' + delay * 1000 + ')'], { stdio: 'ignore' })
  appendFileSync(join(dir, 'sleep.pids'), think.pid + '\\n')
  await new Promise(resolve => think.on('exit', resolve))
}
if (read('mode') === 'empty') {
  console.error('Not logged in · Please run /login')
  process.exit(1)
}
console.log('On it, checking the error logs now')
`

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function waitForWithin<T>(what: string, fn: () => T | Promise<T>, timeoutMs: number): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}
const waitFor = <T,>(what: string, fn: () => T | Promise<T>, timeoutMs = 8000) => waitForWithin(what, fn, timeoutMs)

function alive(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}

const tempDirs: string[] = []
function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** A child process whose stdout/stderr are collected into `.out`. */
class Proc {
  out = ''
  exited: Promise<number | null>
  constructor(public child: ChildProcess) {
    child.stdout?.on('data', d => { this.out += d })
    child.stderr?.on('data', d => { this.out += d })
    this.exited = new Promise(resolve => child.on('exit', code => resolve(code)))
  }
  get pid() { return this.child.pid! }
  /** What stop-office does: the whole tree on Windows, the process group elsewhere. */
  async stop() {
    if (WIN) spawnSync('taskkill', ['/PID', String(this.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else {
      try { process.kill(-this.pid, 'SIGTERM') } catch {}
      await Promise.race([this.exited, sleep(3000)])
      try { process.kill(-this.pid, 'SIGKILL') } catch {}
    }
    await Promise.race([this.exited, sleep(3000)])
  }
}

const procs: Proc[] = []
/** The watcher, spawned without a shell. Own process group on POSIX so a group kill reaches `claude` too. */
function runWatcher(env: NodeJS.ProcessEnv) {
  const proc = new Proc(spawn(process.execPath, [WATCHER], { env, detached: !WIN, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }))
  procs.push(proc)
  return proc
}

afterAll(async () => {
  for (const p of procs) await p.stop()
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

interface WatcherWorld {
  office: Office
  port: number
  claudeDir: string
  watcher: Proc
}

/**
 * Real server on a free port + the watcher polling it every 200 ms with a
 * fake `claude`. `lastTs` is written to chat-ai-last-ts before it starts;
 * `delay` makes every `claude -p` take that many seconds.
 */
async function startWatcher(opts: { maxPerMinute?: number; staleLock?: boolean; lastTs?: string; delay?: number } = {}): Promise<WatcherWorld> {
  const office = await loadOffice()
  const port = await listen(office.server.httpServer)
  // What start() writes once the port is bound: the watcher reads it to post as an agent
  writeFileSync(join(office.dir, 'auth-token'), office.server.AUTH_TOKEN, { mode: 0o600 })
  const home = tempDir('agent-office-script-home-')
  const fake = join(home, 'fake-claude.mjs')
  writeFileSync(fake, FAKE_CLAUDE)
  const claudeDir = join(home, 'fake-claude')
  mkdirSync(claudeDir)
  writeFileSync(join(claudeDir, 'mode'), 'ok')
  if (opts.delay) writeFileSync(join(claudeDir, 'delay'), String(opts.delay))
  if (opts.staleLock) writeFileSync(join(office.dir, 'chat-ai.lock'), '')
  if (opts.lastTs !== undefined) writeFileSync(join(office.dir, 'chat-ai-last-ts'), opts.lastTs)

  const watcher = runWatcher({
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AGENT_OFFICE_HOME: office.dir,
    AGENT_OFFICE_PORT: String(port),
    CHAT_AI_CLAUDE: fake,
    FAKE_CLAUDE_DIR: claudeDir,
    CHAT_AI_POLL_INTERVAL: '0.2',
    CHAT_AI_MAX_REPLIES_PER_MIN: String(opts.maxPerMinute ?? 50),
  })
  await waitFor('watcher pid file', () => existsSync(join(office.dir, 'chat-watcher.pid')))
  return { office, port, claudeDir, watcher }
}

interface ClaudeCall { argv: string[]; stdin: string }

function claudeCalls(w: WatcherWorld): ClaudeCall[] {
  const file = join(w.claudeDir, 'calls.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
}

async function chat(w: WatcherWorld) {
  const res = await request(w.office.server.app).get('/chat')
  return res.body.messages as Array<Record<string, any>>
}

/** Pids the fake `claude` wrote: its own, or (`sleep`) that of the think it was doing. */
function fakePids(w: WatcherWorld, which: 'claude' | 'sleep'): number[] {
  const file = join(w.claudeDir, `${which}.pids`)
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []
}

const say = (w: WatcherWorld, text: string, sender = 'Antony') =>
  request(w.office.server.app).post('/chat').send({ sender, text })

const FAKE_REPLY = 'On it, checking the error logs now'
/** Rows the watcher posted (announcements and directed messages carry an agent role too, but not this text). */
const replies = (msgs: Array<Record<string, any>>) => msgs.filter(m => m.text === FAKE_REPLY)

describe('chat-ai-watcher.mjs', () => {
  let w: WatcherWorld
  beforeAll(async () => { w = await startWatcher({ maxPerMinute: 3 }) })
  afterAll(async () => { await w.watcher.stop(); removeOffice(w.office) })

  it('answers a message a person typed exactly once, as the routed persona, with a cheap model and hooks/MCP off', async () => {
    await say(w, 'hey there is a bug in login')
    const reply = await waitFor('the Debugger reply', async () => (await chat(w)).find(m => m.sender === 'Debugger'))
    expect(reply).toMatchObject({ role: 'debugger', text: FAKE_REPLY, recipient: null })

    // Several more polls: the reply itself must not be answered
    await sleep(1000)
    expect(claudeCalls(w)).toHaveLength(1)
    expect(replies(await chat(w))).toHaveLength(1)

    // The prompt travels on stdin, never argv (chat text is untrusted)
    const { argv, stdin } = claudeCalls(w)[0]
    expect(stdin).toContain('You are responding as Debugger, the office debugger')
    expect(stdin).toContain('Antony: hey there is a bug in login')
    expect(argv.some(a => a.includes('hey there is a bug') || a.includes('You are responding as'))).toBe(false)
    expect(argv).toEqual([
      '-p', '--max-turns', '1', '--model', 'claude-haiku-5-5', '--safe-mode', '--strict-mcp-config', '--tools', '',
      '--no-session-persistence',
      // Named so the registry roster (server/sessions.js) never shows the bot as a session
      '--name', 'agent-office-bot',
    ])

    // Its own reply is behind the watermark, not ahead of it
    const lastTs = Number(readFileSync(join(w.office.dir, 'chat-ai-last-ts'), 'utf8'))
    expect(lastTs).toBeGreaterThanOrEqual(reply!.timestamp)
  })

  it("ignores the server's starting:/done: announcements and directed agent-to-agent messages", async () => {
    spawnAgent(w.office.server, { id: 'agent-dbg', name: 'Debugger', role: 'debugger', task: 'fix the login bug' })
    spawnAgent(w.office.server, { id: 'agent-rev', name: 'Reviewer', role: 'code-reviewer', task: 'review the fix' })
    await postAuthed(w.office.server, '/chat/reply', { sender: 'Reviewer', role: 'code-reviewer', recipient: 'Debugger', text: 'is the login bug fixed?' })
    w.office.server.processEvent({ type: 'agent_completed', agentId: 'agent-dbg', result: 'fixed the bug in login' })

    const msgs = await chat(w)
    expect(msgs.map(m => m.text)).toEqual(expect.arrayContaining([
      'starting: fix the login bug', 'starting: review the fix', 'is the login bug fixed?', 'done: fixed the bug in login',
    ]))

    await sleep(1000)
    expect(claudeCalls(w)).toHaveLength(1)
  })

  it("never sees the Boss prompt and Claude reply rows the main-thread events persist: GET /chat hides them without the token, and their roles are boss/assistant anyway", async () => {
    w.office.server.processEvent({ type: 'session_prompt', sessionId: 'sess-watch', project: 'watch', promptId: 'p1', text: 'there is a bug in login, fix it' })
    w.office.server.processEvent({ type: 'session_turn_end', sessionId: 'sess-watch', promptId: 'p1', text: 'Fixed the bug in login.', backgroundTasks: [], crons: 0 })

    // Stored, visible with the office token...
    const withToken = await request(w.office.server.app).get('/chat').set('Authorization', `Bearer ${w.office.server.AUTH_TOKEN}`)
    expect(withToken.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ sender: 'Boss', role: 'boss', msg_type: 'prompt', text: 'there is a bug in login, fix it' }),
      expect.objectContaining({ sender: 'Claude', role: 'assistant', msg_type: 'reply', text: 'Fixed the bug in login.' }),
    ]))
    // ...and absent from what the watcher polls
    const msgs = await chat(w)
    expect(msgs.some(m => m.msg_type === 'prompt' || m.msg_type === 'reply' || m.sender === 'Boss')).toBe(false)

    await sleep(1000)
    expect(claudeCalls(w)).toHaveLength(1)
  })

  it('ignores slash commands and system lines', async () => {
    await say(w, '/nonsense there is a bug')
    await say(w, '/help')
    expect((await chat(w)).at(-1)).toMatchObject({ sender: 'system', is_system: 1 })
    await sleep(1000)
    expect(claudeCalls(w)).toHaveLength(1)
  })

  it('answers the next human message, then stops at the per-minute reply cap', async () => {
    await say(w, 'can you review the PR please')
    await waitFor('the Reviewer reply', async () => (await chat(w)).find(m => m.sender === 'Reviewer' && m.role === 'code-reviewer' && m.text === FAKE_REPLY))
    expect(claudeCalls(w)).toHaveLength(2)

    await say(w, 'another bug over here')
    await waitFor('a third claude call', () => claudeCalls(w).length === 3)
    await waitFor('the second Debugger reply', async () => replies(await chat(w)).filter(m => m.sender === 'Debugger').length === 2)

    // Cap is 3 per minute for this run: the fourth message is seen but not answered
    await say(w, 'one more bug for you')
    await waitFor('the cap log line', () => w.watcher.out.includes('Reply cap reached (3 per minute)'))
    await sleep(600)
    expect(claudeCalls(w)).toHaveLength(3)
    expect(replies(await chat(w))).toHaveLength(3)
  })
})

describe('chat-ai-watcher.mjs lock', () => {
  let w: WatcherWorld
  beforeAll(async () => { w = await startWatcher({ staleLock: true }) })
  afterAll(async () => { await w.watcher.stop(); removeOffice(w.office) })

  // Two watcher round trips through a fake `claude -p` in one test: give it
  // room under full-suite load, where 8 s waits have timed out
  it('clears a stale lock at startup, and an empty/failed `claude -p` neither posts nor leaves the lock behind', async () => {
    const waitFor = <T,>(what: string, fn: () => T | Promise<T>) => waitForWithin(what, fn, 20_000)
    const lock = join(w.office.dir, 'chat-ai.lock')
    expect(existsSync(lock)).toBe(false)

    writeFileSync(join(w.claudeDir, 'mode'), 'empty')
    await say(w, 'there is a bug in checkout')
    await waitFor('the empty-reply log line', () => w.watcher.out.includes('Empty reply from claude'))
    expect(claudeCalls(w)).toHaveLength(1)
    expect(w.watcher.out).toContain('claude: Not logged in')
    // The watcher prints the empty-reply line inside doReply and removes the
    // lock when it returns, so the log line can arrive a few ms before the
    // file is gone: wait for the release rather than asserting it at once
    await waitFor('the lock to be released after the empty reply', () => !existsSync(lock))
    expect(replies(await chat(w))).toHaveLength(0)

    // ...and the next message is answered once the CLI works again
    writeFileSync(join(w.claudeDir, 'mode'), 'ok')
    await say(w, 'still a bug in checkout')
    await waitFor('the Debugger reply', async () => (await chat(w)).find(m => m.sender === 'Debugger'))
    expect(claudeCalls(w)).toHaveLength(2)
    await waitFor('the lock to be released', () => !existsSync(lock))
    expect(w.watcher.out).not.toContain('already generating a reply')
  }, 45_000)
})

describe('chat-ai-watcher.mjs: a message typed while a reply is being generated', () => {
  let w: WatcherWorld
  beforeAll(async () => { w = await startWatcher({ delay: 1.5 }) })
  afterAll(async () => { await w.watcher.stop(); removeOffice(w.office) })

  it('is answered next, not skipped: the watermark is what was seen before generating, not the reply', async () => {
    const waitFor = <T,>(what: string, fn: () => T | Promise<T>) => waitForWithin(what, fn, 20_000)
    await say(w, 'hey there is a bug in login')
    await waitFor('the first claude call', () => claudeCalls(w).length === 1)
    // The fake is still thinking: this lands between the poll that found the
    // first message and the reply's own row
    await say(w, 'and can you review the PR after')
    await waitFor('the second claude call', () => claudeCalls(w).length === 2)
    expect(claudeCalls(w)[1].stdin).toContain('Antony: and can you review the PR after')
    await waitFor('two replies', async () => replies(await chat(w)).length === 2)
    expect((await chat(w)).filter(m => m.text === FAKE_REPLY).map(m => m.sender)).toEqual(['Debugger', 'Reviewer'])

    // Neither reply is answered, and nothing is answered twice
    await sleep(2500)
    expect(claudeCalls(w)).toHaveLength(2)
    const lastTs = Number(readFileSync(join(w.office.dir, 'chat-ai-last-ts'), 'utf8'))
    expect(lastTs).toBeGreaterThanOrEqual(Math.max(...(await chat(w)).map(m => m.timestamp)))
  }, 45_000)
})

describe('chat-ai-watcher.mjs: a chat-ai-last-ts that is not a timestamp', () => {
  for (const [label, content] of [['empty', ''], ['garbage', 'garbage\n'], ['in the future', `${Date.now() + 10 * 86_400_000}\n`]] as const) {
    it(`(${label}) starts from now: a message is answered once, and the file holds a timestamp again`, async () => {
      const w = await startWatcher({ lastTs: content })
      try {
        await say(w, 'there is a bug in the parser')
        await waitFor('the reply', async () => replies(await chat(w)).length === 1)
        await sleep(1500)                                    // several more polls
        expect(claudeCalls(w)).toHaveLength(1)
        expect(replies(await chat(w))).toHaveLength(1)
        const saved = readFileSync(join(w.office.dir, 'chat-ai-last-ts'), 'utf8').trim()
        expect(saved).toMatch(/^\d{13}$/)
        expect(Number(saved)).toBeLessThanOrEqual(Date.now())
        expect(w.watcher.out).toContain('did not hold a timestamp')
      } finally {
        await w.watcher.stop()
        removeOffice(w.office)
      }
    }, 30_000)
  }
})

describe('chat-ai-watcher.mjs stopped mid-reply', () => {
  it('stop-office.mjs takes the in-flight `claude -p` and its children down with the watcher (tree kill / group kill)', async () => {
    const w = await startWatcher({ delay: 30 })
    try {
      await say(w, 'there is a bug in checkout')
      await waitFor('the fake claude to start thinking', () => fakePids(w, 'sleep').length === 1)
      const [claude] = fakePids(w, 'claude')
      const [think] = fakePids(w, 'sleep')
      expect(alive(claude)).toBe(true)

      const { code, out } = await runStop(w.office.dir)
      expect(code).toBe(0)
      expect(out).toContain(`Chat watcher stopped (pid ${w.watcher.pid})`)
      await waitFor('the in-flight claude -p to be gone', () => !alive(claude) && !alive(think), 5000)
      expect(existsSync(join(w.office.dir, 'chat-ai-claude.err'))).toBe(false)
    } finally {
      await w.watcher.stop()
      removeOffice(w.office)
    }
  }, 30_000)

  // Windows has no catchable SIGTERM: the tree kill above is the stop there
  it.skipIf(WIN)('a SIGTERM to the watcher alone also kills the in-flight `claude -p` and cleans up', async () => {
    const w = await startWatcher({ delay: 30 })
    try {
      await say(w, 'there is a bug in checkout')
      await waitFor('the fake claude to start thinking', () => fakePids(w, 'sleep').length === 1)
      const [claude] = fakePids(w, 'claude')
      const [think] = fakePids(w, 'sleep')

      process.kill(w.watcher.pid, 'SIGTERM')
      await waitFor('the watcher to exit', () => w.watcher.out.includes('[chat-ai] Stopped'), 5000)
      await waitFor('the in-flight claude -p to be gone', () => !alive(claude), 5000)
      expect(existsSync(join(w.office.dir, 'chat-watcher.pid'))).toBe(false)
      expect(existsSync(join(w.office.dir, 'chat-ai.lock'))).toBe(false)
      try { process.kill(think, 'SIGKILL') } catch {}
    } finally {
      await w.watcher.stop()
      removeOffice(w.office)
    }
  }, 30_000)
})

describe('chat-ai-watcher.mjs: a claude that hangs', () => {
  it('is killed after CHAT_AI_TIMEOUT, posts nothing and releases the lock', async () => {
    const office = await loadOffice()
    const port = await listen(office.server.httpServer)
    const home = tempDir('agent-office-script-home-')
    const fake = join(home, 'fake-claude.mjs')
    writeFileSync(fake, FAKE_CLAUDE)
    const claudeDir = join(home, 'fake-claude')
    mkdirSync(claudeDir)
    writeFileSync(join(claudeDir, 'delay'), '30')
    const watcher = runWatcher({
      ...process.env, HOME: home, USERPROFILE: home, AGENT_OFFICE_HOME: office.dir, AGENT_OFFICE_PORT: String(port),
      CHAT_AI_CLAUDE: fake, FAKE_CLAUDE_DIR: claudeDir, CHAT_AI_POLL_INTERVAL: '0.2', CHAT_AI_TIMEOUT: '1',
    })
    const w = { office, port, claudeDir, watcher }
    try {
      await waitFor('watcher pid file', () => existsSync(join(office.dir, 'chat-watcher.pid')))
      await say(w, 'there is a bug in checkout')
      await waitFor('the fake claude to start thinking', () => fakePids(w, 'sleep').length === 1)
      const [claude] = fakePids(w, 'claude')
      await waitFor('the empty-reply log line', () => watcher.out.includes('Empty reply from claude'), 10_000)
      expect(alive(claude)).toBe(false)
      await waitFor('the lock to be released', () => !existsSync(join(office.dir, 'chat-ai.lock')))
      expect(replies(await chat(w))).toHaveLength(0)
    } finally {
      await watcher.stop()
      removeOffice(office)
    }
  }, 30_000)
})

describe('chat-ai-watcher.mjs: finding claude', () => {
  /** The watcher against a dead port (it only logs its startup), with no CHAT_AI_CLAUDE and PATH = `pathDirs`. */
  async function startupLog(pathDirs: string[]) {
    const home = tempDir('agent-office-script-home-')
    const env = { ...process.env, HOME: home, USERPROFILE: home, AGENT_OFFICE_HOME: join(home, 'state'), AGENT_OFFICE_PORT: '1', CHAT_AI_CLAUDE: '' }
    delete env.Path // Windows spells it Path; one spelling only
    env.PATH = pathDirs.join(WIN ? ';' : ':')
    const watcher = runWatcher(env)
    await waitFor('the Started line', () => watcher.out.includes('Started'))
    await sleep(200)
    await watcher.stop()
    return watcher.out
  }

  it('warns when there is no claude on PATH', async () => {
    expect(await startupLog([tempDir('agent-office-empty-path-')])).toContain("'claude' CLI not found")
  })

  it.skipIf(!WIN)('finds the native binary beside an npm claude.cmd, and does not when it is missing', async () => {
    const bin = tempDir('agent-office-npm-bin-')
    writeFileSync(join(bin, 'claude.cmd'), '@echo off\r\n')
    expect(await startupLog([bin])).toContain("'claude' CLI not found")

    const exeDir = join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'bin')
    mkdirSync(exeDir, { recursive: true })
    appendFileSync(join(exeDir, 'claude.exe'), '')
    expect(await startupLog([bin])).not.toContain("'claude' CLI not found")
  })

  it.skipIf(WIN)('finds an executable claude on PATH', async () => {
    const bin = tempDir('agent-office-bin-')
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 })
    expect(await startupLog([bin])).not.toContain("'claude' CLI not found")
  })
})
