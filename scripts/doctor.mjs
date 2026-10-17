#!/usr/bin/env node
/**
 * doctor.mjs — `npm run doctor`: why does nothing appear in the office?
 *
 * One PASS / WARN / FAIL line per check, the install / uninstall / start
 * commands at the end, exit 1 when anything FAILed. Nothing here writes.
 *
 *   node         a version the server and better-sqlite3 run on (20+)
 *   hooks        ~/.claude/settings.json — or $CLAUDE_CONFIG_DIR/settings.json —
 *                runs hooks/agent-tracker.mjs for every event the installer
 *                registers, from a file that exists. Same rule as
 *                hooks/install-hooks.mjs: an entry is ours when a word of its
 *                command is a path ending in hooks/agent-tracker.mjs (or the
 *                bash installer's .sh), whatever interpreter runs it. Or the
 *                agent-office plugin is
 *                installed: enabledPlugins in settings.json plus a copy under
 *                plugins/ (installed_plugins.json, cache/, marketplaces/). On
 *                macOS / Linux a plugin's hooks run bare `node`: WARN when a
 *                non-login shell's PATH does not find it.
 *   status line  statusLine + subagentStatusLine run hooks/status-line.mjs —
 *                the meters; a plugin cannot register statusLine, so plugin
 *                installs are pointed at npm run install-status-line (the
 *                status line alone: the installer's hooks next to the
 *                plugin's would deliver every event twice)
 *   server       GET http://127.0.0.1:$AGENT_OFFICE_PORT/health answers, and
 *                whether a hook has reached it since it started
 *   token        $AGENT_OFFICE_HOME/auth-token exists and is mode 0600 (not
 *                checked on Windows: the user-profile ACL keeps it private)
 *   dist         the UI is built (npm run build); else Vite on :3333 is the way in
 *
 * `runDoctor(opts)` is exported and returns the results without printing, so
 * tests/doctor.test.ts drives it against temp directories; the tests also
 * spawn the script for its exit code. `--json` prints the results as JSON.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOGIN_PATH, scriptPathIn, shellWords, which } from '../hooks/install-hooks.mjs'

// The installer's own rule for what is ours (command splitting, either script form, any interpreter)
export { scriptPathIn, shellWords, which }

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TRACKER_NAME = 'agent-tracker.mjs'
const STATUS_NAME = 'status-line.mjs'
// better-sqlite3 12 (package.json) ships builds for Node 20.x and up
export const MIN_NODE_MAJOR = 20
export const DEFAULT_PORT = 3334
const PLUGIN_NAME = 'agent-office'

export const PASS = 'PASS'
export const WARN = 'WARN'
export const FAIL = 'FAIL'

export const COMMANDS = {
  install:   'npm run install-hooks',
  hooksOnly: 'node hooks/install-hooks.mjs --no-status-line',
  statusLine: 'npm run install-status-line',
  uninstall: 'npm run uninstall-hooks',
  uninstallHooks: 'npm run uninstall-hooks -- --no-status-line',
  plugin:    'claude plugin marketplace add W17ant/Claude-Office && claude plugin install agent-office@agent-office',
  unplugin:  'claude plugin uninstall agent-office@agent-office',
  start:     'npm run build && npm run server',
  startAlt:  'node scripts/start-office.mjs',
  dev:       'npm run dev',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const result = (level, title, ...notes) => ({ level, title, notes: notes.filter(Boolean) })

/** { value } | { missing: true } | { error } */
function readJson(path) {
  if (!existsSync(path)) return { missing: true }
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** ~ and $HOME as a shell would expand them in a hook command (~\ too, for a Windows path) */
function expandHome(p, home) {
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2))
  return p.replace(/^\$\{?HOME\}?(?=[\\/]|$)/, home)
}

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return resolve(a) === resolve(b)
  }
}

