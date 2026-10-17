#!/usr/bin/env node
/**
 * stop-office.mjs — Shut down the Agent Office processes start-office.mjs started
 *
 * Reads the pid files written under $AGENT_OFFICE_HOME (~/.agent-office):
 *   chat-watcher.pid   chat AI watcher (written by chat-ai-watcher.mjs)
 *   server.pid         WebSocket/HTTP server (written by start-office.mjs)
 *   vite.pid           Vite dev server     (written by start-office.mjs)
 *
 * Only those processes — and their process trees — are stopped, after a
 * check that the pid still belongs to an office process. Browsers holding a
 * WebSocket to :3334, the Electron app, or an unrelated Vite on :3333 are
 * left alone.
 *
 * Usage:
 *   node scripts/stop-office.mjs            # stop by pid file
 *   node scripts/stop-office.mjs --force    # additionally kill whatever is
 *                                           # LISTENING on the office ports
 *
 * Environment (all optional):
 *   AGENT_OFFICE_HOME      state dir (default ~/.agent-office)
 *   AGENT_OFFICE_PORT      office server port (default 3334)
 *   AGENT_OFFICE_UI_PORT   Vite dev server port (default 3333)
 *
 * POSIX signals the process group (SIGTERM, then SIGKILL after a grace
 * period). Windows has no process groups: `taskkill /T /F` takes the tree.
 * The ownership check reads the command line with `ps` (POSIX) or CIM
 * (Windows); --force finds listeners with lsof, ss or fuser (POSIX) or
 * Get-NetTCPConnection (Windows; netstat prints localised state names).
 */

import { execFile } from 'node:child_process'
import { readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPort, readUiPort } from '../server/config.js'

const WIN = process.platform === 'win32'

const GREEN = '\x1b[0;32m'
const YELLOW = '\x1b[1;33m'
const CYAN = '\x1b[0;36m'
const RESET = '\x1b[0m'

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** The chat watcher's command line (the .sh one of an older install too). */
export const WATCHER_PATTERN = /chat-(ai-)?watcher\.(sh|mjs)/
// Only what start-office runs (`node server/index.js`, `node …/vite/bin/vite.js --port`,
// or the .sh's `npx vite --port`): a bare "node" would let a stale pid file name any node
// process, and on Windows its whole tree would be force-killed
const SERVER_PATTERN = /server[\\/]index\.js/
const VITE_PATTERN = /vite[\\/]bin[\\/]vite\.js|\bvite --port\b/

/** execFile without a shell: { err, stdout }, never rejects. */
const run = (cmd, args) => new Promise(resolve =>
  execFile(cmd, args, { windowsHide: true, timeout: 20_000 }, (err, stdout) => resolve({ err, stdout: String(stdout ?? '') })))

const powershell = script => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])

export function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Command line of a pid, empty if it is gone (or unreadable). */
export async function cmdlineOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return ''
  const { stdout } = WIN
    ? await powershell(`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`)
    : await run('ps', ['-o', 'args=', '-p', String(pid)])
  return stdout.trim()
}

/** Ask a process and everything under it to stop (`hard`: make it). */
export async function terminate(pid, hard = false) {
  if (WIN) {
    await run('taskkill', ['/PID', String(pid), '/T', '/F'])
    return
  }
  // Its process group first (vite, watcher -> claude ...), then the pid itself
  for (const target of [-pid, pid]) {
    try { process.kill(target, hard ? 'SIGKILL' : 'SIGTERM') } catch {}
  }
}

const pidsIn = text => [...new Set(text.match(/\d+/g) ?? [])].map(Number)

/** Pids LISTENING on TCP port `port` (not clients connected to it). */
async function listenersOnPort(port) {
  if (!/^\d{1,5}$/.test(String(port))) return []
  if (WIN) {
    const { stdout } = await powershell(`Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`)
    return pidsIn(stdout)
  }
  let r = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
  if (r.err?.code !== 'ENOENT') return pidsIn(r.stdout)
  r = await run('ss', ['-ltnpH', `sport = :${port}`])
  if (r.err?.code !== 'ENOENT') return pidsIn((r.stdout.match(/pid=\d+/g) ?? []).join(' '))
  r = await run('fuser', ['-n', 'tcp', String(port)])
  if (r.err?.code !== 'ENOENT') return pidsIn(r.stdout)
  console.error(`${YELLOW}[warn]${RESET} --force needs lsof, ss or fuser to find listeners on :${port}`)
  return []
}

