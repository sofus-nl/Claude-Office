#!/usr/bin/env node
/**
 * start-office.mjs — Start Agent Office (server + UI) and open in browser
 *
 * If the packaged Electron app exists (release/mac/Agent Office.app or the
 * --dir output at release/mac-unpacked/Agent Office.app), launch it directly —
 * the app manages the server internally.
 *
 * Otherwise fall back to the dev workflow: start the Express server and Vite
 * separately.
 *
 * The office opens with its token (scripts/open-office.mjs, the same as
 * `npm run open`): without it the page shows the office read-only. The
 * browser gets a redirect page in $AGENT_OFFICE_HOME rather than the tokened
 * link itself, so the token never shows up on a command line in `ps`.
 *
 * Every process this script starts gets its own process group (POSIX) or its
 * own tree (Windows) and a pid file under $AGENT_OFFICE_HOME (~/.agent-office):
 * server.pid, vite.pid and chat-watcher.pid. stop-office.mjs — and the Ctrl+C
 * handler here — stop exactly those processes, never "whatever is on port 3334".
 * Windows does not pass Ctrl+C on to detached children, so the handler there
 * runs `taskkill /T /F` on each of them.
 *
 * Node and Vite are spawned without a shell (npm is npm.cmd on Windows, which
 * cannot be): `node server/index.js` and `node node_modules/vite/bin/vite.js`.
 *
 * Environment (all optional):
 *   AGENT_OFFICE_HOME      state dir (default ~/.agent-office)
 *   AGENT_OFFICE_PORT      office server port (default 3334)
 *   AGENT_OFFICE_UI_PORT   Vite dev server port (default 3333)
 */

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPort, readUiPort } from '../server/config.js'
import { openerFor, openOffice } from './open-office.mjs'
import { WATCHER_PATTERN, cmdlineOf, terminate } from './stop-office.mjs'

const WIN = process.platform === 'win32'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = dirname(SCRIPT_DIR)

const RUNTIME_DIR = process.env.AGENT_OFFICE_HOME || join(homedir(), '.agent-office')
const SERVER_PORT = readPort(process.env, { warn: m => console.error(m) })
const UI_PORT = readUiPort(process.env, { warn: m => console.error(m) })
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`
const UI_URL = `http://127.0.0.1:${UI_PORT}`

const SERVER_PID_FILE = join(RUNTIME_DIR, 'server.pid')
const VITE_PID_FILE = join(RUNTIME_DIR, 'vite.pid')
const WATCHER_PID_FILE = join(RUNTIME_DIR, 'chat-watcher.pid')
const CHAT_AI_LOG = join(RUNTIME_DIR, 'chat-ai.log')

const GREEN = '\x1b[0;32m'
const YELLOW = '\x1b[1;33m'
const CYAN = '\x1b[0;36m'
const RESET = '\x1b[0m'

const sleep = ms => new Promise(r => setTimeout(r, ms))

mkdirSync(RUNTIME_DIR, { recursive: true })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** GET url within 1.5 s: true on a 2xx answer (the `curl -sf` this replaces). */
async function answers(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return false
  }
}

/**
 * Open a URL (or .app) with whatever this platform has. Never fails the
 * script: on a box without an opener it just prints the address.
 */
async function openTarget(target) {
  const [command, args] = openerFor(process.platform, target)
  const opened = await new Promise(resolve => {
    let child
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    } catch {
      return resolve(false)
    }
    child.once('error', () => resolve(false))
    // explorer.exe exits 1 even when it opened the page
    child.once('exit', code => resolve(WIN || code === 0))
    setTimeout(() => { child.unref(); resolve(true) }, 3000).unref()
  })
  if (!opened) console.log(`${YELLOW}[info]${RESET} Could not open a browser automatically — open ${target} yourself`)
}

// Children and pid files of this run, for the exit handler
const started = []
const startedPidFiles = []

/** Start node `args` detached (own group / tree) and note it for cleanup. */
function spawnOwn(args, stdout = 'inherit') {
  const child = spawn(process.execPath, args, { cwd: PROJECT_DIR, detached: true, windowsHide: true, stdio: ['ignore', stdout, stdout] })
  started.push(child)
  return child
}

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  for (const child of started) {
    if (WIN) {
      // a pid that already exited may belong to someone else by now
      if (child.exitCode === null && child.signalCode === null) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      }
    } else {
      try { process.kill(-child.pid, 'SIGTERM') } catch { try { process.kill(child.pid, 'SIGTERM') } catch {} }
    }
  }
  for (const file of startedPidFiles) rmSync(file, { force: true })
}

function onInterrupt() {
  console.log('')
  console.log(`${CYAN}[...]${RESET} Stopping Agent Office...`)
  cleanup()
  process.exit(130)
}
// An early abort tears the children down rather than orphaning them
process.on('exit', cleanup)
for (const sig of WIN ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, onInterrupt)