export function formatSpan(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, '0')} min`
  return `${Math.floor(h / 24)} d`
}

/** The events the installer registers: hooks/hooks.json is the plugin's copy of the same list (tests/plugin.test.ts keeps them equal). */
export function expectedEvents(root = ROOT) {
  const { value } = readJson(join(root, 'hooks', 'hooks.json'))
  return value?.hooks && typeof value.hooks === 'object' ? Object.keys(value.hooks) : []
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export function checkNode(version = process.versions.node) {
  const major = Number(version.split('.')[0])
  if (major >= MIN_NODE_MAJOR) return result(PASS, `node v${version}`)
  return result(FAIL, `node v${version} — the server (better-sqlite3) needs Node ${MIN_NODE_MAJOR}+; install a current LTS`)
}

/**
 * What settings.json says about our hooks: per event, the entries whose
 * command names agent-tracker.sh, with the path each runs and whether it exists.
 */
export function inspectHooks(settings, { events, tracker, home }) {
  const hooks = settings && typeof settings === 'object' && settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
  const perEvent = new Map()
  for (const event of events) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : hooks[event] && typeof hooks[event] === 'object' ? [hooks[event]] : []
    const entries = []
    for (const group of groups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue
      for (const h of group.hooks) {
        const raw = h && typeof h === 'object' ? scriptPathIn(h.command, TRACKER_NAME) : null
        if (raw === null) continue
        const path = expandHome(raw, home)
        entries.push({ command: h.command, path, exists: existsSync(path), current: existsSync(path) && samePath(path, tracker) })
      }
    }
    perEvent.set(event, entries)
  }
  const registered = events.filter(e => perEvent.get(e).length > 0)
  const missing = events.filter(e => perEvent.get(e).length === 0)
  const duplicated = events.filter(e => perEvent.get(e).length > 1)
  const all = events.flatMap(e => perEvent.get(e))
  const dead = [...new Set(all.filter(x => !x.exists).map(x => x.path))]
  const foreign = [...new Set(all.filter(x => x.exists && !x.current).map(x => x.path))]
  const paths = [...new Set(all.map(x => x.path))]
  return { perEvent, registered, missing, duplicated, dead, foreign, paths, any: registered.length > 0 }
}

/**
 * Is the agent-office plugin installed? Enabled in settings.json
 * (`enabledPlugins["agent-office@<marketplace>"]`) and present on disk: the
 * installPath from plugins/installed_plugins.json, a version under
 * plugins/cache/<marketplace>/agent-office/, or the marketplace clone under
 * plugins/marketplaces/ (this repository is its own marketplace).
 */
export function inspectPlugin(settings, configDir) {
  const enabledPlugins = settings && typeof settings === 'object' && settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {}
  const enabledKey = Object.keys(enabledPlugins).find(k => (k === PLUGIN_NAME || k.startsWith(`${PLUGIN_NAME}@`)) && enabledPlugins[k]) ?? null
  const disabledKey = enabledKey ? null : Object.keys(enabledPlugins).find(k => k === PLUGIN_NAME || k.startsWith(`${PLUGIN_NAME}@`)) ?? null

  const copies = []
  const consider = (dir, source) => {
    // A plugin copy from before the Node port has hooks/agent-tracker.sh only
    const tracker = [TRACKER_NAME, 'agent-tracker.sh'].map(name => join(dir, 'hooks', name)).find(existsSync)
    if (tracker) copies.push({ dir, tracker, source })
  }
  const pluginsDir = join(configDir, 'plugins')

  const installed = readJson(join(pluginsDir, 'installed_plugins.json')).value
  const entries = installed && typeof installed === 'object' && installed.plugins && typeof installed.plugins === 'object' ? installed.plugins : {}
  for (const [key, val] of Object.entries(entries)) {
    if (!(key === PLUGIN_NAME || key.startsWith(`${PLUGIN_NAME}@`))) continue
    for (const rec of Array.isArray(val) ? val : [val]) {
      if (rec && typeof rec === 'object' && typeof rec.installPath === 'string') consider(rec.installPath, 'installed_plugins.json')
    }
  }

  const cache = join(pluginsDir, 'cache')
  if (existsSync(cache)) {
    for (const marketplace of safeReaddir(cache)) {
      const pluginDir = join(cache, marketplace, PLUGIN_NAME)
      if (!existsSync(pluginDir)) continue
      for (const version of safeReaddir(pluginDir)) consider(join(pluginDir, version), `plugins/cache/${marketplace}/${PLUGIN_NAME}/${version}`)
    }
  }

  const marketplaces = join(pluginsDir, 'marketplaces')
  if (existsSync(marketplaces)) {
    for (const name of safeReaddir(marketplaces)) {
      const dir = join(marketplaces, name)
      const manifest = readJson(join(dir, '.claude-plugin', 'plugin.json')).value
      if (manifest?.name === PLUGIN_NAME) consider(dir, `plugins/marketplaces/${name}`)
    }
  }

  return { enabledKey, disabledKey, copies, found: !!enabledKey && copies.length > 0 }
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** The hook lines: settings.json hooks and/or the plugin. */
export function checkHooks({ settingsPath, settings, settingsState, events, tracker, home, configDir, fallback, platform = process.platform, loginPath = LOGIN_PATH, path = process.env.PATH ?? '' }) {
  const out = []
  const hooks = inspectHooks(settings, { events, tracker, home })
  const plugin = inspectPlugin(settings, configDir)
  const n = events.length

  if (settingsState?.error) out.push(result(FAIL, `settings: ${settingsPath} is not valid JSON (${settingsState.error}) — Claude Code ignores it; fix it, then ${COMMANDS.install}`))

  if (hooks.any) {
    const where = hooks.paths.length === 1 ? hooks.paths[0] : `${hooks.paths.length} different paths`
    if (hooks.dead.length) {
      out.push(result(FAIL, `hooks: ${n - hooks.missing.length}/${n} events registered in ${settingsPath}, but they run a file that does not exist: ${hooks.dead.join(', ')}`,
        `Claude Code reports a hook error on every tool call and the office hears nothing — ${COMMANDS.install} repoints them at this checkout`))
    } else if (hooks.missing.length) {
      out.push(result(WARN, `hooks: ${hooks.registered.length}/${n} events run ${where} (missing: ${hooks.missing.join(', ')})`,
        `an older install — ${COMMANDS.install} adds the rest`))
    } else {
      out.push(result(PASS, `hooks: ${n}/${n} events run ${where}`))
    }
    if (hooks.foreign.length) {
      out.push(result(WARN, `hooks: ${hooks.foreign.join(', ')} is not this checkout's hooks/${TRACKER_NAME} (${tracker})`,
        `fine if that clone is the one you mean to use; ${COMMANDS.install} here repoints them`))
    }
    if (hooks.duplicated.length) {
      out.push(result(WARN, `hooks: registered twice for ${hooks.duplicated.join(', ')} — every agent arrives twice`,
        `${COMMANDS.install} drops the duplicate`))
    }
  }

  if (plugin.found) {
    const copy = plugin.copies[0]
    if (hooks.any) {
      out.push(result(WARN, `plugin ${plugin.enabledKey} is installed as well (${copy.source}) — plugin hooks merge with the settings hooks, so every agent arrives twice`,
        `keep one: ${COMMANDS.uninstallHooks} takes the installer's hooks out and keeps the status line (the meters), or ${COMMANDS.unplugin}`))
    } else {
      out.push(result(PASS, `plugin ${plugin.enabledKey}: enabled, hooks run ${copy.tracker}`))
    }
    // The plugin's hooks.json runs bare `node`; a shell without the login PATH (nvm, a GUI-launched Claude Code) may not find it
    if (platform !== 'win32' && !which('node', loginPath)) {
      out.push(result(WARN, `plugin ${plugin.enabledKey}: its hooks run bare \`node\`, which a non-login shell's PATH (${loginPath}) does not find — Claude Code started from a GUI, or with node only from nvm, reports a hook error on every event`,
        `${COMMANDS.install} writes the absolute path of this node into the hooks instead (then ${COMMANDS.unplugin}, or every agent arrives twice), or put node on that PATH, e.g. ln -s "${process.execPath}" /usr/local/bin/node`))
    }
  } else if (plugin.enabledKey) {
    out.push(result(hooks.any ? WARN : FAIL, `plugin ${plugin.enabledKey} is enabled in ${settingsPath} but no installed copy was found under ${join(configDir, 'plugins')}`,
      `${COMMANDS.plugin}`))
  } else if (!hooks.any) {
    const notes = [
      plugin.disabledKey ? `the plugin ${plugin.disabledKey} is installed but disabled: claude plugin enable ${plugin.disabledKey}` : null,
      !plugin.disabledKey && plugin.copies.length ? `a plugin copy exists at ${plugin.copies[0].dir} but is not enabled: ${COMMANDS.plugin}` : null,
      fallback?.any ? `they are in ${fallback.path} — but CLAUDE_CONFIG_DIR is set, so Claude Code reads ${settingsPath}; ${COMMANDS.install} with CLAUDE_CONFIG_DIR set writes them there (CLAUDE_CONFIG_DIR= ${COMMANDS.uninstall} takes the old ones out)` : null,
      `${COMMANDS.install} registers them (or install the plugin: ${COMMANDS.plugin})`,
    ]
    const what = settingsState?.missing ? `${settingsPath} does not exist` : `nothing in ${settingsPath} runs hooks/${TRACKER_NAME}`
    out.push(result(FAIL, `hooks: not installed — ${what}, and no agent-office plugin is enabled`, ...notes))
  }

  // On Windows every office hook runs bare `node` (install-hooks nodeCommand): it has to be on the PATH Claude Code inherits
  if (platform === 'win32' && (hooks.any || plugin.found) && !which('node.exe', path)) {
    out.push(result(WARN, 'hooks: they run `node`, but node.exe is not on PATH — Claude Code reports a hook error on every event',
      `add the folder of ${process.execPath} to your user PATH, then restart Claude Code`))
  }

  return { results: out, hooks, plugin }
}

