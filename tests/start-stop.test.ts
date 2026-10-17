/**
 * scripts/start-office.mjs and scripts/stop-office.mjs. Each test runs the
 * real script with AGENT_OFFICE_HOME pointed at a temp dir and the opener
 * (`xdg-open` / `open`) replaced by a node stub on a temp PATH, so nothing
 * reaches the real ~/.agent-office or a browser. Every fixture process carries
 * MARK in its command line; the last test checks none is left behind.
 */

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { listen, loadOffice } from './helpers'

const SCRIPTS = fileURLToPath(new URL('../scripts', import.meta.url))
const START = join(SCRIPTS, 'start-office.mjs')
const STOP = join(SCRIPTS, 'stop-office.mjs')
const NODE = process.execPath
const WIN = process.platform === 'win32'

const MARK = `ao-startstop-${process.pid}-${Date.now()}`
const IDLE = 'setInterval(() => {}, 1000)'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function waitFor<T>(what: string, fn: () => T | Promise<T>, timeoutMs = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}

const tempDirs: string[] = []
function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}${MARK}-`))
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
  /** Take the whole tree down (the script and what it started). */
  async stop() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return // gone (its pid may be someone else's now)
    if (WIN) {
      spawnSync('taskkill', ['/PID', String(this.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      try { process.kill(-this.pid, 'SIGTERM') } catch {}
      try { this.child.kill('SIGTERM') } catch {}
    }
    await Promise.race([this.exited, sleep(3000)])
    if (!WIN) try { process.kill(-this.pid, 'SIGKILL') } catch {}
  }
}

const procs: Proc[] = []
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, detached = true) {
  const proc = new Proc(spawn(cmd, args, { env, detached, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }))
  procs.push(proc)
  return proc
}

/** Pids the office scripts started, checked dead at the end. */
const recordedPids = new Set<number>()
function recordPids(dir: string) {
  for (const f of ['server.pid', 'vite.pid', 'chat-watcher.pid']) {
    try { recordedPids.add(Number(readFileSync(join(dir, f), 'utf8'))) } catch {}
  }
}

afterAll(async () => {
  for (const p of procs) await p.stop()
  // an in-process office may still hold its database open (Windows: EPERM)
  for (const d of tempDirs) try { rmSync(d, { recursive: true, force: true }) } catch {}
}, 60_000)

/** A detached node process; its pid is what a pid file would hold. */
function idleNode() {
  return run(NODE, ['-e', IDLE, MARK], process.env)
}

/** A detached node TCP listener; resolves with its port. */
async function listener(): Promise<{ proc: Proc; port: number }> {
  const proc = run(NODE, ['-e', `const s = require('net').createServer(c => c.on('error', () => {})); s.listen(0, '127.0.0.1', () => console.log(s.address().port)); ${IDLE}`, MARK], process.env)
  const port = await waitFor('listener port', () => Number(proc.out.trim()) || 0)
  return { proc, port }
}

/** A detached node running `<dir>/<rel>`: the command line stop-office recognises as the office's. */
function officeLike(dir: string, rel: string) {
  const file = join(dir, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${IDLE}
`)
  return run(NODE, [file, MARK], process.env)
}

/** A process that is certainly not node. */
function stranger() {
  return WIN ? run('ping.exe', ['-n', '300', '127.0.0.1'], process.env) : run('sleep', ['300'], process.env)
}

// ---------------------------------------------------------------------------
// stop-office.mjs
// ---------------------------------------------------------------------------

function runStop(officeDir: string, extra: NodeJS.ProcessEnv = {}, args: string[] = []) {
  const proc = run(NODE, [STOP, ...args], { ...process.env, HOME: officeDir, USERPROFILE: officeDir, AGENT_OFFICE_HOME: officeDir, ...extra }, false)
  return proc.exited.then(code => ({ code, out: proc.out }))
}

