#!/usr/bin/env node
// =============================================================================
// install-hooks.mjs — Add Agent Office hook to ~/.claude/settings.json
//                     ($CLAUDE_CONFIG_DIR/settings.json when that is set, the
//                     file Claude Code itself reads then)
//
// This script:
//   1. Refuses a settings file that is not valid JSON (line and column of the
//      error, nothing changed), then backs it up under a name no earlier
//      backup has
//   2. Registers agent-tracker.mjs for PreToolUse (spawns + tool activity),
//      PostToolUse (completions), PostToolUseFailure (failed tool calls),
//      SubagentStart (subagent ids), SubagentStop (subagents finishing),
//      SessionStart and SessionEnd (one session pill per Claude Code terminal),
//      and the main-thread events that show what the session's own Claude is
//      doing: UserPromptSubmit (the prompt), Stop (the reply), PermissionRequest
//      and Notification (waiting on you), StopFailure (API errors), PreCompact
//      and PostCompact (compaction), PostToolBatch (a permission answered),
//      CwdChanged (project tag follows a cd), PostModelSwitch (model)
//      (--status-line-only skips this step)
//   3. Registers status-line.mjs as the statusLine (+ subagentStatusLine)
//      command — the payroll / electricity / memory meters — chaining any
//      status line you already had (--no-status-line skips this step)
//   4. Prints next steps
//
// The commands it writes are `node "<checkout>/hooks/agent-tracker.mjs"` and
// `node "<checkout>/hooks/status-line.mjs"`, the path in forward slashes (Git
// Bash and PowerShell both take it). When `node` is not on the PATH a
// non-login shell has (a macOS nvm install, a GUI-launched Claude Code), the
// absolute path of the node running this script is written instead.
//
// Safe to re-run: each hook event is checked separately, so an older install
// gets any missing entries added, and an entry that still points at a checkout
// you have since moved, re-cloned or deleted is repointed at this one. That
// includes the `bash ".../hooks/agent-tracker.sh"` entries of the bash
// installer: they become the node form. Hooks that are not ours are never
// touched. An entry is ours when one of its shell words is a path ending in
// hooks/agent-tracker.sh or hooks/agent-tracker.mjs (hooks/status-line.sh or
// .mjs for the status line), whatever interpreter runs it — the layout of
// every checkout and of the plugin; a command that merely contains the name
// (my-status-line.sh, ~/.claude/status-line.sh) is someone else's.
//
// The agent-office plugin registers the same hooks from its own copy, so a
// plugin user wants the status line alone: --status-line-only (npm run
// install-status-line). A plain install with the plugin enabled warns that
// every event would then arrive twice.
//
// --uninstall takes it all back out: every hook entry whose command runs
// agent-tracker (either form) goes (whatever checkout it points at), a
// statusLine / subagentStatusLine that runs status-line is put back to the
// command it chained (saved in $AGENT_OFFICE_HOME/statusline-prev and
// subagent-statusline-prev) or removed, and the saved files are deleted.
//
// Usage:
//   node hooks/install-hooks.mjs [--no-status-line | --status-line-only]
//   node hooks/install-hooks.mjs --uninstall [--no-status-line | --status-line-only]
// =============================================================================

import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Every event agent-tracker handles (matcher "" = every occurrence); hooks/hooks.json
// is the plugin's copy of this list — keep the two in step (tests/plugin.test.ts checks).
// The tracker ignores anything it does not know, so an older tracker with a newer
// settings file is harmless, and vice versa.
export const EVENTS = [
  // workers: spawns, tool calls, completions
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop',
  // one session pill per terminal
  'SessionStart', 'SessionEnd',
  // the session's own Claude: prompt, reply, waiting on you, API errors, compaction,
  // a permission answered (batch done), cd, model switch
  'UserPromptSubmit', 'Stop', 'PermissionRequest', 'Notification', 'StopFailure', 'PreCompact', 'PostCompact',
  'PostToolBatch', 'CwdChanged', 'PostModelSwitch',
  // the task board: the session's task list changed (the office reads the list itself)
  'TaskCreated', 'TaskCompleted',
]