/** The status line: statusLine + subagentStatusLine running hooks/status-line.sh. */
export function checkStatusLine({ settings, statusScript, home, pluginOnly }) {
  const s = settings && typeof settings === 'object' ? settings : {}
  // Next to the plugin the full installer would register every hook a second time
  const fix = pluginOnly ? COMMANDS.statusLine : COMMANDS.install
  const entry = (key) => {
    const cur = s[key]
    const raw = cur && typeof cur === 'object' ? scriptPathIn(cur.command, STATUS_NAME) : null
    if (raw === null) return { ours: false, other: cur && typeof cur === 'object' && typeof cur.command === 'string' ? cur.command : null }
    const path = expandHome(raw, home)
    return { ours: true, path, exists: existsSync(path), current: existsSync(path) && samePath(path, statusScript) }
  }
  const main = entry('statusLine')
  const sub = entry('subagentStatusLine')

  if (main.ours && !main.exists) {
    return result(FAIL, `status line: statusLine runs ${main.path}, which does not exist — Claude Code shows an error instead of a status line`, `${fix} repoints it`)
  }
  if (main.ours) {
    const notes = [
      !sub.ours ? `subagentStatusLine is not registered (subagent token rows) — ${fix} adds it` : null,
      !main.current ? `(not this checkout's hooks/${STATUS_NAME}: ${main.path})` : null,
    ]
    return result(sub.ours ? PASS : WARN, `status line: statusLine${sub.ours ? ' + subagentStatusLine' : ''} run ${main.path}`, ...notes)
  }
  if (pluginOnly) {
    return result(WARN, 'status line: not registered — a plugin cannot set statusLine, so the payroll / electricity / memory meters stay hidden',
      `${COMMANDS.statusLine} from a clone adds it and nothing else (the hooks stay with the plugin; ${COMMANDS.install} would register them a second time)`)
  }
  return result(WARN, 'status line: not registered — the payroll / electricity / memory meters stay hidden',
    main.other ? `${COMMANDS.install} adds it and chains the one you have (${main.other})` : `${COMMANDS.install} adds it`)
}

