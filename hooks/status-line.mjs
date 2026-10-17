// =============================================================================
// status-line.mjs — Claude Code statusLine → Agent Office meters bridge
//
// Claude Code runs the configured `statusLine.command` on every state change
// of an interactive session (new assistant message, /compact, permission-mode
// change, ...) with a JSON object on stdin (Claude Code 2.1.300, see
// https://code.claude.com/docs/en/statusline):
//   session_id, transcript_path, cwd, version, model{id,display_name},
//   workspace{current_dir,project_dir}, cost{total_cost_usd,total_duration_ms,
//   total_api_duration_ms,total_lines_added,total_lines_removed},
//   context_window{total_input_tokens,total_output_tokens,context_window_size,
//   used_percentage,current_usage}, exceeds_200k_tokens, effort{level},
//   rate_limits{five_hour{used_percentage,resets_at},seven_day{...},spend_limit{...}}
//   (rate_limits only for Pro/Max subscribers, and only after the first API
//   response; used_percentage may be null early in the session)
//
// This script POSTs a compact summary to the office (POST /status — the
// payroll / electricity / memory wall panel) and prints the status line that
// Claude Code displays:
//   default   <model> · ctx <used>% · $<cost>
//   chained   the output of the statusLine command that was configured before
//             install-hooks wrapped it (saved in
//             $AGENT_OFFICE_HOME/statusline-prev); the default line is printed
//             when that command prints nothing
//
// `--subagents` makes it the `subagentStatusLine` command. Claude Code then
// sends {...base hook fields, columns, tasks:[{id, agentType, status,
// description, label, startTime, model, effort, contextWindowSize, tokenCount,
// tokenSamples, cwd}]} once per refresh tick while subagents are visible. The
// per-worker token counts are forwarded as an agent_status and nothing is
// printed, which keeps Claude Code's default rows (or the chained previous
// command's rows, saved in $AGENT_OFFICE_HOME/subagent-statusline-prev).
//
// Node builtins only. The line is printed first, then the POST is awaited
// (capped at 1 s by send(), so a stopped server costs at most that and never
// delays the line): exiting before the answer loses events.
//
// The chained previous command runs where Claude Code would have run it:
//   POSIX    bash -c
//   Windows  Git Bash (-c) when Claude Code would find it, else
//            powershell.exe -NoProfile -NonInteractive -Command
// =============================================================================

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { officeHome, officeUrl, readToken, send, signHeaders } from './office-client.mjs'

const WIN = process.platform === 'win32'

// ── Python-compatible helpers: keep the output identical to the old script ──

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Python truthiness: null, false, 0, '', [] and {} are falsy */
const truthy = v => !(v == null || v === false || v === 0 || v === '' ||
  (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length))

/** A finite number, or null (a boolean is not a number here) */
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)

const text = (v, limit = 120) =>
  (typeof v === 'string' || typeof v === 'number' ? [...String(v)].slice(0, limit).join('') : '')