// Stop a watcher left by a previous run — by its pid file, never by a
// pattern that would also hit editors or shells mentioning the script.
async function stopStaleWatcher() {
  let text
  try { text = readFileSync(WATCHER_PID_FILE, 'utf8').trim() } catch { return }
  rmSync(WATCHER_PID_FILE, { force: true })
  if (!/^\d+$/.test(text) || Number(text) <= 1) return
  if (WATCHER_PATTERN.test(await cmdlineOf(Number(text)))) {
    await terminate(Number(text))
    console.log(`${CYAN}[...]${RESET} Stopped previous chat watcher (pid ${text})`)
  }
}

// ---------------------------------------------------------------------------
// Check for a packaged Electron build
// Electron-builder places the .app at:
//   release/<mac|mac-arm64>/Agent Office.app        (DMG build)
//   release/mac-unpacked/Agent Office.app           (--dir / pack build)
// ---------------------------------------------------------------------------

const electronApp = ['release/mac/Agent Office.app', 'release/mac-arm64/Agent Office.app', 'release/mac-unpacked/Agent Office.app']
  .map(candidate => join(PROJECT_DIR, candidate))
  .find(candidate => existsSync(candidate))

if (electronApp) {
  console.log(`${GREEN}[ok]${RESET} Found packaged app: ${electronApp}`)
  console.log(`${CYAN}[...]${RESET} Launching Agent Office...`)
  await openTarget(electronApp)
  console.log('')
  console.log(`${GREEN}Agent Office launched!${RESET}`)
  console.log('  The app manages the server internally and opens the office with its token.')
  console.log('  To open the same office in a browser: npm run open')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Dev fallback — separate server + Vite
// ---------------------------------------------------------------------------

console.log(`${CYAN}[info]${RESET} No packaged app found — starting in dev mode`)
console.log("       (Run 'npm run pack' to build the Electron app)")
console.log('')

// Check if server is already running
if (await answers(`${SERVER_URL}/health`)) {
  console.log(`${GREEN}[ok]${RESET} Server already running on port ${SERVER_PORT}`)
} else {
  console.log(`${CYAN}[...]${RESET} Starting WebSocket server...`)
  const server = spawnOwn(['server/index.js'])
  writeFileSync(SERVER_PID_FILE, `${server.pid}\n`)
  startedPidFiles.push(SERVER_PID_FILE)
  // Wait for server to be ready
  for (let i = 0; i < 10; i++) {
    if (await answers(`${SERVER_URL}/health`)) {
      console.log(`${GREEN}[ok]${RESET} Server ready (PID: ${server.pid})`)
      break
    }
    await sleep(500)
  }
}

// Check if Vite is already running
if (await answers(UI_URL)) {
  console.log(`${GREEN}[ok]${RESET} Vite already running on port ${UI_PORT}`)
} else {
  console.log(`${CYAN}[...]${RESET} Starting Vite dev server...`)
  const vite = spawnOwn([join('node_modules', 'vite', 'bin', 'vite.js'), '--port', String(UI_PORT)])
  writeFileSync(VITE_PID_FILE, `${vite.pid}\n`)
  startedPidFiles.push(VITE_PID_FILE)
  // Wait for Vite to be ready
  for (let i = 0; i < 15; i++) {
    if (await answers(UI_URL)) {
      console.log(`${GREEN}[ok]${RESET} Vite ready (PID: ${vite.pid})`)
      break
    }
    await sleep(500)
  }
}

// Start chat AI watcher in background (stop a stale one first)
await stopStaleWatcher()
console.log(`${CYAN}[...]${RESET} Starting chat AI watcher (log: ${CHAT_AI_LOG})...`)
const logFd = openSync(CHAT_AI_LOG, 'a')
spawnOwn([join(SCRIPT_DIR, 'chat-ai-watcher.mjs')], logFd)
closeSync(logFd)
startedPidFiles.push(WATCHER_PID_FILE)
// The watcher writes its own pid file; give a loaded machine a few seconds
for (let i = 0; i < 30 && !existsSync(WATCHER_PID_FILE); i++) await sleep(100)
if (existsSync(WATCHER_PID_FILE)) {
  console.log(`${GREEN}[ok]${RESET} Chat AI watcher ready (PID: ${readFileSync(WATCHER_PID_FILE, 'utf8').trim()})`)
} else {
  console.log(`${YELLOW}[warn]${RESET} Chat AI watcher may not have started (see ${CHAT_AI_LOG})`)
}

// Open in browser, with the office token (the bare address when there is no
// token to open it with: the office then shows read-only)
console.log(`${CYAN}[...]${RESET} Opening Agent Office...`)
if (await openOffice({ dev: true }) !== 0) await openTarget(UI_URL)

console.log('')
console.log(`${GREEN}Agent Office is running!${RESET}`)
console.log(`  Office: ${UI_URL}  (another browser: npm run open)`)
console.log(`  Server: http://127.0.0.1:${SERVER_PORT}`)
console.log('  Chat AI: toggle on/off from the UI')
console.log('')
console.log('Press Ctrl+C to stop all services')

// The children keep this process alive (Ctrl+C runs onInterrupt and stops them)