async function main(args) {
  const runtimeDir = process.env.AGENT_OFFICE_HOME || join(homedir(), '.agent-office')
  const serverPort = readPort(process.env, { warn: m => console.error(m) })
  const uiPort = readUiPort(process.env, { warn: m => console.error(m) })

  let force = false
  for (const arg of args) {
    if (arg === '-f' || arg === '--force') force = true
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/stop-office.mjs [--force]')
      console.log('  Stops the processes recorded in $AGENT_OFFICE_HOME/{chat-watcher,server,vite}.pid.')
      console.log(`  --force  also kill whatever is listening on :${serverPort} and :${uiPort}`)
      return 0
    } else {
      console.error(`Unknown option: ${arg} (try --help)`)
      return 2
    }
  }

  console.log('')
  console.log(`${CYAN}╔═══════════════════════════════════════════╗${RESET}`)
  console.log(`${CYAN}║    Agent Office — Shutting Down            ║${RESET}`)
  console.log(`${CYAN}╚═══════════════════════════════════════════╝${RESET}`)
  console.log('')

  let stopped = 0

  // Stop the process named in `file` if it is alive and its command line
  // matches `pattern`. The pid file is removed either way (a stale one is
  // just noise).
  async function stopPidfile(label, file, pattern) {
    let raw
    try { raw = readFileSync(file, 'utf8') } catch {
      console.log(`${YELLOW}[skip]${RESET} ${label}: no pid file`)
      return
    }
    rmSync(file, { force: true })
    const text = raw.replace(/\s/g, '')
    const pid = Number(text)
    if (!/^\d+$/.test(text) || pid <= 1) {
      console.log(`${YELLOW}[skip]${RESET} ${label}: pid file was empty or invalid`)
      return
    }
    if (!isAlive(pid)) {
      console.log(`${YELLOW}[skip]${RESET} ${label} not running (pid ${pid})`)
      return
    }
    const cmd = await cmdlineOf(pid)
    if (!pattern.test(cmd)) {
      console.log(`${YELLOW}[skip]${RESET} ${label}: pid ${pid} is not an office process (${cmd || '?'}) — stale pid file removed, nothing killed`)
      return
    }

    await terminate(pid)
    for (let i = 0; i < 15 && isAlive(pid); i++) await sleep(200)
    if (isAlive(pid)) {
      await terminate(pid, true)
      console.log(`${GREEN}[ok]${RESET} ${label} killed (pid ${pid} did not exit on SIGTERM)`)
    } else {
      console.log(`${GREEN}[ok]${RESET} ${label} stopped (pid ${pid})`)
    }
    stopped++
  }

  // --force: kill the listeners on a port, whatever they are
  async function forceStopPort(label, port) {
    const pids = (await listenersOnPort(port)).filter(pid => pid > 1 && pid !== process.pid)
    if (pids.length === 0) {
      console.log(`${YELLOW}[skip]${RESET} --force: nothing listening on :${port}`)
      return
    }
    for (const pid of pids) {
      const cmd = await cmdlineOf(pid)
      let killed
      if (WIN) killed = !(await run('taskkill', ['/PID', String(pid), '/F'])).err
      else {
        try { process.kill(pid, 'SIGTERM'); killed = true } catch { killed = false }
      }
      if (killed) {
        console.log(`${GREEN}[ok]${RESET} --force: killed pid ${pid} listening on :${port} (${label}: ${cmd})`)
        stopped++
      }
    }
  }

  await stopPidfile('Chat watcher', join(runtimeDir, 'chat-watcher.pid'), WATCHER_PATTERN)
  await stopPidfile('Server', join(runtimeDir, 'server.pid'), SERVER_PATTERN)
  await stopPidfile('Vite dev server', join(runtimeDir, 'vite.pid'), VITE_PATTERN)

  // --force: whatever still listens on the office ports
  if (force) {
    await forceStopPort('server', serverPort)
    await forceStopPort('vite', uiPort)
  }

  console.log('')
  if (stopped > 0) {
    console.log(`${GREEN}Office closed. ${stopped} process(es) stopped.${RESET}`)
  } else {
    console.log(`${YELLOW}Nothing was running.${RESET}`)
    if (!force) {
      console.log(`  (Started the server some other way? node scripts/stop-office.mjs --force kills whatever listens on :${serverPort} / :${uiPort}.)`)
    }
  }
  console.log('')
  return 0
}

function isMainModule() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) process.exitCode = await main(process.argv.slice(2))