/** Python round(): halves go to the even neighbour */
function pyRound(x) {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

/** Python '%.2f': an exact tie (an odd multiple of 1/8) rounds to even, toFixed rounds it up */
function fmt2(x) {
  const s = x * 100
  if (Number.isInteger(x * 8) && (x * 8) % 2 !== 0) {
    const lo = Math.floor(s)
    return ((lo % 2 === 0 ? lo : lo + 1) / 100).toFixed(2)
  }
  return x.toFixed(2)
}

/** What $(...) keeps of command output: the trailing newlines go */
const trimEol = s => s.replace(WIN ? /[\r\n]+$/ : /\n+$/, '')

// ── The summary: the event to POST (or null) and the default status line ────

function summarize(payload, subagents) {
  let d
  try { d = JSON.parse(payload) } catch { d = {} }
  if (!isObj(d)) d = {}
  const sessionId = text(d.session_id, 200)

  // subagentStatusLine: one agent_status for every visible subagent row
  if (subagents) {
    const agents = []
    const tasks = Array.isArray(d.tasks) ? d.tasks : []
    for (const t of tasks.slice(0, 32)) {
      if (!isObj(t) || !truthy(t.id)) continue
      const a = { id: text(t.id, 200), tokens: num(t.tokenCount) || 0, status: text(t.status, 40) }
      const size = num(t.contextWindowSize)
      if (size) a.contextSize = size
      for (const key of ['agentType', 'name', 'model', 'description']) {
        if (truthy(t[key])) a[key] = text(t[key])
      }
      agents.push(a)
    }
    // No row override: Claude Code keeps its default rendering
    return { event: sessionId && agents.length ? { type: 'agent_status', sessionId, agents } : null, line: '' }
  }

  // statusLine: the session's cost, context window and rate limits
  const obj = key => (isObj(d[key]) ? d[key] : {})
  const [model, cost, ctx, rl, ws, effort] =
    ['model', 'cost', 'context_window', 'rate_limits', 'workspace', 'effort'].map(obj)

  const projectDir = text(ws.project_dir, 400) || text(ws.current_dir, 400) || text(d.cwd, 400)
  const project = projectDir.replace(WIN ? /[\\/]+$/ : /\/+$/, '').split(WIN ? /[\\/]/ : '/').pop() || projectDir

  const modelName = text(model.display_name) || text(model.id) || 'Claude'
  const totalCost = num(cost.total_cost_usd) || 0
  const used = num(ctx.used_percentage)

  const event = {
    type: 'session_status',
    sessionId,
    project,
    model: modelName,
    modelId: text(model.id),
    cost: totalCost,
    durationMs: num(cost.total_duration_ms) || 0,
    apiDurationMs: num(cost.total_api_duration_ms) || 0,
    linesAdded: num(cost.total_lines_added) || 0,
    linesRemoved: num(cost.total_lines_removed) || 0,
    context: {
      used,
      size: num(ctx.context_window_size),
      input: num(ctx.total_input_tokens) || 0,
      output: num(ctx.total_output_tokens) || 0,
    },
    effort: text(effort.level, 20) || null,
    exceeds200k: truthy(d.exceeds_200k_tokens),
    version: text(d.version, 20) || null,
  }

  // Each window is independently absent; used_percentage runs 0-100 (spend_limit
  // can exceed 100 once over the limit), resets_at is Unix epoch seconds
  const limits = {}
  for (const [src, dst] of [['five_hour', 'fiveHour'], ['seven_day', 'sevenDay'], ['spend_limit', 'spendLimit']]) {
    const window = rl[src]
    if (!isObj(window)) continue
    const pct = num(window.used_percentage)
    if (pct !== null) limits[dst] = pct
    const resets = num(window.resets_at)
    if (resets !== null) limits[`${dst}ResetsAt`] = resets
  }
  if (Object.keys(limits).length) event.rateLimits = limits

  return {
    event: sessionId ? event : null,
    line: `${modelName} · ctx ${used !== null ? pyRound(used) : '0'}% · $${fmt2(totalCost)}`,
  }
}

// ── POST to the office ──────────────────────────────────────────────────────

/**
 * The event, signed with the office token (the token itself never travels;
 * without one the POST goes out unsigned and the server answers 401, which
 * is ignored). Never throws; resolves once the office answered or 1 s passed.
 */
async function post(event) {
  try {
    const url = officeUrl('/status', process.env.AGENT_OFFICE_STATUS_URL)
    const body = JSON.stringify(event)
    await send(url, { method: 'POST', body, headers: signHeaders(readToken(), 'POST', url, body), timeoutMs: 1000 })
  } catch { /* the status line must print regardless */ }
}

// ── Chaining the previous status line ───────────────────────────────────────

/**
 * Git Bash, found as Claude Code finds it: CLAUDE_CODE_GIT_BASH_PATH when that
 * file exists, else bash.exe of the Git install that holds the first git.exe
 * on PATH (<Git>\cmd\git.exe or <Git>\mingw64\bin\git.exe → <Git>\bin\bash.exe).
 * null when there is none: the caller falls back to PowerShell.
 */
function findGitBash(env = process.env) {
  const fixed = env.CLAUDE_CODE_GIT_BASH_PATH
  if (fixed && existsSync(fixed)) return fixed
  for (const raw of (env.PATH || '').split(delimiter)) {
    const dir = raw.replace(/^"|"$/g, '')
    if (!dir || !existsSync(join(dir, 'git.exe'))) continue
    for (const up of [['..'], ['..', '..']]) {
      const bash = join(dir, ...up, 'bin', 'bash.exe')
      if (existsSync(bash)) return bash
    }
  }
  return null
}

function chainCommand(cmd) {
  if (!WIN) return ['bash', ['-c', cmd]]
  const bash = findGitBash()
  return bash ? [bash, ['-c', cmd]] : ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd]]
}

/**
 * The previous command's stdout for the same stdin ('' when it fails or
 * prints nothing: stderr and the exit status are ignored). Like the bash
 * script it has no timeout of its own.
 */
function runChained(cmd, payload) {
  return new Promise(resolve => {
    let out = ''
    let child
    try {
      const [file, args] = chainCommand(cmd)
      child = spawn(file, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      return resolve('')
    }
    child.stdout.setEncoding('utf8').on('data', c => { out += c })
    child.stdin.on('error', () => {}) // EPIPE: it did not read its stdin
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(trimEol(out)))
    child.stdin.end(payload)
  })
}

/** The saved or overriding previous command ('' when there is none) */
function prevCommand(subagents) {
  const fromEnv = subagents ? '' : process.env.AGENT_OFFICE_PREV_STATUSLINE || ''
  if (fromEnv) return fromEnv
  try {
    return trimEol(readFileSync(join(officeHome(), subagents ? 'subagent-statusline-prev' : 'statusline-prev'), 'utf8'))
  } catch {
    return ''
  }
}

// ── main ────────────────────────────────────────────────────────────────────

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const subagents = process.argv[2] === '--subagents'
  const payload = trimEol(await readStdin())
  if (!payload) return

  const { event, line } = summarize(payload, subagents)
  const posting = event ? post(event) : null // runs while the chained command does

  const prev = prevCommand(subagents)
  const chained = prev ? await runChained(prev, payload) : ''
  const shown = chained || line
  if (shown) process.stdout.write(`${shown}\n`)

  await posting
}

process.stdout.on('error', () => {})
main().catch(() => {}) // always exit 0