/** GET /health: is the server up, has it seen hooks. */
export async function checkServer({ port = DEFAULT_PORT, fetchImpl = globalThis.fetch, timeoutMs = 2000, now = Date.now() } = {}) {
  const url = `http://127.0.0.1:${port}/health`
  let body
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { results: [result(WARN, `server: ${url} answered HTTP ${res.status} — something else is listening on :${port}?`)], up: false }
    body = await res.json()
  } catch {
    return {
      results: [result(WARN, `server: nothing answers on ${url} — the office server is not running`, `start it: ${COMMANDS.start}  (or ${COMMANDS.startAlt})`)],
      up: false,
    }
  }
  if (!body || body.status !== 'ok') {
    return { results: [result(WARN, `server: ${url} did not answer like the office server — something else on :${port}?`)], up: false }
  }
  const out = []
  const version = body.version ? `v${body.version}` : '(version unknown — older server)'
  const up = typeof body.uptimeMs === 'number' ? `, up ${formatSpan(body.uptimeMs)}` : ''
  out.push(result(PASS, `server: ${version}${up} on :${port} — ${body.sessions ?? '?'} session(s), ${body.agents ?? 0} agent(s), ${body.clients ?? 0} office window(s) connected`,
    body.clients === 0 ? `no office window is connected: npm run open opens it with the office token (or the link the server printed; npm run open -- --dev for Vite on :3333 under ${COMMANDS.dev})` : null))
  if (typeof body.hooksSeen !== 'number') {
    out.push(result(WARN, 'server: this server predates hook counting — restart it from this checkout to see whether hooks arrive'))
  } else if (body.hooksSeen > 0) {
    out.push(result(PASS, `hooks reaching the server: ${body.hooksSeen} since it started, last ${formatSpan(now - body.lastHookAt)} ago`))
  } else {
    out.push(result(WARN, `hooks reaching the server: none since it started${up ? ` (${formatSpan(body.uptimeMs)} ago)` : ''}`,
      'run a tool in Claude Code and re-check; if nothing arrives, see the hooks line above'))
  }
  if (body.uiAvailable === false) {
    out.push(result(WARN, `server: UI not built — http://127.0.0.1:${port}/ is a 404; ${COMMANDS.start} serves it there, or ${COMMANDS.dev} for Vite on :3333`))
  }
  return { results: out, up: true, body }
}