describe('stop-office.mjs', () => {
  it('stops only the processes named in the pid files and leaves clients and look-alikes alone', async () => {
    const dir = tempDir('agent-office-stop-')
    const server = officeLike(dir, 'server/index.js')
    const vite = officeLike(dir, 'node_modules/vite/bin/vite.js')
    const decoy = idleNode()
    writeFileSync(join(dir, 'chat-ai-watcher.mjs'), `${IDLE}\n`)
    const watcher = run(NODE, [join(dir, 'chat-ai-watcher.mjs')], process.env)
    const { proc: listening, port } = await listener()
    const client = run(NODE, ['-e', `require('net').connect(${port}, '127.0.0.1').on('error', () => {}); ${IDLE}`, MARK], process.env)
    await sleep(200)

    writeFileSync(join(dir, 'server.pid'), `${server.pid}\n`)
    writeFileSync(join(dir, 'vite.pid'), `${vite.pid}\n`)
    writeFileSync(join(dir, 'chat-watcher.pid'), `${watcher.pid}\n`)

    const { code, out } = await runStop(dir, { AGENT_OFFICE_PORT: String(port), AGENT_OFFICE_UI_PORT: String(port) })
    expect(code).toBe(0)
    expect(out).toContain(`Chat watcher stopped (pid ${watcher.pid})`)
    expect(out).toContain(`Server stopped (pid ${server.pid})`)
    expect(out).toContain(`Vite dev server stopped (pid ${vite.pid})`)
    expect(out).toContain('3 process(es) stopped')

    await waitFor('pid-file processes to exit', () => !alive(server.pid) && !alive(vite.pid) && !alive(watcher.pid))
    expect(alive(decoy.pid)).toBe(true)
    expect(alive(listening.pid)).toBe(true)
    expect(alive(client.pid)).toBe(true)
    for (const f of ['server.pid', 'vite.pid', 'chat-watcher.pid']) expect(existsSync(join(dir, f))).toBe(false)
  }, 60_000)

  it('takes down what the recorded process started too', async () => {
    const dir = tempDir('agent-office-stop-')
    writeFileSync(join(dir, 'vite.js'), `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(IDLE)}, ${JSON.stringify(MARK)}], { stdio: 'ignore' }); console.log(c.pid); ${IDLE}
`)
    const parent = run(NODE, [join(dir, 'vite.js'), MARK], process.env)
    const childPid = await waitFor('the grandchild pid', () => Number(parent.out.trim()) || 0)
    expect(alive(childPid)).toBe(true)
    writeFileSync(join(dir, 'vite.pid'), `${parent.pid}\n`)

    const { code, out } = await runStop(dir)
    expect(code).toBe(0)
    expect(out).toContain(`Vite dev server stopped (pid ${parent.pid})`)
    await waitFor('the tree to exit', () => !alive(parent.pid) && !alive(childPid))
  }, 60_000)

  it('refuses a pid file that points at a process which is not an office process', async () => {
    const dir = tempDir('agent-office-stop-')
    const other = stranger()
    writeFileSync(join(dir, 'server.pid'), String(other.pid))

    const { code, out } = await runStop(dir)
    expect(code).toBe(0)
    expect(out).toContain(`pid ${other.pid} is not an office process`)
    expect(out).toContain('Nothing was running')
    expect(alive(other.pid)).toBe(true)
    expect(existsSync(join(dir, 'server.pid'))).toBe(false)
  }, 60_000)

  it('refuses a pid file that points at some other node process (a stale pid reused by an MCP server, say)', async () => {
    const dir = tempDir('agent-office-stop-')
    const other = idleNode()
    writeFileSync(join(dir, 'server.pid'), String(other.pid))
    writeFileSync(join(dir, 'vite.pid'), String(other.pid))

    const { code, out } = await runStop(dir)
    expect(code).toBe(0)
    expect(out).toContain(`pid ${other.pid} is not an office process`)
    expect(alive(other.pid)).toBe(true)
  }, 60_000)

  it('does nothing to a listener on the office port unless --force is given', async () => {
    const dir = tempDir('agent-office-stop-')
    const { proc: listening, port } = await listener()
    const env = { AGENT_OFFICE_PORT: String(port), AGENT_OFFICE_UI_PORT: String(port + 1) }

    const plain = await runStop(dir, env)
    expect(plain.code).toBe(0)
    expect(plain.out).toContain('--force')
    expect(alive(listening.pid)).toBe(true)

    const forced = await runStop(dir, env, ['--force'])
    expect(forced.code).toBe(0)
    if (/needs lsof, ss or fuser/.test(forced.out)) return // no port tool on this box
    expect(forced.out).toContain(`killed pid ${listening.pid} listening on :${port}`)
    await waitFor('listener to exit', () => !alive(listening.pid))
  }, 60_000)

  it('answers --help, rejects an unknown option with exit 2 and an empty office with "Nothing was running"', async () => {
    const dir = tempDir('agent-office-stop-')
    const help = await runStop(dir, {}, ['--help'])
    expect(help.code).toBe(0)
    expect(help.out).toContain('Usage: node scripts/stop-office.mjs [--force]')
    const bad = await runStop(dir, {}, ['--bogus'])
    expect(bad.code).toBe(2)
    expect(bad.out).toContain('Unknown option: --bogus')
    const none = await runStop(dir)
    expect(none.code).toBe(0)
    expect(none.out).toContain('Nothing was running')
    expect(none.out).toContain('node scripts/stop-office.mjs --force')
  }, 60_000)
})