// The PATH a non-login shell is sure to have; a node outside it needs its absolute path in the command
export const LOGIN_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin'

const NOTHING_TO_REMOVE = 3
const REFUSED = 4 // nothing written, the reason printed

const USAGE = `Usage: node hooks/install-hooks.mjs [--no-status-line | --status-line-only]
       node hooks/install-hooks.mjs --uninstall [--no-status-line | --status-line-only]`

// Colours
const RED = '\x1b[0;31m'
const GREEN = '\x1b[0;32m'
const YELLOW = '\x1b[1;33m'
const CYAN = '\x1b[0;36m'
const RESET = '\x1b[0m'

// ---------------------------------------------------------------------------
// Helpers (doctor.mjs shares the command-recognition ones)
// ---------------------------------------------------------------------------

const out = (text = '') => process.stdout.write(`${text}\n`)
const err = (text = '') => process.stderr.write(`${text}\n`)

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** The JSON type names the messages have always used (they come from Python's type()). */
function kind(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return 'list'
  if (typeof value === 'string') return 'str'
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float'
  if (typeof value === 'boolean') return 'bool'
  return 'dict'
}

const forwardSlashes = (p) => p.replace(/\\/g, '/')

/** Split a shell command into words, honouring quotes and backslashes (enough for a hook command). */
export function shellWords(command) {
  const words = []
  let cur = ''
  let quote = null
  let has = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) quote = null
      // In double quotes a backslash only escapes \ " $ ` — "C:\a\hooks" keeps its backslashes
      else if (ch === '\\' && quote === '"' && i + 1 < command.length && '\\"$`'.includes(command[i + 1])) cur += command[++i]
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (ch === '\\' && i + 1 < command.length) {
      cur += command[++i]
      has = true
    } else if (/\s/.test(ch)) {
      if (has || cur) words.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (has || cur) words.push(cur)
  return words
}

/**
 * The path a hook command runs that ends in hooks/<stem>.sh or hooks/<stem>.mjs
 * (`name` is either form; the layout of every checkout and of the plugin), or
 * null when the command is not ours: containing the name is not enough —
 * my-status-line.sh or ~/.claude/status-line.sh is someone else's. The
 * interpreter does not matter (bash, node, an absolute node path, none).
 */
export function scriptPathIn(command, name) {
  const stem = name.replace(/\.(sh|mjs)$/, '')
  if (typeof command !== 'string' || !command.includes(stem)) return null
  // The plain whitespace split catches an unquoted Windows path, whose backslashes a shell would have eaten
  const words = [...shellWords(command), ...command.split(/\s+/).map(w => w.replace(/^["']|["']$/g, ''))]
  return words.find((w) => {
    const p = forwardSlashes(w)
    return (posix.basename(p) === `${stem}.sh` || posix.basename(p) === `${stem}.mjs`) && posix.basename(posix.dirname(p)) === 'hooks'
  }) ?? null
}

/** First executable `name` on PATH, or null. */
export function which(name, path = process.env.PATH ?? '') {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    // Windows PATH entries may be quoted ("C:\Program Files\nodejs")
    const candidate = join(dir.replace(/^"|"$/g, ''), name)
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return null
}

/**
 * The command that starts node in a hook: `node` when a non-login shell finds
 * it (LOGIN_PATH), else the absolute path of the running node, quoted, forward
 * slashes. Always `node` on Windows: PowerShell runs a quoted path only after
 * `&`, which Git Bash reads as "background", so no quoted form works in both.
 */
export function nodeCommand({ platform = process.platform, execPath = process.execPath, loginPath = LOGIN_PATH } = {}) {
  if (platform === 'win32' || which('node', loginPath) !== null) return 'node'
  return `"${forwardSlashes(execPath)}"`
}

/** ~ (also ~/ and ~\) as a shell would expand it in a hook command */
function expandUser(p) {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

function realpath(p) {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}

const sameFile = (a, b) => realpath(expandUser(a)) === realpath(b)

/** `line L, column C: message` for the error JSON.parse threw on `text` */
function describeJsonError(text, error) {
  const message = error instanceof Error ? error.message : String(error)
  const at = /at position (\d+)/.exec(message)
  const position = at ? Number(at[1]) : text.length
  const before = text.slice(0, position)
  const line = before.split('\n').length
  const column = position - (before.lastIndexOf('\n') + 1) + 1
  return `line ${line}, column ${column}: ${message.replace(/ in JSON at position.*$| at position.*$/, '')}`
}

/** { settings } or { why }; a file holding only whitespace counts as {} (there is nothing in it to lose) */
function parseSettings(text) {
  if (!text.trim()) return { settings: {} }
  try {
    return { settings: JSON.parse(text) }
  } catch (error) {
    return { why: describeJsonError(text, error) }
  }
}

const pad = (n) => String(n).padStart(2, '0')

function timestamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * A backup name no other file has: settings.json.backup.<time>, then .1, .2, …
 * for further runs in the same second (a dotfiles bootstrap, `install &&
 * install --no-status-line`), so the copy of the original is never overwritten
 */
function backupName(settingsFile) {
  const base = `${settingsFile}.backup.${timestamp()}`
  let name = base
  for (let n = 1; existsSync(name); n++) name = `${base}.${n}`
  return name
}

/** Copy `from` to `to`, failing (EEXIST) rather than overwriting a file that appeared under that name meanwhile */
const copyNoClobber = (from, to) => copyFileSync(from, to, constants.COPYFILE_EXCL)

/** Rewrites the file in place (not via rename): a settings.json that is a symlink into a dotfiles repo stays one */
const writeSettings = (path, settings) => writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)

// ---------------------------------------------------------------------------
// --uninstall: take the office back out of settings.json
//
// Every hook entry whose command runs agent-tracker is removed, whatever
// checkout it points at (a stale path from a moved clone included), and a
// group, an event list or "hooks" itself that this leaves empty goes with it.
// A statusLine / subagentStatusLine that runs status-line is put back to
// the command it chained when the installer saved one (padding and
// refreshInterval stay), otherwise the key is removed; the saved files are
// deleted. Anything that is not ours — other hooks, other settings, a status
// line we never wrapped — is left as it is, and so are the shapes the install
// path repairs (nothing of ours can hide in a "hooks" that is not an object).
// A file that is not valid JSON is refused. The file is backed up first, and
// only written when there is something to remove.
// Returns 0, NOTHING_TO_REMOVE or REFUSED.
// ---------------------------------------------------------------------------
function removeFromSettings({ settingsPath, backupPath, officeHome, statusLine, hooksToo }) {
  const parsed = parseSettings(readFileSync(settingsPath, 'utf8'))
  if (parsed.why) {
    // the check before this refused it already; the file changed under us
    err(`  [error] the settings file is not valid JSON (${parsed.why})`)
    return REFUSED
  }
  const settings = parsed.settings
  if (!isObject(settings)) {
    out(`  [skip] the settings file holds a JSON ${kind(settings)}, not an object; left as it is`)
    return NOTHING_TO_REMOVE
  }

  let changed = false

  // -- hooks: every entry that runs agent-tracker, under any event ------------
  let removed = 0
  const hooks = settings.hooks
  if (!hooksToo) {
    out('  [skip] hooks (--status-line-only)')
  } else if (isObject(hooks)) {
    for (const event of Object.keys(hooks)) {
      const groups = hooks[event]
      // A single group written where Claude Code expects a list of them is searched as it is
      const candidates = Array.isArray(groups) ? groups : isObject(groups) ? [groups] : []
      let emptied = false
      for (const group of [...candidates]) {
        if (!isObject(group) || !Array.isArray(group.hooks)) continue
        const ours = group.hooks.filter(h => isObject(h) && scriptPathIn(h.command, 'agent-tracker') !== null)
        for (const h of ours) {
          out(`  [remove] ${event} (${scriptPathIn(h.command, 'agent-tracker')})`)
          group.hooks.splice(group.hooks.indexOf(h), 1)
          removed++
        }
        // Only a group we emptied goes; one that was empty before is not ours to drop
        if (ours.length && !group.hooks.length) {
          if (Array.isArray(groups)) groups.splice(groups.indexOf(group), 1)
          emptied = true
        }
      }
      if (emptied && (isObject(groups) || !groups.length)) delete hooks[event]
    }
    if (removed) {
      changed = true
      if (!Object.keys(hooks).length) delete settings.hooks
    }
    out(removed ? `  hooks: ${removed} office ${removed === 1 ? 'entry' : 'entries'} removed` : '  hooks: no office entries found')
  } else if ('hooks' in settings) {
    out(`  [skip] "hooks" is a JSON ${kind(hooks)}, not an object; nothing of ours can be in it, left as it is`)
  }

  // -- status line: put the chained command back, or remove the key ----------
  if (statusLine) {
    for (const [key, prevName] of [['statusLine', 'statusline-prev'], ['subagentStatusLine', 'subagent-statusline-prev']]) {
      const prevFile = join(officeHome, prevName)
      const current = settings[key]
      const oldPath = isObject(current) ? scriptPathIn(current.command, 'status-line') : null
      if (oldPath === null) {
        if (key in settings) out(`  [skip] ${key} is not the office's; left as it is`)
        if (existsSync(prevFile) && statSync(prevFile).isFile()) out(`  [note] ${prevFile} kept: only the office status line reads it, and that is not registered`)
        continue
      }
      const previous = existsSync(prevFile) && statSync(prevFile).isFile() ? readFileSync(prevFile, 'utf8').trim() : ''
      if (previous) {
        // The command the installer chained goes back in place; padding / refreshInterval stay as they are
        current.command = previous
        out(`  [restore] ${key}: ${previous}`)
      } else {
        delete settings[key]
        out(`  [remove] ${key} (was ${oldPath})`)
      }
      if (existsSync(prevFile)) {
        rmSync(prevFile)
        out(`  [delete] ${prevFile}`)
      }
      changed = true
    }
  } else {
    out('  [skip] statusLine + subagentStatusLine (--no-status-line)')
  }

  if (!changed) {
    out(`  nothing to remove: no office hooks or status line in ${settingsPath}`)
    return NOTHING_TO_REMOVE
  }

  try {
    // EXCL: a backup that appeared under this name since it was picked is never overwritten
    copyNoClobber(settingsPath, backupPath)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    err(`  [error] ${backupPath} already exists; run this again`)
    return REFUSED
  }
  out(`  [ok] backup saved: ${backupPath}`)
  writeSettings(settingsPath, settings)
  return 0
}

// ---------------------------------------------------------------------------
// Merge hook entries into the settings
//
// An entry is ours when one of its command's words is a path ending in
// hooks/agent-tracker.(sh|mjs). One that points at this checkout's .mjs is
// left alone; one that points anywhere else (a moved or deleted checkout, a
// pruned worktree, a second clone, the bash installer's .sh) is repointed in
// place, otherwise Claude Code reports a hook error on every tool call and the
// office never hears about it. Shapes Claude Code itself would reject ("hooks"
// not an object, an event given as one group instead of a list, entries that
// are not objects) are repaired or ignored instead of crashing the install.
// ---------------------------------------------------------------------------
function mergeHooks(settingsPath, hookCommand, trackerScript) {
  const parsed = parseSettings(readFileSync(settingsPath, 'utf8'))
  if (parsed.why) {
    // the check before this refused it already; the file changed under us
    err(`  [error] ${settingsPath} is not valid JSON (${parsed.why}); not written`)
    throw new Error('settings changed under us')
  }
  let settings = parsed.settings

  const warn = (message) => out(`  [warn] ${message} (the backup keeps the old value)`)

  if (!isObject(settings)) {
    warn(`settings file holds a JSON ${kind(settings)}, not an object; starting from {}`)
    settings = {}
  }

  // The agent-office plugin registers these same hooks from its own copy
  const plugins = settings.enabledPlugins
  const plugin = isObject(plugins) ? Object.keys(plugins).find(k => plugins[k] && (k === 'agent-office' || k.startsWith('agent-office@'))) : undefined

  let hooks = settings.hooks
  if (!isObject(hooks)) {
    if ('hooks' in settings) warn(`"hooks" is a JSON ${kind(hooks)}, not an object; replaced with {}`)
    hooks = settings.hooks = {}
  }

  let added = 0
  let updated = 0
  let unchanged = 0
  for (const event of EVENTS) {
    let groups = hooks[event]
    if (isObject(groups)) {
      // One group written where Claude Code expects a list of them
      out(`  [warn] "hooks.${event}" is a single object, wrapped in a list`)
      groups = [groups]
    } else if (!Array.isArray(groups)) {
      if (event in hooks) warn(`"hooks.${event}" is a JSON ${kind(groups)}, not a list; replaced with []`)
      groups = []
    }
    hooks[event] = groups

    // (group, hook) pairs that run agent-tracker; anything not shaped like a hook is left as is
    const ours = []
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue
      for (const h of group.hooks) {
        if (isObject(h) && scriptPathIn(h.command, 'agent-tracker') !== null) ours.push([group, h])
      }
    }
    if (!ours.length) {
      groups.push({ matcher: '', hooks: [{ type: 'command', command: hookCommand }] })
      out(`  [add]  ${event}`)
      added++
      continue
    }

    const [, first] = ours[0]
    const oldPath = scriptPathIn(first.command, 'agent-tracker')
    if (sameFile(oldPath, trackerScript)) {
      out(`  [skip] ${event} already registered`)
      unchanged++
    } else {
      first.command = hookCommand
      out(`  [update] ${event} (was ${oldPath})`)
      updated++
    }

    // A second office entry would report every tool call twice
    for (const [group, h] of ours.slice(1)) {
      out(`  [drop] ${event} duplicate office entry (was ${scriptPathIn(h.command, 'agent-tracker')})`)
      group.hooks.splice(group.hooks.indexOf(h), 1)
      if (!group.hooks.length) groups.splice(groups.indexOf(group), 1)
    }
  }

  out(`  hooks: ${added} added, ${updated} repointed at this checkout, ${unchanged} unchanged`)
  if (plugin) {
    out(`  [warn] the ${plugin} plugin is enabled too: its hooks and these both run, so every event reaches the office twice.`)
    out('         Keep one: npm run uninstall-hooks -- --no-status-line takes these back out (the status line stays),')
    out(`         or claude plugin uninstall ${plugin}. Next to the plugin, npm run install-status-line adds the meters alone.`)
  }

  writeSettings(settingsPath, settings)
}

// ---------------------------------------------------------------------------
// Status line — the payroll / electricity / memory meters (statusLine +
// subagentStatusLine, both served by status-line.mjs). A status line you
// already had is chained: its command is saved next to the auth token and
// status-line.mjs prints its output, so nothing you see changes. An entry that
// is already ours but points at another checkout (or at the bash installer's
// status-line.sh) is repointed in place, so the command you chained (and its
// padding / refreshInterval) stay as they are.
// ---------------------------------------------------------------------------
function mergeStatusLine(settingsPath, command, officeHome, statusScript) {
  const parsed = parseSettings(readFileSync(settingsPath, 'utf8'))
  if (parsed.why) {
    // the check before this refused it already; the file changed under us
    err(`  [error] ${settingsPath} is not valid JSON (${parsed.why}); not written`)
    throw new Error('settings changed under us')
  }
  let settings = parsed.settings
  if (!isObject(settings)) {
    // The hook step warns about this too; with --status-line-only it is the first to see it
    out(`  [warn] settings file holds a JSON ${kind(settings)}, not an object; starting from {} (the backup keeps the old value)`)
    settings = {}
  }

  const counts = { added: 0, 'repointed at this checkout': 0, wrapped: 0, unchanged: 0 }

  const register = (key, cmd, prevFile, padding) => {
    const current = settings[key]
    const oldPath = isObject(current) ? scriptPathIn(current.command, 'status-line') : null
    if (oldPath !== null) {
      // Ours already: repoint it when the checkout has moved, keep the rest of the entry as is
      if (sameFile(oldPath, statusScript)) {
        out(`  [skip] ${key} already registered`)
        counts.unchanged++
        return
      }
      current.command = cmd
      out(`  [update] ${key} (was ${oldPath})`)
      counts['repointed at this checkout']++
      return
    }
    const entry = { type: 'command', command: cmd }
    if (isObject(current) && current.command) {
      if ((current.type ?? 'command') !== 'command') {
        out(`  [skip] ${key}: existing entry of type '${current.type}' left alone`)
        counts.unchanged++
        return
      }
      const previous = String(current.command)
      writeFileSync(prevFile, `${previous}\n`, { mode: 0o600 })
      if (process.platform !== 'win32') chmodSync(prevFile, 0o600) // mode: only applies to a new file
      for (const opt of ['padding', 'refreshInterval']) {
        if (opt in current) entry[opt] = current[opt]
      }
      settings[key] = entry
      out(`  [wrap] ${key}: your existing command is kept and chained, its output is what you will see:`)
      out(`         ${previous}`)
      out(`         (saved in ${prevFile})`)
      counts.wrapped++
      return
    }
    if (padding !== null) entry.padding = padding
    settings[key] = entry
    out(`  [add]  ${key}`)
    counts.added++
  }

  register('statusLine', command, join(officeHome, 'statusline-prev'), 0)
  register('subagentStatusLine', `${command} --subagents`, join(officeHome, 'subagent-statusline-prev'), null)

  out(`  status line: ${Object.entries(counts).map(([what, n]) => `${n} ${what}`).join(', ')}`)

  writeSettings(settingsPath, settings)
}

// ---------------------------------------------------------------------------
// main: returns the process exit code
// ---------------------------------------------------------------------------
export function main(argv, env = process.env) {
  // --no-status-line:   register the hooks only (no payroll / electricity /
  //                     memory meters); with --uninstall, leave the status line
  //                     alone
  // --status-line-only: register the status line only (no hooks), for the
  //                     plugin install; with --uninstall, leave the hooks alone
  // --uninstall:        remove what this script registered (see above)
  let hooksOn = true
  let statusLineOn = true
  let uninstall = false
  for (const arg of argv) {
    switch (arg) {
      case '--no-status-line': case '--no-statusline': statusLineOn = false; break
      case '--status-line-only': case '--statusline-only': hooksOn = false; break
      case '--uninstall': uninstall = true; break
      case '-h': case '--help':
        out(USAGE)
        return 0
      default:
        err(`Unknown option: ${arg} (try --no-status-line, --status-line-only or --uninstall)`)
        return 1
    }
  }
  if (!hooksOn && !statusLineOn) {
    err('--no-status-line and --status-line-only together leave nothing to do')
    err(USAGE)
    return 1
  }

  // Claude Code reads $CLAUDE_CONFIG_DIR/settings.json when that is set (the
  // server and npm run doctor follow it too), ~/.claude/settings.json otherwise
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const settingsFile = join(claudeDir, 'settings.json')
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const trackerScript = forwardSlashes(join(scriptDir, 'agent-tracker.mjs'))
  const statusScript = forwardSlashes(join(scriptDir, 'status-line.mjs'))
  const node = nodeCommand()
  const hookCommand = `${node} "${trackerScript}"`
  const officeHome = env.AGENT_OFFICE_HOME || join(homedir(), '.agent-office')

  out('')
  out(`${CYAN}╔═══════════════════════════════════════════╗${RESET}`)
  out(uninstall
    ? `${CYAN}║    Agent Office — Hook Uninstaller        ║${RESET}`
    : `${CYAN}║    Agent Office — Hook Installer          ║${RESET}`)
  out(`${CYAN}╚═══════════════════════════════════════════╝${RESET}`)
  out('')

  // A settings file that is not valid JSON is refused, never replaced: one stray
  // comma in a hand-edited file would otherwise cost every permission rule, env
  // var, model choice and plugin in it. The parse error is printed with its line
  // and column and nothing is written — no backup either, since this runs first.
  // A file holding only whitespace counts as {} (there is nothing in it to
  // lose). Every step below that parses the file refuses the same way.
  const refuseInvalidJson = () => {
    if (!existsSync(settingsFile) || !statSync(settingsFile).isFile()) return false
    let why
    try {
      why = parseSettings(readFileSync(settingsFile, 'utf8')).why
    } catch (error) {
      why = error instanceof Error ? error.message : String(error)
    }
    if (!why) return false
    err(`${RED}[error]${RESET} ${settingsFile} is not valid JSON (${why})`)
    err('        Nothing was changed. Fix it (Claude Code cannot read it either) and run this again.')
    return true
  }

  if (uninstall) {
    if (!existsSync(settingsFile) || !statSync(settingsFile).isFile()) {
      out(`${YELLOW}[info]${RESET} ${settingsFile} does not exist — nothing to remove`)
      return 0
    }
    if (refuseInvalidJson()) return 1
    const backupFile = backupName(settingsFile)
    out(hooksOn
      ? `${CYAN}[...]${RESET} Removing the office hooks and status line from ${settingsFile}...`
      : `${CYAN}[...]${RESET} Removing the office status line from ${settingsFile}...`)

    let rc
    try {
      rc = removeFromSettings({ settingsPath: settingsFile, backupPath: backupFile, officeHome, statusLine: statusLineOn, hooksToo: hooksOn })
    } catch (error) {
      err(`  [error] ${error instanceof Error ? error.message : error}`)
      rc = 1
    }

    switch (rc) {
      case 0:
        out(`${GREEN}[ok]${RESET} Office entries removed from ${settingsFile}`)
        out('')
        out(`${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`)
        out(`${GREEN}Uninstall complete.${RESET}`)
        out('')
        out('  Claude Code sessions already open keep the old hooks until they restart.')
        out('  Your pre-uninstall settings are in:')
        out(`    ${backupFile}`)
        out('  To put the office back: node hooks/install-hooks.mjs')
        out('')
        return 0
      case NOTHING_TO_REMOVE:
        out(`${GREEN}[ok]${RESET} Nothing to remove — ${settingsFile} has no office hooks or status line and was not changed`)
        out('')
        return 0
      case REFUSED:
        // The step refused (and said why) before writing anything
        err(`${RED}[error]${RESET} ${settingsFile} was not changed`)
        return 1
      default:
        err(`${RED}[error]${RESET} Could not update ${settingsFile}`)
        if (existsSync(backupFile)) err(`        Your previous settings are in ${backupFile}`)
        return 1
    }
  }

  // -------------------------------------------------------------------------
  // Validate the script exists
  // -------------------------------------------------------------------------
  if (hooksOn) {
    if (!existsSync(trackerScript)) {
      out(`${RED}[error]${RESET} Tracker script not found: ${trackerScript}`)
      out('        Make sure you run this from the agent-office project directory.')
      return 1
    }
    out(`${GREEN}[ok]${RESET} Tracker script: ${trackerScript}`)
  } else if (!existsSync(statusScript)) {
    out(`${RED}[error]${RESET} Status line script not found: ${statusScript}`)
    out('        Make sure you run this from the agent-office project directory.')
    return 1
  }

  // A settings file that is not valid JSON stops here, before the backup
  if (refuseInvalidJson()) return 1

  // Ensure the config directory (~/.claude or $CLAUDE_CONFIG_DIR) exists
  mkdirSync(dirname(settingsFile), { recursive: true })

  // Create settings file if it does not exist
  if (!existsSync(settingsFile)) {
    out(`${YELLOW}[info]${RESET} Creating ${settingsFile}`)
    writeFileSync(settingsFile, '{}\n')
  }

  // Backup existing settings, under a name no earlier backup has (a file that
  // appears under it meanwhile is not overwritten either)
  const backupFile = backupName(settingsFile)
  try {
    copyNoClobber(settingsFile, backupFile)
  } catch {
    err(`${RED}[error]${RESET} Could not write the backup ${backupFile} — nothing was changed`)
    return 1
  }
  out(`${GREEN}[ok]${RESET} Backup saved: ${backupFile}`)

  // A merge step that fails leaves the backup as the way back
  const mergeFailed = (error) => {
    if (error instanceof Error && error.message !== 'settings changed under us') err(`  [error] ${error.message}`)
    err(`${RED}[error]${RESET} Could not update ${settingsFile} — your previous settings are in ${backupFile}`)
    return 1
  }

  if (hooksOn) {
    out(`${CYAN}[...]${RESET} Registering the ${EVENTS.length} hook events (tool calls, subagents, sessions, the main thread's turn, the task list)...`)
    try {
      mergeHooks(settingsFile, hookCommand, trackerScript)
    } catch (error) {
      return mergeFailed(error)
    }
    out(`${GREEN}[ok]${RESET} Hooks up to date in ${settingsFile}`)
  } else {
    out(`${YELLOW}[skip]${RESET} hooks (--status-line-only: the agent-office plugin, or your own entries, provide them)`)
  }

  if (statusLineOn && existsSync(statusScript)) {
    mkdirSync(officeHome, { recursive: true })
    out(`${CYAN}[...]${RESET} Registering the status line (payroll / electricity / memory meters)...`)
    try {
      mergeStatusLine(settingsFile, `${node} "${statusScript}"`, officeHome, statusScript)
    } catch (error) {
      return mergeFailed(error)
    }
    out(`${GREEN}[ok]${RESET} Status line up to date in ${settingsFile}`)
  } else if (statusLineOn) {
    out(`${YELLOW}[warn]${RESET} status-line.mjs not found next to the tracker — meters skipped`)
  } else {
    out(`${YELLOW}[skip]${RESET} statusLine + subagentStatusLine (--no-status-line)`)
  }

  // -------------------------------------------------------------------------
  // Print next steps
  // -------------------------------------------------------------------------
  out('')
  out(`${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`)
  out(`${GREEN}Installation complete!${RESET}`)
  out('')
  out('Next steps:')
  out('')
  out('  1. Start the Agent Office server:')
  out(`       cd ${dirname(scriptDir)}`)
  out('       npm run server')
  out('')
  out('  2. Start the Agent Office UI:')
  out('       npm run dev           # browser')
  out('       npm run dev:electron  # desktop app')
  out('')
  if (hooksOn) {
    out('  3. Use Claude Code normally. When you (or Claude) use the Agent')
    out('     tool or any MCP tool, a character will appear in the office.')
  } else {
    out("  3. Use Claude Code normally: the agent-office plugin's hooks bring the")
    out('     agents in; this install added the status line only.')
  }
  if (statusLineOn) {
    out('')
    out('  4. The wall panel above the chat shows payroll / electricity / memory')
    out('     as soon as Claude Code sends its first status line.')
  }
  out('')
  out(hooksOn ? '  Hook installed at:' : '  Status line installed at:')
  out(`    ${settingsFile}`)
  out('')
  if (hooksOn) {
    out('  Tracker script:')
    out(`    ${trackerScript}`)
  } else {
    out('  Status line script:')
    out(`    ${statusScript}`)
  }
  out('')
  out(`${YELLOW}Note:${RESET} The server must be running on port ${env.AGENT_OFFICE_PORT || 3334} for events to appear`)
  out('  (the hook, the status line and the server all read AGENT_OFFICE_PORT; default 3334).')
  out('  If the server is not running, the hook exits silently — no errors.')
  out('')
  return 0
}

function isMainModule() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) process.exitCode = main(process.argv.slice(2))