export function checkToken({ officeHome, serverUp, platform = process.platform }) {
  const file = join(officeHome, 'auth-token')
  if (!existsSync(file)) {
    return serverUp
      ? result(FAIL, `token: ${file} is missing although the server is up — hooks cannot authenticate`, 'is the server running with another AGENT_OFFICE_HOME? set the same one for the hook, or restart it from here')
      : result(WARN, `token: ${file} not written yet — the server writes it when it starts`)
  }
  // Windows has no POSIX modes: the file is private through the ACL of the user profile it sits in
  if (platform === 'win32') return result(PASS, `token: ${file} (Windows: no file mode to check, the user-profile ACL keeps it private)`)
  let mode
  try {
    mode = statSync(file).mode & 0o777
  } catch (err) {
    return result(FAIL, `token: ${file} cannot be read (${err instanceof Error ? err.message : err})`)
  }
  if (mode & 0o077) {
    return result(FAIL, `token: ${file} is mode 0${mode.toString(8)} — anyone on this machine can post as an agent`, `chmod 600 "${file}" (the server also rewrites it 0600 when it starts)`)
  }
  return result(PASS, `token: ${file} (0600)`)
}

export function checkDist({ root, port = DEFAULT_PORT }) {
  const index = join(root, 'dist', 'index.html')
  if (existsSync(index)) return result(PASS, `dist/: built — the server serves it at http://127.0.0.1:${port}/`)
  return result(WARN, 'dist/: not built — npm run build for the one-port page, or npm run dev for the Vite dev server on :3333')
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * Run every check. Options override the environment (tests): home, configDir,
 * officeHome, port, root, platform, loginPath, path, fetchImpl, nodeVersion.
 */
export async function runDoctor(opts = {}) {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  // Windows: the profile directory, as the hook and the server resolve it (HOME may be an MSYS path there)
  const home = opts.home ?? (platform === 'win32' ? env.USERPROFILE : env.HOME) ?? homedir()
  const defaultConfigDir = join(home, '.claude')
  const configDir = opts.configDir ?? (env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : defaultConfigDir)
  const officeHome = opts.officeHome ?? env.AGENT_OFFICE_HOME ?? join(home, '.agent-office')
  const port = Number(opts.port ?? env.AGENT_OFFICE_PORT) || DEFAULT_PORT
  const root = opts.root ?? ROOT
  const tracker = join(root, 'hooks', TRACKER_NAME)
  const statusScript = join(root, 'hooks', STATUS_NAME)
  const settingsPath = join(configDir, 'settings.json')
  const events = expectedEvents(root)

  const settingsState = readJson(settingsPath)
  const settings = settingsState.value ?? {}

  // CLAUDE_CONFIG_DIR set: an installer from before it honoured the variable wrote ~/.claude/settings.json, so look there too
  let fallback = null
  if (!samePath(configDir, defaultConfigDir)) {
    const alt = readJson(join(defaultConfigDir, 'settings.json')).value
    if (alt) fallback = { path: join(defaultConfigDir, 'settings.json'), ...inspectHooks(alt, { events, tracker, home }) }
  }

  const results = []
  results.push(checkNode(opts.nodeVersion))
  const hooks = checkHooks({ settingsPath, settings, settingsState, events, tracker, home, configDir, fallback, platform, loginPath: opts.loginPath, path: opts.path })
  results.push(...hooks.results)
  results.push(checkStatusLine({ settings, statusScript, home, pluginOnly: hooks.plugin.found && !hooks.hooks.any }))
  const server = await checkServer({ port, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs })
  results.push(...server.results)
  results.push(checkToken({ officeHome, serverUp: server.up, platform }))
  results.push(checkDist({ root, port }))

  return {
    results,
    ok: !results.some(r => r.level === FAIL),
    context: { home, configDir, settingsPath, officeHome, port, root, tracker, events },
  }
}

const ANSI = { [PASS]: '\x1b[32m', [WARN]: '\x1b[33m', [FAIL]: '\x1b[31m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }

/** The report as lines; colour only when asked. */
export function formatReport({ results, ok, context }, { color = false } = {}) {
  const c = (code, text) => (color ? `${ANSI[code]}${text}${ANSI.reset}` : text)
  const lines = [c('bold', 'Agent Office doctor'), c('dim', `  ${context.root}  ·  settings ${context.settingsPath}  ·  port ${context.port}`), '']
  for (const r of results) {
    lines.push(`  ${c(r.level, r.level)}  ${r.title}`)
    for (const note of r.notes) lines.push(`        ${c('dim', note)}`)
  }
  const counts = { [PASS]: 0, [WARN]: 0, [FAIL]: 0 }
  for (const r of results) counts[r.level]++
  lines.push('')
  lines.push(`  ${counts[PASS]} passed, ${counts[WARN]} warning(s), ${counts[FAIL]} failed${ok ? '' : c(FAIL, ' — fix the FAIL lines above')}`)
  lines.push('')
  lines.push(c('bold', 'Commands') + c('dim', `  (from ${context.root})`))
  const rows = [
    ['install / repair hooks + status line', COMMANDS.install],
    ['hooks only', COMMANDS.hooksOnly],
    ['status line only (next to the plugin)', COMMANDS.statusLine],
    ['uninstall what the installer added', COMMANDS.uninstall],
    ['plugin instead of the installer', COMMANDS.plugin],
    ['uninstall the plugin', COMMANDS.unplugin],
    ['start the office', `${COMMANDS.start}    # or: ${COMMANDS.startAlt}`],
  ]
  const width = Math.max(...rows.map(([k]) => k.length))
  for (const [k, v] of rows) lines.push(`  ${k.padEnd(width)}  ${v}`)
  lines.push(c('dim', '  honours AGENT_OFFICE_PORT, AGENT_OFFICE_HOME, CLAUDE_CONFIG_DIR; --json for machine-readable output'))
  return lines
}

function isMainModule() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  const args = new Set(process.argv.slice(2))
  if (args.has('-h') || args.has('--help')) {
    console.log('Usage: npm run doctor [-- --json] [--no-color]\n  Checks node, hooks (or the plugin), the status line, the server, the auth token and the build; exit 1 on any FAIL.')
    process.exit(0)
  }
  const report = await runDoctor()
  if (args.has('--json')) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    const color = !!process.stdout.isTTY && !process.env.NO_COLOR && !args.has('--no-color')
    console.log(formatReport(report, { color }).join('\n'))
  }
  process.exit(report.ok ? 0 : 1)
}