// ---------------------------------------------------------------------------
// start-office.mjs
// ---------------------------------------------------------------------------

/** An http server that answers 200 to everything: "already running". */
function fakeUp(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => res.end('ok'))
  return listen(server).then(port => ({ server, port }))
}

/** A port nothing listens on right now. */
async function freePort() {
  const probe = createServer()
  const port = await listen(probe)
  await new Promise<void>(res => probe.close(() => res()))
  return port
}

/**
 * The environment for start-office with its opener under test control. POSIX:
 * a node stub named `xdg-open` and `open` that logs its argv to the returned
 * log and exits $OPEN_EXIT. Windows: the opener is explorer.exe, which cannot
 * be stubbed, so PATH is an empty dir and it is "not found" instead.
 */
function startEnv(home: string, ports: { server: number; ui: number }, openExit = 0) {
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  const openLog = join(home, 'open.jsonl')
  const env: NodeJS.ProcessEnv = { ...process.env }
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
  if (WIN) {
    env[pathKey] = bin
  } else {
    for (const name of ['xdg-open', 'open']) {
      writeFileSync(join(bin, name), `#!${NODE}\nrequire('fs').appendFileSync(process.env.OPEN_LOG, JSON.stringify(process.argv.slice(2)) + '\\n'); process.exit(Number(process.env.OPEN_EXIT))\n`)
      chmodSync(join(bin, name), 0o755)
    }
    env[pathKey] = `${bin}${delimiter}${env[pathKey] ?? ''}`
  }
  return {
    openLog,
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      AGENT_OFFICE_HOME: join(home, 'office'),
      AGENT_OFFICE_PORT: String(ports.server),
      AGENT_OFFICE_UI_PORT: String(ports.ui),
      AGENT_OFFICE_REGISTRY_DIR: join(home, 'registry'),
      AGENT_OFFICE_TASKS_DIR: join(home, 'tasks'),
      OPEN_LOG: openLog,
      OPEN_EXIT: String(openExit),
      CHAT_AI_POLL_INTERVAL: '0.2',
    } as NodeJS.ProcessEnv,
  }
}

const openCalls = (log: string) => readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))

describe('start-office.mjs', () => {
  it('runs on a box whose opener fails, reports the URL instead, and stop-office then ends it', async () => {
    const home = tempDir('agent-office-start-')
    const up = await fakeUp()
    const ui = await fakeUp()
    try {
      const { env, openLog } = startEnv(home, { server: up.port, ui: ui.port }, 1)
      const officeDir = env.AGENT_OFFICE_HOME!
      const proc = run(NODE, [START], env, false)

      await waitFor('the running banner', () => proc.out.includes('Agent Office is running!'), 15_000)
      expect(proc.child.exitCode).toBeNull()
      expect(proc.out).toContain(`Server already running on port ${up.port}`)
      expect(proc.out).toContain(`Vite already running on port ${ui.port}`)
      expect(proc.out).toContain('Chat AI watcher ready')
      expect(proc.out).toContain(`Could not open a browser automatically — open http://127.0.0.1:${ui.port} yourself`)
      // the stub opener exists only off Windows (explorer.exe cannot be stubbed)
      if (!WIN) expect(openCalls(openLog)).toEqual([[`http://127.0.0.1:${ui.port}`]])

      const pidFile = join(officeDir, 'chat-watcher.pid')
      const watcherPid = Number(readFileSync(pidFile, 'utf8'))
      recordedPids.add(watcherPid)
      expect(alive(watcherPid)).toBe(true)
      expect(existsSync(join(officeDir, 'chat-ai.log'))).toBe(true)
      expect(existsSync(join(officeDir, 'server.pid'))).toBe(false) // not ours to stop
      expect(existsSync(join(officeDir, 'vite.pid'))).toBe(false)

      const stop = await runStop(officeDir)
      expect(stop.out).toContain(`Chat watcher stopped (pid ${watcherPid})`)
      await waitFor('the watcher to exit', () => !alive(watcherPid))
      // the last child gone, start-office has nothing left to wait for
      expect(await Promise.race([proc.exited, sleep(10_000).then(() => 'hung')])).toBe(0)
    } finally {
      up.server.close()
      ui.server.close()
    }
  }, 60_000)

  // Windows has no way to deliver SIGINT to a child (kill() terminates it hard)
  it.skipIf(WIN)('tears the watcher down on Ctrl+C', async () => {
    const home = tempDir('agent-office-start-')
    const up = await fakeUp()
    const ui = await fakeUp()
    try {
      const { env } = startEnv(home, { server: up.port, ui: ui.port })
      const officeDir = env.AGENT_OFFICE_HOME!
      const proc = run(NODE, [START], env, false)
      await waitFor('the running banner', () => proc.out.includes('Agent Office is running!'), 15_000)
      const pidFile = join(officeDir, 'chat-watcher.pid')
      const watcherPid = Number(readFileSync(pidFile, 'utf8'))
      recordedPids.add(watcherPid)
      expect(alive(watcherPid)).toBe(true)

      proc.child.kill('SIGINT')
      expect(await proc.exited).toBe(130)
      expect(proc.out).toContain('Stopping Agent Office...')
      await waitFor('the watcher to exit', () => !alive(watcherPid))
      expect(existsSync(pidFile)).toBe(false)
    } finally {
      up.server.close()
      ui.server.close()
    }
  }, 60_000)

  it('opens the office with its token through a redirect page (never the tokened link on a command line)', async () => {
    const home = tempDir('agent-office-start-token-')
    const officeDir = join(home, 'office')
    // A real office answers /health (open-office.mjs asks it); Vite "already running"
    const office = await loadOffice({ dir: officeDir })
    const port = await listen(office.server.httpServer)
    writeFileSync(join(officeDir, 'auth-token'), office.server.AUTH_TOKEN, { mode: 0o600 })
    const ui = await fakeUp()
    try {
      const { env, openLog } = startEnv(home, { server: port, ui: ui.port })
      const proc = run(NODE, [START], env, false)
      await waitFor('the running banner', () => proc.out.includes('Agent Office is running!'), 20_000)
      const page = join(officeDir, 'open-office.html')
      const link = `http://127.0.0.1:${ui.port}/#token=${office.server.AUTH_TOKEN}`
      expect(proc.out).toContain(`Agent Office: ${link}`)
      expect(readFileSync(page, 'utf8')).toContain(link)
      // the stub opener exists only off Windows (explorer.exe cannot be stubbed)
      if (!WIN) expect(openCalls(openLog)).toEqual([[`file://${page}`]])
      recordedPids.add(Number(readFileSync(join(officeDir, 'chat-watcher.pid'), 'utf8')))
      await runStop(officeDir)
      expect(await Promise.race([proc.exited, sleep(10_000).then(() => 'hung')])).toBe(0)
    } finally {
      ui.server.close()
      await new Promise<void>(res => office.server.wss.close(() => res()))
      await new Promise<void>(res => office.server.httpServer.close(() => res()))
    }
  }, 60_000)

  it('starts the server itself, records its pid, and stop-office ends it', async () => {
    const home = tempDir('agent-office-start-server-')
    const port = await freePort()
    const ui = await fakeUp()
    try {
      const { env } = startEnv(home, { server: port, ui: ui.port })
      const officeDir = env.AGENT_OFFICE_HOME!
      const proc = run(NODE, [START], env, false)
      await waitFor('the running banner', () => proc.out.includes('Agent Office is running!'), 30_000)
      expect(proc.out).toContain('Server ready')
      const serverPid = Number(readFileSync(join(officeDir, 'server.pid'), 'utf8'))
      recordedPids.add(serverPid)
      recordPids(officeDir)
      expect(alive(serverPid)).toBe(true)
      expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true)

      const stop = await runStop(officeDir, { AGENT_OFFICE_PORT: String(port), AGENT_OFFICE_UI_PORT: String(ui.port) })
      expect(stop.out).toContain(`Server stopped (pid ${serverPid})`)
      await waitFor('the server to exit', () => !alive(serverPid))
      expect(await fetch(`http://127.0.0.1:${port}/health`).then(() => true, () => false)).toBe(false)
      expect(existsSync(join(officeDir, 'server.pid'))).toBe(false)
      expect(await Promise.race([proc.exited, sleep(10_000).then(() => 'hung')])).toBe(0)
    } finally {
      ui.server.close()
    }
  }, 90_000)
})

describe('after the tests', () => {
  it('no process they started is left running', async () => {
    for (const p of procs) await p.stop()
    // fixtures: anything whose command line still carries MARK
    const lines = WIN
      ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.CommandLine }`], { encoding: 'utf8', maxBuffer: 64 << 20 })
      : execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', maxBuffer: 64 << 20 })
    const mine = lines.split(/\r?\n/).filter(l => l.includes(MARK))
    expect(mine).toEqual([])
    // the processes start-office launched, by their recorded pids
    for (const pid of recordedPids) expect(alive(pid)).toBe(false)
  }, 60_000)
})

