#!/usr/bin/env node
// =============================================================================
// agent-tracker.mjs — Claude Code Hook → Agent Office bridge
//
// Claude Code passes hook event JSON on stdin.
// This script inspects the event and forwards relevant activity to the
// Agent Office server at http://127.0.0.1:3334/event (AGENT_OFFICE_PORT or
// AGENT_OFFICE_EVENT_URL move it; see hooks/office-client.mjs officeUrl).
// It is a port of the bash+python agent-tracker.sh: buildEvent() is the
// Python section line by line, main() the bash wrapper.
//
// Hook events handled:
//   PreToolUse         — detect Agent tool calls, MCP tool calls, tool activity
//   PostToolUse        — detect Agent/MCP completion; any other call's finish
//                        (main thread or worker) lowers the permission hand
//                        that very call raised
//   PostToolUseFailure — a tool call errored (a non-zero Bash exit lands here
//                        and gets NO PostToolUse); shown as a failed status
//   SubagentStart      — a subagent exists; ties the office agent to its agent_id
//   SubagentStop       — a subagent finished (the completion signal for background agents)
//   SessionStart       — a Claude Code session began (startup/resume/compact/clear/fork)
//   SessionEnd         — that session exited
//   UserPromptSubmit   — the boss's prompt (or a background worker waking Claude)
//   Stop               — Claude's turn ended: its reply + the background work still running
//   PermissionRequest  — Claude is waiting for a permission answer
//   Notification       — permission_prompt / idle_prompt / quota_* / agent_needs_input
//   StopFailure        — the turn ended on an API error
//   PreCompact /
//   PostCompact        — context compaction started / finished
//   PostToolBatch      — a batch of tool calls finished, on the main thread or
//                        inside a worker (lowers a permission hand that thread
//                        raised)
//   CwdChanged         — the session cd'd somewhere else (project tag follows)
//   PostModelSwitch    — the session runs another model now
//   TaskCreated /
//   TaskCompleted      — the session's task list changed (the TaskCreate tool,
//                        TaskUpdate to completed); the office reads the list
//                        itself from ~/.claude/tasks/<session_id>/, these only
//                        make it look at once
//
// Every event carries the session it came from: sessionId (session_id),
// project (basename of cwd), cwd and transcriptPath. Two terminals are two
// sessions, and the server keeps their agents apart with these. The events
// of the second group describe the session's own Claude (its "main" record
// on the server) rather than a worker.
//
// UserPromptSubmit is special: whatever a hook prints on stdout is injected
// into Claude's context and exit 2 blocks the prompt. main() therefore never
// prints on any event but PermissionRequest and only ever exits 0, so nothing
// of the office leaks into the conversation.
//
// PermissionRequest is the one event that may print: what a PermissionRequest
// hook writes on stdout answers the dialog. When the office is allowed to
// answer (the marker file $AGENT_OFFICE_HOME/answer-permissions exists — the
// server keeps it in step with its answerPermissions setting) the event is
// POSTed in the foreground, the server's reply names a pending permission, and
// the script long-polls GET /permission/<id> until the office clicks (the hook
// output is built HERE from the decision word, after the office has proved it
// holds the token) or the server says the dialog was answered in the
// terminal, expired, or is unknown (nothing is printed). If the server cannot
// be reached at any point, exit 0 at once: the terminal dialog is in charge.
// Every other event is POSTed and never waits for an answer.
//
// Background agents (run_in_background): the Agent tool returns straight away
// with status "async_launched", so PostToolUse only links the office agent to
// the subagent's agentId. The agent leaves on SubagentStop (or a
// SubagentHandback tool call, on Claude Code versions that have one).
// Tool calls made inside a subagent carry that subagent's agent_id, which is
// forwarded so the server knows which office agent is doing the work.
//
// Signals: a Bash command that deploys, builds, tests or pushes is classified
// (classifyCommand, "Signals" below, with its pattern table) and its start,
// success or failure travels as `signals` on the event the call sends anyway —
// deploy_start / deploy_success / deploy_fail, build_*, test_*, push /
// push_done / push_failed — so the office can show a deploy shipping, open an
// incident when one fails, and cheer a push to main.
//
// The payload shapes handled below are the ones Claude Code 2.1.300 was
// observed sending (see tests/hook-script.test.ts for verbatim captures).
//
// Usage (configured in ~/.claude/settings.json hooks section):
//   { "type": "command", "command": "node \"/path/to/hooks/agent-tracker.mjs\"" }
//
// Python semantics this port keeps on purpose (each has a vector in
// tests/hook-script.test.ts): `x or default` treats [] {} 0 '' None as unset
// (truthy / or); str() of True/None/float and of a list or dict is Python's
// (pyStr); slices count code points (cut); int() takes floats and strings
// (pyInt); str.split()/strip() use Python's whitespace set (pySplit /
// pyStrip); re's \b \d \s ^ $ . are Unicode- and newline-aware the Python way
// (pyRe); shlex.split is POSIX mode (shlexSplit); the call_key text is
// json.dumps(sort_keys, compact, ensure_ascii=False) (compactJson).
// =============================================================================

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { officeHome, officeUrl, readToken, send, signHeaders } from './office-client.mjs'

// ── Python semantics ────────────────────────────────────────────────────────

// str.isspace() / the whitespace str.split() and str.strip() use. Not JS \s:
// Python has \x1c-\x1f and \x85, JS has ﻿.
const WS = '\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const WS_RUN = new RegExp(`[${WS}]+`, 'u')
const WS_ONE = new RegExp(`^[${WS}]$`, 'u')
const WS_LEAD = new RegExp(`^[${WS}]+`, 'u')
const WS_TRAIL = new RegExp(`[${WS}]+$`, 'u')
const pyStrip = s => s.replace(WS_LEAD, '').replace(WS_TRAIL, '')
const pyLstrip = s => s.replace(WS_LEAD, '')
const pySplit = s => s.split(WS_RUN).filter(w => w !== '')

// Digits str.isdigit() accepts beyond \p{Nd} (superscripts, circled digits, ...)
const EXTRA_DIGITS = /^[\u{b2}\u{b3}\u{b9}\u{1369}-\u{1371}\u{19da}\u{2070}\u{2074}-\u{2079}\u{2080}-\u{2089}\u{2460}-\u{2468}\u{2474}-\u{247c}\u{2488}-\u{2490}\u{24ea}\u{24f5}-\u{24fd}\u{24ff}\u{2776}-\u{277e}\u{2780}-\u{2788}\u{278a}-\u{2792}\u{10a40}-\u{10a43}\u{10e60}-\u{10e68}\u{11052}-\u{1105a}\u{1f100}-\u{1f10a}]$/u
const ND = /^\p{Nd}$/u
const pyIsDigit = ch => ND.test(ch) || EXTRA_DIGITS.test(ch)
const pyIsDigitStr = s => s !== '' && Array.from(s).every(pyIsDigit)
const pyIsAlnum = ch => /^[\p{L}\p{N}]$/u.test(ch)

/** Python truth: [] {} 0 '' None and False are falsy. */
function truthy(x) {
  if (x === null || x === undefined || x === false || x === 0 || x === '') return false
  if (Array.isArray(x)) return x.length > 0
  if (typeof x === 'object') return Object.keys(x).length > 0
  return true
}
/** `a or b` (b is evaluated either way: keep it free of anything that can raise). */
const or = (a, b) => (truthy(a) ? a : b)
const isDict = x => x !== null && typeof x === 'object' && !Array.isArray(x)
const has = (o, k) => Object.hasOwn(o, k)
/** dict.get(key, default): a missing key gives the default, a null value stays None. Raises on a non-dict, like AttributeError. */
function pget(o, k, dflt = null) {
  if (!isDict(o)) throw new TypeError('not a dict')
  return has(o, k) ? o[k] : dflt
}
/** A dict key must be hashable: a list or dict raises TypeError. */
function hashable(x) {
  if (Array.isArray(x) || isDict(x)) throw new TypeError('unhashable')
  return x
}

/** s[:n] by code points. */
const cut = (s, n) => (s.length <= n ? s : Array.from(s).slice(0, n).join(''))
/** s[-n:] by code points. */
const tail = (s, n) => (s.length <= n ? s : Array.from(s).slice(-n).join(''))
/** The last path segment, splitting on / and \ (Windows cwd and file paths). */
const lastSegment = p => p.split(/[\\/]/).pop()
/** os.path.basename(p.rstrip('/')), with \ a separator as well. */
const baseName = p => lastSegment(p.replace(/[\\/]+$/, ''))

/** Python's repr(float): the shortest digits, in Python's fixed/exponent split. */
function floatRepr(x, forJson = false) {
  if (Number.isNaN(x)) return forJson ? 'NaN' : 'nan'
  if (!Number.isFinite(x)) return (x < 0 ? '-' : '') + (forJson ? 'Infinity' : 'inf')
  const [mant, e] = x.toExponential().split('e')
  const exp = Number(e)
  const sign = mant.startsWith('-') ? '-' : ''
  const digits = mant.replace('-', '').replace('.', '')
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits
    return `${sign}${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
  }
  const decpt = exp + 1
  if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`
  if (decpt >= digits.length) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}.0`
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`
}
// shortcut: JSON.parse forgets whether a lexeme was 1 or 1.0, so an integral value
// below 1e21 counts as a Python int and anything else as a float: exactly how
// Claude Code's own JSON.stringify writes them (no 1.0, exponent from 1e21 up).
// A foreign producer's "1.0" or an integer past 2**53 would be spelled differently.
const numRepr = (x, forJson) => (Number.isInteger(x) && Math.abs(x) < 1e21 ? String(x) : floatRepr(x, forJson))

const NONPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u
function strRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'"
  let out = q
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (ch === q || ch === '\\') out += '\\' + ch
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if ((cp >= 0x20 && cp < 0x7f) || (cp >= 0x80 && !NONPRINTABLE.test(ch))) out += ch
    else if (cp <= 0xff) out += '\\x' + cp.toString(16).padStart(2, '0')
    else if (cp <= 0xffff) out += '\\u' + cp.toString(16).padStart(4, '0')
    else out += '\\U' + cp.toString(16).padStart(8, '0')
  }
  return out + q
}
function pyRepr(x) {
  if (x === null || x === undefined) return 'None'
  if (x === true) return 'True'
  if (x === false) return 'False'
  if (typeof x === 'number') return numRepr(x, false)
  if (typeof x === 'string') return strRepr(x)
  if (Array.isArray(x)) return `[${x.map(pyRepr).join(', ')}]`
  return `{${Object.keys(x).map(k => `${strRepr(k)}: ${pyRepr(x[k])}`).join(', ')}}`
}
/** str(x) */
const pyStr = x => (typeof x === 'string' ? x : pyRepr(x))

/** int(x): floats truncate, strings parse (underscores, Unicode digits, whitespace), anything else raises. */
function pyInt(x) {
  if (typeof x === 'boolean') return x ? 1 : 0
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) throw new RangeError('int of inf/nan')
    return Math.trunc(x)
  }
  if (typeof x === 'string') {
    const m = /^([+-]?)(\p{Nd}+(?:_\p{Nd}+)*)$/u.exec(pyStrip(x))
    if (!m) throw new SyntaxError('invalid literal for int()')
    const digits = Array.from(m[2].replaceAll('_', '')).map(ch => {
      let cp = ch.codePointAt(0)
      let v = 0
      while (ND.test(String.fromCodePoint(cp - 1))) { cp--; v++ }
      return v % 10
    }).join('')
    return m[1] === '-' ? -Number(digits) : Number(digits)
  }
  throw new TypeError('int() argument')
}

const cmpCodePoints = (a, b) => {
  const x = Array.from(a)
  const y = Array.from(b)
  for (let i = 0; i < x.length && i < y.length; i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0)
    if (d) return d
  }
  return x.length - y.length
}
const JSON_ESC = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' }
const jsonStr = s => `"${s.replace(/["\\\u{0}-\u{1f}]/gu, c => JSON_ESC[c] ?? `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`)}"`
/** json.dumps(v, separators=(',', ':'), ensure_ascii=False, sort_keys=sort) */
function compactJson(v, sort = false) {
  if (v === null || v === undefined) return 'null'
  if (v === true) return 'true'
  if (v === false) return 'false'
  if (typeof v === 'number') return numRepr(v, true)
  if (typeof v === 'string') return jsonStr(v)
  if (Array.isArray(v)) return `[${v.map(x => compactJson(x, sort)).join(',')}]`
  const keys = sort ? Object.keys(v).sort(cmpCodePoints) : Object.keys(v)
  return `{${keys.map(k => `${jsonStr(k)}:${compactJson(v[k], sort)}`).join(',')}}`
}

/**
 * A Python `re` pattern as a JS RegExp. Python's \b \w \d \s and `.` ^ $ are
 * not JS's: \b is Unicode-aware, \d is any decimal digit, \s is Python's
 * whitespace, `.` takes \r, and under re.M ^ and $ see only \n.
 */
const WORD = '[\\p{L}\\p{N}_]'
const BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`
function pyRe(src, flags = '') {
  const multi = flags.includes('m')
  const dotall = flags.includes('s')
  let out = ''
  let inClass = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      const n = src[++i]
      if (n === 'b' && !inClass) out += BOUNDARY
      else if (n === 'd') out += '\\p{Nd}'
      else if (n === 's') out += inClass ? WS : `[${WS}]`
      else out += `\\${n}`
    } else if (inClass) {
      if (c === ']') inClass = false
      out += c
    } else if (c === '[') {
      inClass = true
      out += c
      if (src[i + 1] === '^') { out += '^'; i++ }
    } else if (c === '.') out += dotall ? '[\\s\\S]' : '[^\\n]'
    else if (c === '^' && multi) out += '(?<![^\\n])'
    else if (c === '$' && multi) out += '(?![^\\n])'
    else out += c
  }
  return new RegExp(out, `u${flags.includes('i') ? 'i' : ''}${flags.includes('g') ? 'g' : ''}`)
}

// shlex.split(s) in POSIX mode (whitespace_split, no comments): the state
// machine of CPython's shlex.read_token for the one configuration used here.
// Raises on an unterminated quote or a trailing backslash, like ValueError.
const SHLEX_WS = ' \t\r\n'
function shlexSplit(s) {
  const chars = Array.from(s)
  const tokens = []
  let pos = 0
  for (;;) {
    let state = ' '
    let token = ''
    let escapedstate = ' '
    let eof = false
    for (;;) {
      const ch = pos < chars.length ? chars[pos++] : ''
      if (state === ' ') {
        if (ch === '') { eof = true; break }
        if (SHLEX_WS.includes(ch)) continue
        if (ch === '\\') { escapedstate = 'a'; state = ch } else if (ch === '"' || ch === "'") state = ch
        else { token = ch; state = 'a' }
      } else if (state === '"' || state === "'") {
        if (ch === '') throw new SyntaxError('No closing quotation')
        if (ch === state) state = 'a'
        else if (ch === '\\' && state === '"') { escapedstate = state; state = ch } else token += ch
      } else if (state === '\\') {
        if (ch === '') throw new SyntaxError('No escaped character')
        // In posix shells, only the quote itself or the escape character may be escaped within quotes
        if ((escapedstate === '"' || escapedstate === "'") && ch !== state && ch !== escapedstate) token += state
        token += ch
        state = escapedstate
      } else { // 'a': inside a word
        if (ch === '') { eof = true; break }
        if (SHLEX_WS.includes(ch)) break
        if (ch === '"' || ch === "'") state = ch
        else if (ch === '\\') { escapedstate = 'a'; state = ch } else token += ch
      }
    }
    if (eof && state === ' ') return tokens
    tokens.push(token)
    if (eof) return tokens
  }
}

// ── Hook payload → office event ─────────────────────────────────────────────

/**
 * The hook payload (stdin text) as the event the office should get, or null
 * when the hook has nothing to say. { event, wait }: `wait` is true for a
 * PermissionRequest the office may answer. Any failure is "nothing to say",
 * as the Python's uncaught exception was.
 */
export function buildEvent(payloadText, env = process.env) {
  try {
    return run(payloadText, env)
  } catch {
    return null
  }
}

function run(payloadText, env) {
  let d
  try {
    d = JSON.parse(payloadText || '{}')
  } catch {
    return null
  }
  if (!isDict(d)) return null

  const hookEvent = pget(d, 'hook_event_name', '')
  const toolName = pget(d, 'tool_name', '')

  // ── Session identity — present on every hook payload Claude Code sends ───
  // session_id, transcript_path and cwd are in the base schema of all 33 hook
  // events (captured 2.1.300). project is the basename of cwd: the folder the
  // terminal was opened in, which is what the office shows on the session pill.
  const sessionFields = payload => {
    const out = {}
    const sid = pget(payload, 'session_id')
    if (truthy(sid)) out.sessionId = pyStr(sid)
    const cwd = pget(payload, 'cwd')
    if (typeof cwd === 'string' && cwd) {
      out.project = baseName(cwd) || cwd
      out.cwd = cwd
    }
    const transcript = pget(payload, 'transcript_path')
    if (typeof transcript === 'string' && transcript) out.transcriptPath = transcript
    return out
  }
  const SESSION = sessionFields(d)

  const emit = (event, wait = false) => {
    // Every event the office receives says which session it belongs to
    for (const [key, value] of Object.entries(SESSION)) if (!has(event, key)) event[key] = value
    return { event, wait }
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────
  // Captured 2.1.300 payloads (besides session_id/transcript_path/cwd):
  //   SessionStart {"source": "startup"}                      first start, no model
  //   SessionStart {"source": "startup", "model": "claude-haiku-5-5"}
  //   SessionStart {"source": "resume", "seconds_since_last_response": 5,
  //                 "context_tokens": 44052, ...}             claude -r / --continue
  //   SessionStart {"source": "compact", "model": "claude-haiku-5-5", "prompt_id": ...}
  //   SessionEnd   {"reason": "other"}                        every -p exit
  //   SessionEnd   {"reason": "prompt_input_exit"}            /exit
  // source may also be clear | fork (schema). session_title is only present
  // when the session was named (--name, /rename) and becomes `title`.
  if (hookEvent === 'SessionStart') {
    const event = { type: 'session_started', source: pyStr(or(pget(d, 'source'), 'startup')) }
    if (truthy(pget(d, 'model'))) event.model = pyStr(d.model)
    if (truthy(pget(d, 'session_title'))) event.title = cut(pyStr(d.session_title), 120)
    return SESSION.sessionId ? emit(event) : null
  }

  if (hookEvent === 'SessionEnd') {
    return SESSION.sessionId ? emit({ type: 'session_ended', reason: pyStr(or(pget(d, 'reason'), 'other')) }) : null
  }

  // ── Subagent started — fires right after PreToolUse(Agent) ────────────────
  // Captured 2.1.300 payload (besides session_id/transcript_path/cwd/prompt_id):
  //   {"hook_event_name": "SubagentStart", "agent_id": "ac5ff55b850b4fecf",
  //    "agent_type": "general-purpose"}
  // Here `agent_id` IS the new subagent — the same id its tool calls and its
  // SubagentStop carry later — not the agent the hook ran inside, as it is on
  // every other event. There is no tool_use_id, description or parent field, so
  // the lineage of a nested spawn comes from the PreToolUse(Agent) that launched
  // it (parentSubagentId below), not from here. The server ties the id to the
  // agent_spawned of the same agent_type, whichever of the two arrives first.
  if (hookEvent === 'SubagentStart') {
    if (truthy(pget(d, 'agent_id')) && truthy(pget(d, 'agent_type'))) {
      return emit({ type: 'agent_started', subagentId: pyStr(d.agent_id), agentType: pyStr(d.agent_type) })
    }
    return null
  }

  // ── Subagent finished (foreground or background) — carries the subagent's
  // agent_id and its final message, but no tool_name.
  // SubagentStop also fires for sidechains that are not workers and never had a
  // SubagentStart: the compaction summariser (between PreCompact/PostCompact)
  // and the prompt-suggestion pass, both with agent_type "". Those are phantoms,
  // so emit nothing rather than a completion for an id the office never saw.
  if (hookEvent === 'SubagentStop') {
    if (truthy(pget(d, 'agent_id')) && truthy(pget(d, 'agent_type'))) {
      const event = {
        type: 'agent_completed',
        agentId: pyStr(d.agent_id),
        result: cut(pyStr(or(pget(d, 'last_assistant_message'), 'done')), 120),
      }
      // The worker's own transcript (…/<session_id>/subagents/agent-<agent_id>.jsonl),
      // which the inspector card tails; a path string, nothing from inside it
      const transcript = pget(d, 'agent_transcript_path')
      if (typeof transcript === 'string' && transcript) event.agentTranscriptPath = cut(transcript, 400)
      return emit(event)
    }
    return null
  }

  // ── The session's own Claude ──────────────────────────────────────────────
  // The events below describe the main thread, not a worker, and none of them
  // carries a tool_name except PermissionRequest — so they sit above the
  // tool_name gate. All of them need the session they belong to. Text is
  // clamped HERE as well as on the server: the server clamps `text` to 2000
  // characters, but an oversize body would be refused whole (413) and the state
  // change lost along with the text.
  const clamp = (value, limit) => cut(pyStr(value ?? ''), limit)
  // Labels: whitespace collapsed, then clamped
  const oneLine = (value, limit) => cut(pySplit(pyStr(value ?? '')).join(' '), limit)

  const emitSession = (event, wait = false) => {
    const pid = pget(d, 'prompt_id')
    if (truthy(pid)) event.promptId = cut(pyStr(pid), 80)
    // `wait` tells main() to POST this one in the foreground and wait for the
    // office's answer (PermissionRequest only)
    return SESSION.sessionId ? emit(event, wait) : null
  }

  // UserPromptSubmit {prompt, prompt_id, permission_mode} — the boss's prompt.
  // Also fired for turns Claude Code starts by itself: a background subagent
  // reporting back arrives as a prompt that begins "<task-notification>" and
  // names the subagent in <task-id> (captured 2.1.300: the schema's `source`
  // field, which would say so, was never sent). Such a wake-up is flagged and
  // only its <summary> line travels, never the XML or the agent's result.
  if (hookEvent === 'UserPromptSubmit') {
    const raw = pget(d, 'prompt')
    const prompt = typeof raw === 'string' ? raw : ''
    const event = { type: 'session_prompt', text: clamp(prompt, 2000), isWakeup: false }
    if (pyLstrip(prompt).startsWith('<task-notification>')) {
      event.isWakeup = true
      let m = pyRe('<task-id>\\s*([^<\\s]+)\\s*</task-id>').exec(prompt)
      if (m) event.wakeupAgentId = cut(m[1], 80)
      m = pyRe('<status>\\s*([^<\\s]+)\\s*</status>').exec(prompt)
      if (m) event.wakeupStatus = cut(m[1], 40)
      m = pyRe('<summary>(.*?)</summary>', 's').exec(prompt)
      event.text = oneLine(m ? m[1] : 'a background task finished', 2000)
    }
    return emitSession(event)
  }

  // Stop {stop_hook_active, last_assistant_message, background_tasks, session_crons}
  // — Claude's turn ended. background_tasks is the in-flight background work
  // ({id, type, status, description, ...} per the schema; every captured Stop
  // had [] because a background subagent's finish is delivered as a new prompt,
  // so "waiting on N workers" is schema-backed, not capture-backed).
  // session_crons are scheduled wake-ups (/loop, CronCreate). Stop does NOT fire
  // when the user rejects a permission dialog — that turn is interrupted.
  if (hookEvent === 'Stop') {
    const tasks = []
    const rawTasks = pget(d, 'background_tasks')
    for (const task of (Array.isArray(rawTasks) ? rawTasks : []).slice(0, 10)) {
      if (!isDict(task)) continue
      tasks.push({
        id: clamp(pget(task, 'id'), 64),
        type: clamp(pget(task, 'type'), 40),
        status: clamp(pget(task, 'status'), 40),
        description: oneLine(pget(task, 'description'), 120),
      })
    }
    const crons = pget(d, 'session_crons')
    return emitSession({
      type: 'session_turn_end',
      text: clamp(pget(d, 'last_assistant_message'), 2000),
      backgroundTasks: tasks,
      crons: Array.isArray(crons) ? crons.length : 0,
      stopHookActive: truthy(pget(d, 'stop_hook_active')),
    })
  }

  // PermissionRequest {tool_name, tool_input, permission_suggestions} — Claude
  // is waiting for the user's answer (no tool_use_id). In -p mode the call is
  // auto-denied as soon as every PermissionRequest hook has finished;
  // interactively the dialog stays up and a Notification{permission_prompt}
  // follows ~6 s later (deduped server-side). A request raised inside a
  // subagent would carry agent_id (schema-only, not captured); it is forwarded
  // when present.
  //
  // Which call asked: with no tool_use_id, the only thing a PermissionRequest
  // shares with its own call's PostToolUse is the tool input (captured: the
  // PreToolUse, the PermissionRequest and the batch entry of one call carry the
  // same tool_input). callKey hashes the tool name and that input; the
  // PermissionRequest and every PostToolUse send it, so the server lowers a hand
  // only on the finish of the call that raised it, not on another call of the
  // same tool running beside it (`git status` next to the `git push` that asked).
  // When the office may answer (ANSWER_MARKER exists, kept by the server in step
  // with its answerPermissions setting) the event also carries what the card
  // needs — answerable, permissionMode, the dialog's own permission_suggestions
  // (echoed back verbatim on "allow and remember", so their shape is kept and
  // only their sizes are bounded) and a detail line (the command, the path, or
  // the tool input as compact JSON) — and main() waits for the answer.
  const FILE_TOOLS = ['Write', 'Edit', 'Read', 'MultiEdit', 'NotebookEdit']

  const permissionSummary = (name, inp) => {
    inp = isDict(inp) ? inp : {}
    if (FILE_TOOLS.includes(name)) {
      return baseName(pyStr(or(or(pget(inp, 'file_path'), pget(inp, 'notebook_path')), ''))) || name
    }
    if (name === 'Bash') return oneLine(or(pget(inp, 'command'), pget(inp, 'description')), 80) || name
    return name
  }

  const permissionDetail = (name, inp) => {
    inp = isDict(inp) ? inp : {}
    let text
    if (name === 'Bash') text = or(or(pget(inp, 'command'), pget(inp, 'description')), '')
    else if (FILE_TOOLS.includes(name)) text = or(or(pget(inp, 'file_path'), pget(inp, 'notebook_path')), '')
    else text = compactJson(inp)
    return clamp(text, 400)
  }

  // permission_suggestions, bounded but shape-preserving (server re-clamps)
  const clampJson = (value, depth = 0) => {
    if (typeof value === 'string') return cut(value, 200)
    if (value === null || value === undefined || typeof value === 'boolean') return value ?? null
    if (typeof value === 'number') return value
    if (depth >= 3) return null
    if (Array.isArray(value)) return value.slice(0, 8).map(v => clampJson(v, depth + 1))
    if (isDict(value)) return Object.fromEntries(Object.entries(value).slice(0, 12).map(([k, v]) => [cut(k, 40), clampJson(v, depth + 1)]))
    return null
  }

  if (hookEvent === 'PermissionRequest') {
    const name = pyStr(or(toolName, 'tool'))
    const toolInput = pget(d, 'tool_input')
    const event = {
      type: 'session_needs_you',
      kind: 'permission',
      toolName: cut(name, 80),
      summary: cut(permissionSummary(name, toolInput), 120),
      callKey: callKey(name, toolInput),
    }
    if (truthy(pget(d, 'agent_id'))) event.agentId = pyStr(d.agent_id)
    const answerable = existsSync(path.join(officeHome(env), 'answer-permissions'))
    if (answerable) {
      const suggestions = pget(d, 'permission_suggestions')
      event.answerable = true
      event.permissionMode = clamp(or(pget(d, 'permission_mode'), 'default'), 40)
      event.suggestions = Array.isArray(suggestions) ? suggestions.filter(isDict).map(s => clampJson(s)).slice(0, 4) : []
      event.detail = permissionDetail(name, toolInput)
      // A fresh nonce the office must echo back inside its proof. A squatter
      // answering the POST has never seen the token, so it cannot forge
      // HMAC(token, nonce + permissionId + decision) and its answer is
      // rejected before anything is printed.
      event.nonce = randomBytes(16).toString('hex')
    }
    return emitSession(event, answerable)
  }

  // Notification {message, notification_type, title?} — only the types that mean
  // the session is waiting on a person (or was paused by the quota) are
  // forwarded; auth_success, elicitation_*, agent_completed, ... are ignored.
  // permission_prompt and idle_prompt are presence-gated (they fire only when
  // the user looks away from the terminal), so they are best-effort.
  if (hookEvent === 'Notification') {
    const ntype = pyStr(or(pget(d, 'notification_type'), ''))
    const kind = NOTIFICATION_KINDS.get(ntype)
    if (!kind) return null
    return emitSession({
      type: 'session_needs_you',
      kind,
      notificationType: cut(ntype, 40),
      message: oneLine(pget(d, 'message'), 200),
    })
  }

  // StopFailure {error, error_details?, last_assistant_message?} — the turn
  // ended on an API error (rate_limit, overloaded, authentication_failed, ...).
  // Never captured locally; shape per the schema and the hooks reference.
  if (hookEvent === 'StopFailure') {
    const detail = or(or(pget(d, 'error_details'), pget(d, 'last_assistant_message')), '')
    return emitSession({
      type: 'session_error',
      error: oneLine(or(pget(d, 'error'), 'unknown'), 40),
      detail: oneLine(detail, 200),
    })
  }

  // PreCompact / PostCompact {trigger: manual|auto} — the summary text is not
  // forwarded (it is the conversation). PreCompact fires even when compaction
  // is then refused ("Not enough messages"), so a `pre` may have no `post`.
  if (hookEvent === 'PreCompact' || hookEvent === 'PostCompact') {
    return emitSession({
      type: 'session_compact',
      phase: hookEvent === 'PreCompact' ? 'pre' : 'post',
      trigger: oneLine(or(pget(d, 'trigger'), 'manual'), 20),
    })
  }

  // PostToolBatch {tool_calls: [{tool_name, tool_input, tool_use_id, tool_response}]}
  // — one per model turn, once every tool call of that turn has an answer
  // (a denied one included). The server uses it to lower a permission hand the
  // batch has answered, so a headless auto-deny (PermissionRequest, then this
  // ~60 ms later) never shows. Inside a subagent (agent_id, captured) the batch
  // is that worker's: it answers only a dialog the worker raised, and the
  // worker's id travels so the server can tell.
  if (hookEvent === 'PostToolBatch') {
    const calls = pget(d, 'tool_calls')
    const event = { type: 'session_tool_done', batch: true, count: Array.isArray(calls) ? calls.length : 0 }
    if (truthy(pget(d, 'agent_id'))) event.agentId = pyStr(d.agent_id)
    return emitSession(event)
  }

  // CwdChanged {old_cwd, new_cwd} — after a persistent `cd` in Bash. The
  // session's cwd and project tag follow (the payload's own cwd is still the
  // old one, so both are set explicitly before emit() fills the defaults).
  if (hookEvent === 'CwdChanged') {
    const newCwd = pget(d, 'new_cwd')
    if (typeof newCwd === 'string' && newCwd) {
      const event = { type: 'session_cwd', cwd: newCwd, project: baseName(newCwd) || newCwd }
      const oldCwd = pget(d, 'old_cwd')
      if (typeof oldCwd === 'string' && oldCwd) event.oldCwd = oldCwd
      return emitSession(event)
    }
    return null
  }

  // PostModelSwitch {from_model, to_model, requested_model, source, context_tokens, ...}
  // — /model, the picker, an SDK set_model or an automatic fallback.
  if (hookEvent === 'PostModelSwitch') {
    const toModel = pget(d, 'to_model')
    if (typeof toModel === 'string' && toModel) {
      const event = { type: 'session_model', model: cut(toModel, 80) }
      const fromModel = pget(d, 'from_model')
      if (typeof fromModel === 'string' && fromModel) event.fromModel = cut(fromModel, 80)
      const source = pget(d, 'source')
      if (typeof source === 'string' && source) event.switchSource = cut(source, 20)
      return emitSession(event)
    }
    return null
  }

  // TaskCreated {task_id, task_subject, task_description?, teammate_name?} — the
  // TaskCreate tool is making a task; TaskCompleted — TaskUpdate is setting one
  // to completed. Shapes from the schema and the hooks reference (never fired
  // here: this machine's sessions have no task tools). The task list itself is
  // on disk (~/.claude/tasks/<session_id>/<n>.json) and the server reads it
  // (server/tasks.js), so the event only names the task and says "look now";
  // nothing is printed on stdout, which on these events could veto the change.
  // The description stays here: it is longer, conversation-derived text, and
  // the server serves it from the file only to a token holder.
  if (hookEvent === 'TaskCreated' || hookEvent === 'TaskCompleted') {
    const taskId = oneLine(pget(d, 'task_id'), 40)
    if (taskId) {
      return emitSession({
        type: hookEvent === 'TaskCreated' ? 'task_created' : 'task_completed',
        taskId,
        subject: oneLine(pget(d, 'task_subject'), 120),
      })
    }
    return null
  }

  if (!truthy(toolName)) return null

  // ── MCP tool calls  (tool names match pattern: mcp__<server>__<tool>) ─────
  if (typeof toolName !== 'string') throw new TypeError('tool_name.startswith')
  if (toolName.startsWith('mcp__')) {
    const stripped = toolName.slice('mcp__'.length)
    // Split on first '__' to get server and tool
    const at = stripped.indexOf('__')
    const mcpServer = at < 0 ? stripped : stripped.slice(0, at)
    const mcpTool = at < 0 ? '' : stripped.slice(at + 2)

    if (hookEvent === 'PreToolUse') {
      return emit({ type: 'mcp_call', server: mcpServer, tool: mcpTool })
    }
    if (hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure') {
      // A failed MCP call gets PostToolUseFailure instead of PostToolUse;
      // either way the transient worker leaves. The tool, the callKey and
      // the worker it ran in (if any) let the server lower the permission
      // hand this call raised, as session_tool_done does for other tools
      const done = {
        type: 'mcp_done',
        server: mcpServer,
        tool: mcpTool,
        callKey: callKey(toolName, pget(d, 'tool_input')),
      }
      if (truthy(pget(d, 'agent_id'))) done.agentId = pyStr(d.agent_id)
      return emit(done)
    }
    return null
  }

  const roleFor = (subagentType, task = '') => {
    let role = ROLE_MAP.get(hashable(subagentType)) ?? 'general-purpose'
    if (role === 'general-purpose' && truthy(task)) {
      if (typeof task !== 'string') throw new TypeError('task.lower')
      const low = task.toLowerCase()
      for (const [re, hinted] of taskRoleHints()) if (re.test(low)) return hinted
    }
    return role
  }

  const responseDict = resp => {
    if (isDict(resp)) return resp
    if (typeof resp === 'string') {
      try {
        const parsed = JSON.parse(resp)
        return isDict(parsed) ? parsed : {}
      } catch {
        return {}
      }
    }
    return {}
  }

  const resultText = resp => {
    if (isDict(resp)) {
      let out = has(resp, 'output') ? resp.output : has(resp, 'result') ? resp.result : has(resp, 'content') ? resp.content : 'done'
      if (Array.isArray(out)) out = out.map(c => (isDict(c) ? pyStr(pget(c, 'text', '')) : pyStr(c))).join(' ')
      return cut(pyStr(out), 120)
    }
    if (typeof resp === 'string') return cut(resp, 120)
    return 'done'
  }

  // Set when this hook fires for a tool call made inside a subagent
  const subAgentId = or(pget(d, 'agent_id', ''), '')
  const subAgentType = or(pget(d, 'agent_type', ''), '')

  const tagSubagent = event => {
    // Inside a subagent — the server maps this id to the office agent
    if (truthy(subAgentId)) {
      event.agentId = pyStr(subAgentId)
      event.agentType = or(subAgentType, 'general-purpose')
      event.role = roleFor(subAgentType)
      event.name = NAME_MAP.get(event.role) ?? 'Agent'
    }
    return event
  }

  // First 60 chars of a tool error with its newlines collapsed, e.g.
  // "Exit code 1" + newline + "cat: /x: No such file" -> "Exit code 1 cat: /x: No such file"
  const errorSummary = (err, limit = 60) => cut(pySplit(pyStr(or(err, ''))).join(' '), limit) || 'unknown error'

  // Attach this Bash call's signals to the event it sends anyway. A command
  // the prefilter rules out costs nothing more; a bug in the classifier
  // costs the signals, never the event.
  const withSignals = event => {
    const inp = pget(d, 'tool_input')
    const command = isDict(inp) ? pget(inp, 'command') : null
    if (toolName !== 'Bash' || typeof command !== 'string' || !mightSignal(command)) return event
    let signals
    try {
      loadSignals()
      signals = bashSignals(d, hookEvent, SESSION, clamp, oneLine)
    } catch {
      signals = []
    }
    if (signals.length) event.signals = signals
    return event
  }

  // ── Agent tool calls  (tool_name == "Agent" or "Task") ───────────────────
  if (toolName === 'Agent' || toolName === 'Task') {
    const inp = or(pget(d, 'tool_input', {}), {})
    const toolUseId = pget(d, 'tool_use_id', '')

    if (hookEvent === 'PreToolUse') {
      // Claude Code Agent tool input has: description, prompt, subagent_type, agent_type
      const description = or(pget(inp, 'description', ''), pget(inp, 'prompt', ''))
      const subagentType = or(pget(inp, 'subagent_type', ''), pget(inp, 'agent_type', ''))

      const role = roleFor(subagentType, description)
      const name = NAME_MAP.get(role) ?? 'Agent'

      // Truncate task description for display
      let task = 'Working on task'
      if (truthy(description)) {
        if (typeof description === 'string') task = cut(description, 80)
        else if (Array.isArray(description)) task = description.slice(0, 80)
        else throw new TypeError('not subscriptable')
      }

      // Stable ID based on tool_use_id if available (Python's id(d) is a memory address: any unique number)
      const agentId = truthy(toolUseId) ? `agent-${pyStr(toolUseId)}` : `agent-${role}-${140000000000000 + Math.floor(Math.random() * 9e12)}`

      const agent = {
        id: agentId,
        name,
        role,
        task,
        agentType: or(subagentType, 'general-purpose'),
        background: truthy(pget(inp, 'run_in_background')),
      }
      // Nested spawn: an Agent call made inside a subagent carries that
      // subagent's agent_id, which makes it the new agent's parent
      if (truthy(subAgentId)) agent.parentSubagentId = pyStr(subAgentId)

      return emit({ type: 'agent_spawned', agent })
    }

    if (hookEvent === 'PostToolUseFailure') {
      // The launch itself failed (unknown subagent_type, interrupted, ...):
      // no subagent ever existed, so walk the office agent out again
      const agentId = truthy(toolUseId) ? `agent-${pyStr(toolUseId)}` : ''
      if (agentId) {
        return emit({ type: 'agent_completed', agentId, result: `failed: ${errorSummary(pget(d, 'error'), 110)}` })
      }
      return null
    }

    if (hookEvent === 'PostToolUse') {
      const agentId = truthy(toolUseId) ? `agent-${pyStr(toolUseId)}` : ''
      const resp = pget(d, 'tool_response', {})
      const rd = responseDict(resp)

      // Background launch: the agent is still working. Link the office agent
      // to the subagent id so its tool calls and hand-back find it.
      if (pget(rd, 'status') === 'async_launched' || (truthy(pget(inp, 'run_in_background')) && !(pget(rd, 'status') === 'completed'))) {
        const subagentId = or(or(pget(rd, 'agentId'), pget(rd, 'agent_id')), '')
        if (agentId && truthy(subagentId)) {
          return emit({ type: 'agent_linked', agentId, subagentId: pyStr(subagentId) })
        }
        return null
      }

      // A foreground agent's result also says what it cost (captured 2.1.300:
      // totalTokens, totalDurationMs, totalToolUseCount, resolvedModel next to
      // content/usage/toolStats); each travels only when present
      const event = { type: 'agent_completed', agentId, result: resultText(resp) }
      const whole = value => typeof value === 'number' && value >= 0
      if (whole(pget(rd, 'totalTokens'))) event.tokens = pyInt(rd.totalTokens)
      if (whole(pget(rd, 'totalDurationMs'))) event.durationMs = pyInt(rd.totalDurationMs)
      if (whole(pget(rd, 'totalToolUseCount'))) event.toolUses = pyInt(rd.totalToolUseCount)
      if (typeof pget(rd, 'resolvedModel') === 'string' && rd.resolvedModel) event.model = cut(rd.resolvedModel, 80)
      return emit(event)
    }

    return null
  }

  // ── Background agent finished — some Claude Code versions hand the report back
  // through a SubagentHandback tool call instead of (or as well as) SubagentStop
  if (toolName === 'SubagentHandback' && hookEvent === 'PostToolUse') {
    const inp = or(pget(d, 'tool_input', {}), {})
    const rd = responseDict(pget(d, 'tool_response', {}))
    let subagentId = subAgentId
    if (!truthy(subagentId)) subagentId = or(pget(inp, 'agent_id'), pget(inp, 'agentId'))
    if (!truthy(subagentId)) subagentId = or(pget(rd, 'agent_id'), pget(rd, 'agentId'))
    if (!truthy(subagentId)) subagentId = ''
    if (truthy(subagentId)) {
      return emit({ type: 'agent_completed', agentId: pyStr(subagentId), result: resultText(pget(d, 'tool_response', {})) })
    }
    return null
  }

  // ── A tool call errored — Claude Code fires PostToolUseFailure {tool_name,
  // tool_input, tool_use_id, error, is_interrupt, duration_ms} and NO PostToolUse
  // for that call (a non-zero Bash exit counts: error "Exit code 1\n<stderr>").
  // Shown as a failed status on the agent that made the call; a main-thread
  // failure carries no agentId, exactly like the working events below.
  if (hookEvent === 'PostToolUseFailure') {
    return emit(withSignals(tagSubagent({
      type: 'agent_working',
      status: `failed: ${toolName} — ${errorSummary(pget(d, 'error'))}`,
      failed: true,
      tool: cut(toolName, 80),
    })))
  }

  // ── A tool call finished — PostToolUse of anything but the Agent and MCP
  // tools handled above, on the main thread or inside a worker (agentId).
  // Nothing to draw, but the permission hand this very call raised (callKey)
  // comes down on the server: the call ran, so it was granted. A worker's
  // dialog is the worker's: its own finish is what answers it.
  // A Bash call's signals ride on the session_tool_done; where nothing would be
  // sent (no session id) they go out alone as a `signal` event.
  if (hookEvent === 'PostToolUse') {
    const done = withSignals({ type: 'session_tool_done', toolName: cut(toolName, 80), callKey: callKey(toolName, pget(d, 'tool_input')) })
    if (truthy(subAgentId)) done.agentId = pyStr(subAgentId)
    if (SESSION.sessionId) return emitSession(done)
    if (truthy(done.signals)) return emit(tagSubagent({ type: 'signal', signals: done.signals }))
    return null
  }

  // ── Every other tool use — broadcast as a working status update ──────────
  // The common tools get a specific line; anything else (WebFetch, TodoWrite,
  // ToolSearch, AskUserQuestion, ...) a generic one, so the main thread (no
  // agent_id — the session's own Claude) and a worker are seen working on every
  // call, not only on the handful the office used to know.
  if (hookEvent === 'PreToolUse') {
    let inp = pget(d, 'tool_input', {})
    inp = isDict(inp) ? inp : {}

    const fileName = i => lastSegment(pyStr(or(pget(i, 'file_path'), '')))
    const statusMap = new Map([
      ['Read', i => `reading ${fileName(i)}`],
      ['Write', i => `writing ${fileName(i)}`],
      ['Edit', i => `editing ${fileName(i)}`],
      ['Bash', i => `running: ${cut(pyStr(or(or(pget(i, 'command'), pget(i, 'description')), '')), 60)}`],
      ['Grep', i => `searching for '${cut(pyStr(or(pget(i, 'pattern'), '')), 30)}'`],
      ['Glob', i => `finding files: ${cut(pyStr(or(pget(i, 'pattern'), '')), 40)}`],
      ['Skill', i => `using /${pyStr(or(pget(i, 'skill'), 'skill'))}`],
    ])

    const statusFn = statusMap.get(toolName)
    const status = statusFn ? statusFn(inp) : `using ${cut(toolName, 40)}`
    // The tool's own name travels beside the status line: the inspector card
    // counts calls per tool, and the status is a phrase, not an identifier
    return emit(withSignals(tagSubagent({
      type: 'agent_working',
      status,
      tool: cut(toolName, 80),
    })))
  }

  return null
}

// 16 hex characters of sha256(tool name, NUL, the input as canonical JSON)
function callKey(name, inp) {
  let blob
  try {
    blob = compactJson(inp, true)
  } catch {
    return ''
  }
  // Python encodes with errors='replace': a lone surrogate becomes '?'
  const text = `${pyStr(name)}\0${blob}`.replace(/[\u{d800}-\u{dfff}]/gu, '?')
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

const NOTIFICATION_KINDS = new Map([
  ['permission_prompt', 'permission'],
  ['idle_prompt', 'idle'],
  ['quota_auto_resume_fired', 'quota'],
  ['quota_auto_resume_stale', 'quota'],
  ['quota_auto_resume_disabled', 'quota'],
  ['agent_needs_input', 'agent-input'],
])

// Role mapping: normalise subagent_type to office role keys
const ROLE_MAP = new Map([
  ['debugger', 'debugger'],
  ['code-reviewer', 'code-reviewer'],
  ['code_reviewer', 'code-reviewer'],
  ['frontend-developer', 'frontend-developer'],
  ['frontend_developer', 'frontend-developer'],
  ['fullstack-developer', 'fullstack-developer'],
  ['fullstack_developer', 'fullstack-developer'],
  ['test-engineer', 'test-engineer'],
  ['test_engineer', 'test-engineer'],
  ['security-auditor', 'security-auditor'],
  ['security_auditor', 'security-auditor'],
  ['architect-reviewer', 'architect-reviewer'],
  ['architect_reviewer', 'architect-reviewer'],
  ['performance-engineer', 'performance-engineer'],
  ['performance_engineer', 'performance-engineer'],
  ['devops-engineer', 'devops-engineer'],
  ['devops_engineer', 'devops-engineer'],
  ['database-architect', 'database-architect'],
  ['database_architect', 'database-architect'],
  ['typescript-pro', 'typescript-pro'],
  ['typescript_pro', 'typescript-pro'],
  ['ai-engineer', 'ai-engineer'],
  ['ai_engineer', 'ai-engineer'],
  ['prompt-engineer', 'prompt-engineer'],
  ['prompt_engineer', 'prompt-engineer'],
  ['general-purpose', 'general-purpose'],
  ['general_purpose', 'general-purpose'],
  ['Explore', 'Explore'],
])

// Display name per role
const NAME_MAP = new Map([
  ['debugger', 'Debugger'],
  ['code-reviewer', 'Reviewer'],
  ['frontend-developer', 'Frontend'],
  ['fullstack-developer', 'Fullstack'],
  ['test-engineer', 'Tester'],
  ['security-auditor', 'Security'],
  ['architect-reviewer', 'Architect'],
  ['performance-engineer', 'PerfEng'],
  ['devops-engineer', 'DevOps'],
  ['database-architect', 'DBA'],
  ['typescript-pro', 'TS Pro'],
  ['ai-engineer', 'AI Eng'],
  ['prompt-engineer', 'Prompts'],
  ['general-purpose', 'Agent'],
  ['Explore', 'Explorer'],
])

// General-purpose agents all share one sprite. Give them a specialist desk
// when the task clearly says what they're doing; the server spreads the rest
// across the least-used sprites.
const TASK_ROLE_HINT_SOURCES = [
  ['\\b(test|tests|testing|spec|coverage)\\b', 'test-engineer'],
  ['\\b(review|audit the diff|code review)\\b', 'code-reviewer'],
  ['\\b(debug|bug|crash|stack ?trace|failing)\\b', 'debugger'],
  ['\\b(security|vuln|cve|auth\\b|secret)', 'security-auditor'],
  ['\\b(frontend|ui|css|react|component|layout)\\b', 'frontend-developer'],
  ['\\b(perf|performance|latency|profil)', 'performance-engineer'],
  ['\\b(deploy|ci|docker|pipeline|infra)\\b', 'devops-engineer'],
  ['\\b(database|sql|schema|migration|query)\\b', 'database-architect'],
  ['\\b(architecture|design doc|refactor plan)\\b', 'architect-reviewer'],
]
let taskRoleHintRes = null
const taskRoleHints = () => (taskRoleHintRes ??= TASK_ROLE_HINT_SOURCES.map(([src, role]) => [pyRe(src), role]))

// ── Signals: what a Bash command means ──────────────────────────────────────
// A Bash call that deploys, builds, tests or pushes becomes `signals` the
// office acts on (a shipping scene, incident mode, chat lines).
// classifyCommand(command, cwd) is pure — no I/O — and returns one entry per
// meaningful segment: {kind, target?} with kind deploy | build | test | push;
// a push also says which branch it names (branch, toDefault) when the
// refspec does. The hook phase turns each entry into a signal:
//
//   kind     PreToolUse      PostToolUse      PostToolUseFailure
//   deploy   deploy_start    deploy_success   deploy_fail
//   build    build_start     build_ok         build_failed
//   test     test_start      test_ok          test_failed
//   push     push            push_done        push_failed
//
// How a command is read: it is split on && || ; | & and newlines (outside
// quotes, backticks and $(...); a heredoc body is never read), each segment
// loses its leading env assignments and wrappers (sudo, env, npx, time,
// timeout, uv run, bundle exec, ...), `cd DIR` moves the directory the next
// segments run in, and the segment's program is looked up in SIGNAL_RULES:
//
//   deploy  vercel deploy | vercel --prod, netlify deploy, fly/flyctl deploy,
//           railway up, heroku ... push, gcloud run|app|functions deploy,
//           aws ... deploy, sam deploy, serverless/sls deploy, kubectl apply |
//           rollout, helm upgrade|install, terraform/tofu apply, pulumi up,
//           cdk deploy, wrangler deploy|publish, firebase deploy, npm/pnpm/
//           yarn publish, gh release create, docker/podman push, mvn deploy,
//           make deploy|release|publish, git push of a tag (--tags, v1.2.3)
//           or to a heroku remote
//   build   npm/pnpm/yarn/bun scripts named build* | compile* | typecheck*,
//           vite build, next build, tsc, vue-tsc, cargo build, go build, make
//           (any target but clean/help/fmt and the test/deploy ones), gradle
//           build|assemble, mvn package|install|compile|verify, docker build,
//           webpack, esbuild, dotnet build
//   test    npm test / npm run test*, pnpm/yarn/bun test*, vitest, jest,
//           mocha, pytest (python -m pytest|unittest too), cargo test, go
//           test, mvn test, gradle test|check, rspec, phpunit, playwright
//           test, deno test, dotnet test, make test|check
//   push    git push (branch from the refspec; main or master is toDefault)
//
// Extending it is one row in SIGNAL_RULES (programs, the subcommand words
// that make it count, kind, the flags that take a value, where the target
// is, vetoes) — plus the program's name in SIGNAL_PROGRAMS or SIGNAL_NO_VERB
// below so the prefilter lets it through. npm/pnpm/yarn/bun scripts, make,
// gradle, mvn and git push have small functions of their own. A --dry-run,
// --version or --help run never counts.
//
// Outcome. A segment followed by `|`, `||`, `;` or `&` (or that runs only
// after a `||`) does not decide the call's exit status: `npm test | tail`
// exits 0 whatever the tests did. Such a segment is judged by its output
// instead (a failure count, "Build failed", "[rejected]", or for tests and
// builds an explicit pass line) and says nothing when the output is silent.
// Every other segment of a successful call succeeded. When the call fails,
// the segment whose kind the error text points at is blamed, else the first
// segment that could have ended the call; the rest say nothing. A Bash call
// run in the background has no outcome yet on PostToolUse; an interrupted
// one (Esc) is reported as a failure marked `interrupted`, which the office
// never counts against prod.
//
// Where they travel. The hook sends ONE JSON per invocation, so the signals
// ride on the event this call sends anyway: `signals: [...]` on the
// agent_working of PreToolUse and of PostToolUseFailure, and on the
// session_tool_done of a PostToolUse (a worker's carries its agentId). A
// PostToolUse without a session id sends nothing of its own, so there they go
// out alone as {type: 'signal', signals: [...]}, tagged with the subagent like
// any of its events. Each signal: kind, target, command (160), and on a
// failure error (the first meaningful line, 200), exitCode, detail ("3
// failing", "2 errors") and interrupted. Classification never changes the
// exit status and never fails the event it rides on.
const DEFAULT_BRANCHES = ['main', 'master']

// The prefilter. Most Bash calls (ls, cat, grep, git status, sed) can never
// be a signal, so a command only reaches the classifier when one of its words
// is a program from the table and it either needs no verb (tsc, vitest, make,
// ...) or one of its words is a verb the table knows.
const SIGNAL_PROGRAMS = new Set([
  'vercel', 'netlify', 'fly', 'flyctl', 'railway', 'heroku', 'gcloud', 'aws', 'sam', 'serverless', 'sls', 'kubectl',
  'helm', 'terraform', 'tofu', 'pulumi', 'cdk', 'wrangler', 'firebase', 'gh', 'docker', 'podman', 'docker-compose',
  'npm', 'pnpm', 'yarn', 'bun', 'vite', 'next', 'cargo', 'go', 'gradle', 'gradlew', 'mvn', 'mvnw', 'dotnet', 'deno',
  'playwright', 'git', 'python', 'python3',
])
const SIGNAL_NO_VERB = new Set(['tsc', 'vue-tsc', 'webpack', 'esbuild', 'vitest', 'jest', 'mocha', 'pytest', 'py.test', 'rspec', 'phpunit', 'make', 'gmake'])
const SIGNAL_VERBS = new Set([
  'deploy', 'up', 'push', 'container:push', 'apply', 'rollout', 'upgrade', 'install', 'publish', 'create', 'build', 'buildx',
  'test', 't', 'tst', 'run', 'run-script', 'b', 'nextest', 'assemble', 'package', 'compile', 'verify', 'check', 'workspace',
  '--prod', '--production', '-m',
])
const VERB_PREFIXES = ['build', 'test', 'compile', 'typecheck', 'type-check', 'e2e', 'spec']

export function mightSignal(command) {
  let s = command
  for (const ch of ';|&()<>\'"`${}\n\t') s = s.replaceAll(ch, ' ')
  const words = new Set(pySplit(s).map(w => w.slice(w.lastIndexOf('/') + 1)))
  const some = set => [...words].some(w => set.has(w))
  if (some(SIGNAL_NO_VERB)) return true
  if (!some(SIGNAL_PROGRAMS)) return false
  return some(SIGNAL_VERBS) || [...words].some(w => VERB_PREFIXES.some(p => w.startsWith(p)))
}

// The classifier's patterns are compiled only for a command that passed the
// prefilter (loadSignals), so an ordinary Bash call never pays for them.
// What a failed or masked run's output says, by kind
const FAIL_SOURCES = {
  test: '\\b[1-9]\\d*\\s+(?:failed|failing|failures?)\\b|^\\s*FAIL\\b|^--- FAIL|FAILURES!|\\btests? failed\\b',
  build: 'error TS\\d+|\\bbuild failed\\b|Failed to compile|error\\[E\\d+\\]|could not compile|BUILD FAILURE|FAILURE: Build failed|make(?:\\[\\d+\\])?: \\*\\*\\*|^ERROR in |Found [1-9]\\d* errors?',
  deploy: '\\b(?:deploy(?:ment)?|release|rollout|publish(?:ing)?|upload)\\b[^\\n]{0,40}\\b(?:failed|errored)\\b',
  push: '\\[(?:remote )?rejected\\]|failed to push|non-fast-forward|could not read from remote|Authentication failed',
}
const PASS_SOURCES = {
  test: '\\b[1-9]\\d*\\s+pass(?:ed|ing)\\b|test result: ok\\b|^ok\\s|\\bOK \\(\\d+ tests?|\\b\\d+ examples?, 0 failures',
  build: '\\bbuilt in\\b|Compiled successfully|BUILD SUCCESS|\\bbuild succeeded\\b',
}
const DETAIL_TEST_SOURCES = ['Tests?:?\\s+([1-9]\\d*)\\s+failed', '\\b([1-9]\\d*)\\s+failing\\b', '\\b([1-9]\\d*)\\s+failed\\b', '\\b([1-9]\\d*)\\s+failures?\\b', 'Failures:\\s*([1-9]\\d*)']
let signalTables = null

/** Compile the classifier's patterns, once. */
export function loadSignals() {
  signalTables ??= {
    fail: Object.fromEntries(Object.entries(FAIL_SOURCES).map(([k, src]) => [k, pyRe(src, 'mi')])),
    pass: Object.fromEntries(Object.entries(PASS_SOURCES).map(([k, src]) => [k, pyRe(src, 'mi')])),
    detailTest: DETAIL_TEST_SOURCES.map(src => pyRe(src, 'i')),
    detailFail: pyRe('^\\s*(FAIL\\b.*)$', 'm'),
    detailFound: pyRe('Found ([1-9]\\d*) errors?'),
    ansi: pyRe('\\x1b\\[[0-9;?]*[ -/]*[@-~]'),
  }
}
export const signalsLoaded = () => signalTables !== null
/** Forget the compiled patterns (the Python ran once per process; tests run many hooks in one). */
export function resetSignals() { signalTables = null }

const SIGNAL_NAMES = {
  deploy: ['deploy_start', 'deploy_success', 'deploy_fail'],
  build: ['build_start', 'build_ok', 'build_failed'],
  test: ['test_start', 'test_ok', 'test_failed'],
  push: ['push', 'push_done', 'push_failed'],
}
const MAX_SIGNALS = 8
const NEVER_FLAGS = ['--dry-run', '--version', '--help']

const IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u
function isAssign(t) {
  const eq = t.indexOf('=')
  return eq >= 0 && IDENTIFIER.test(t.slice(0, eq))
}

function isTag(ref) {
  if (ref.startsWith('refs/tags/')) return true
  const cps = Array.from(ref)
  return cps[0] === 'v' && cps.length > 1 && pyIsDigit(cps[1])
}

// The non-flag arguments, skipping the values of the flags that take one
function positionals(args, withValue = []) {
  const out = []
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (a === '--') return [...out, ...args.slice(i + 1)]
    if (a.startsWith('-') && a.length > 1) {
      i += withValue.includes(a) && !a.includes('=') ? 2 : 1
      continue
    }
    out.push(a)
    i++
  }
  return out
}

// `-x v`, `--name v`, `--name=v` or `-chdir=v`
function flagValue(args, names) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    for (const n of names) {
      if (a === n && i + 1 < args.length) return args[i + 1]
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1)
    }
  }
  return null
}

// A directory, package, release or image as a display name: its last
// path segment, without an image tag ("ghcr.io/me/api:1.2" -> "api");
// a config file stands for its directory (packages/api/tsconfig.json -> api)
function nameOf(value) {
  let parts = pyStrip(pyStr(or(value, ''))).replace(/[\\/]+$/, '').split(/[\\/]/)
  if (/\.(json|yaml|yml|toml)$/.test(parts.at(-1))) parts = parts.length > 1 ? parts.slice(0, -1) : ['']
  const last = parts.at(-1).split('@')[0].split(':')[0]
  return ['', '.', '..', '~', '-', '*'].includes(last) ? null : last
}

// npm-style script names: build, build:electron, typecheck, test:e2e, ...
function scriptKind(name) {
  for (const [kind, heads] of [['build', ['build', 'compile', 'typecheck', 'type-check', 'tsc']], ['test', ['test', 'tests', 'e2e', 'spec']]]) {
    for (const h of heads) {
      if (name === h || (name.startsWith(h) && ':-_.'.includes(name[h.length]))) return kind
    }
  }
  return null
}

const PM_VALUE_FLAGS = ['--prefix', '-w', '--workspace', '--filter', '-F', '-C', '--dir', '--cwd']

function packageManager(prog, args) {
  let pos = positionals(args, PM_VALUE_FLAGS)
  let target = nameOf(flagValue(args, ['--filter', '-F', '--workspace', '-w', '--prefix', '-C', '--dir', '--cwd']))
  if (pos[0] === 'workspace' && pos.length > 2) {
    target = nameOf(pos[1])
    pos = pos.slice(2)
  }
  if (!pos.length) return null
  if (pos[0] === 'publish' || (pos[0] === 'npm' && pos[1] === 'publish')) return ['deploy', target]
  let script
  if (pos[0] === 'run' || pos[0] === 'run-script') script = pos.length > 1 ? pos[1] : ''
  else if (prog === 'npm' && (pos[0] === 't' || pos[0] === 'tst')) script = 'test'
  else script = pos[0]
  const kind = scriptKind(script)
  return kind ? [kind, target] : null
}

function make(args) {
  const goals = positionals(args, ['-C', '--directory', '-f', '--file', '-j', '-l', '-I', '-o', '-W']).filter(a => !a.includes('='))
  const goal = goals.length ? goals[0] : ''
  const target = nameOf(flagValue(args, ['-C', '--directory']))
  if (['clean', 'distclean', 'mrproper', 'help', 'fmt', 'format', 'lint', 'deps', 'install-deps'].includes(goal)) return null
  if (['test', 'tests', 'check'].includes(goal)) return ['test', target]
  return [['deploy', 'release', 'publish'].includes(goal) ? 'deploy' : 'build', target]
}

function gradle(args) {
  const tasks = positionals(args, ['-p', '--project-dir', '-x']).map(t => t.split(':').at(-1))
  if (tasks.some(t => ['build', 'assemble', 'jar', 'bootJar', 'shadowJar', 'compileJava', 'compileKotlin'].includes(t))) return ['build', null]
  return tasks.some(t => ['test', 'check'].includes(t)) ? ['test', null] : null
}

function maven(args) {
  const phases = positionals(args, ['-pl', '-f', '-P', '-s'])
  const target = nameOf(flagValue(args, ['-pl']))
  if (phases.includes('deploy')) return ['deploy', target]
  if (phases.some(p => ['package', 'install', 'compile', 'verify'].includes(p))) return ['build', target]
  return phases.includes('test') ? ['test', target] : null
}

const KUBECTL = ['-n', '--namespace', '--context', '--kubeconfig', '-s', '--server', '--cluster', '--user', '-f', '--filename', '-l', '--selector']
const DOCKER = ['-t', '--tag', '-f', '--file', '-H', '--host', '--context', '--platform']
const CARGO = ['-p', '--package', '--manifest-path', '--target', '-j', '--features']
const VERCEL_OTHER = ['env', 'login', 'logout', 'dev', 'link', 'logs', 'ls', 'list', 'pull', 'whoami', 'domains', 'alias',
  'rm', 'remove', 'inspect', 'secrets', 'teams', 'projects', 'certs', 'dns', 'build', 'promote', 'rollback']

// [programs, the leading positionals that make it count ('*' = any word,
// [] = always), kind, flags that take a value, where the target is: flag
// names, or the index of a positional after the matched words, or null,
// words that veto it]. First row that matches wins.
const SIGNAL_RULES = [
  [['vercel'], [['deploy']], 'deploy', ['--scope', '-t', '--token', '-A', '--local-config'], null, []],
  [['netlify'], [['deploy']], 'deploy', ['--site', '-s', '--dir', '-d'], ['--site'], []],
  [['fly', 'flyctl'], [['deploy']], 'deploy', ['-a', '--app', '-c', '--config'], ['-a', '--app'], []],
  [['railway'], [['up']], 'deploy', ['-s', '--service', '-e', '--environment'], ['-s', '--service'], []],
  [['gcloud'], [['run', 'deploy'], ['functions', 'deploy']], 'deploy', ['--project', '--region', '--image', '--source'], 0, []],
  [['gcloud'], [['app', 'deploy']], 'deploy', ['--project'], null, []],
  [['aws'], [['deploy'], ['*', 'deploy']], 'deploy', ['--profile', '--region', '--output'], ['--stack-name'], []],
  [['sam', 'serverless', 'sls', 'cdk', 'firebase'], [['deploy']], 'deploy',
    ['--profile', '-c', '--context', '-a', '--app', '-P', '--project', '--only', '--stage', '-s'], ['--stack-name'], []],
  [['kubectl'], [['apply'], ['rollout', 'restart'], ['rollout', 'undo'], ['rollout', 'resume'], ['rollout', 'status']], 'deploy', KUBECTL, 0, []],
  [['helm'], [['upgrade'], ['install']], 'deploy', ['-n', '--namespace', '--kube-context', '-f', '--values', '--set', '--version', '--timeout'], 0, []],
  [['terraform', 'tofu'], [['apply']], 'deploy', [], ['-chdir'], []],
  [['pulumi'], [['up']], 'deploy', ['-s', '--stack', '-C', '--cwd'], ['-s', '--stack'], []],
  [['wrangler'], [['deploy'], ['publish'], ['pages', 'deploy']], 'deploy', ['-c', '--config', '-e', '--env', '--name', '--project-name'], ['--name', '--project-name'], []],
  [['gh'], [['release', 'create']], 'deploy', ['-R', '--repo'], null, []],
  [['docker', 'podman'], [['push'], ['image', 'push']], 'deploy', DOCKER, 0, []],
  [['docker', 'podman'], [['build'], ['buildx', 'build'], ['compose', 'build'], ['image', 'build'], ['builder', 'build']], 'build', DOCKER, ['-t', '--tag'], []],
  [['docker-compose'], [['build']], 'build', ['-f', '--file', '-p', '--project-name'], null, []],
  [['vite', 'next'], [['build']], 'build', [], null, []],
  [['cargo'], [['build'], ['b']], 'build', CARGO, ['-p', '--package'], []],
  [['cargo'], [['test'], ['t'], ['nextest']], 'test', CARGO, ['-p', '--package'], []],
  [['go', 'dotnet'], [['build'], ['publish']], 'build', [], null, []],
  [['go', 'dotnet', 'deno'], [['test']], 'test', [], null, []],
  [['playwright'], [['test']], 'test', ['-c', '--config', '--project'], null, []],
  [['tsc', 'vue-tsc'], [[]], 'build', [], ['-p', '--project'], ['--init', '-v', '--showConfig', '-w', '--watch']],
  [['webpack'], [[]], 'build', [], null, ['serve', 'init', 'info']],
  [['esbuild'], [[]], 'build', [], null, ['--serve']],
  [['vitest'], [[]], 'test', [], null, ['bench', 'init', 'list']],
  [['jest', 'mocha', 'pytest', 'py.test', 'rspec', 'phpunit'], [[]], 'test', [], null, []],
]

// One segment's program and arguments -> [kind, target] or null
function classifyProgram(prog, args) {
  const words = args.map(a => a.split('=')[0])
  if (words.some(w => NEVER_FLAGS.includes(w))) return null
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(prog)) return packageManager(prog, args)
  if (prog === 'make' || prog === 'gmake') return make(args)
  if (prog === 'gradle' || prog === 'gradlew') return gradle(args)
  if (prog === 'mvn' || prog === 'mvnw') return maven(args)
  if (prog.startsWith('python') && args[0] === '-m' && ['pytest', 'unittest', 'nose2'].includes(args[1])) return ['test', null]
  if (prog === 'heroku' && args.some(a => a === 'push' || a.endsWith(':push'))) return ['deploy', nameOf(flagValue(args, ['-a', '--app']))]
  if (prog === 'vercel' && (args.includes('--prod') || args.includes('--production'))) {
    const pos = positionals(args, ['--scope', '-t', '--token', '-A', '--local-config'])
    if (!pos.length || !VERCEL_OTHER.includes(pos[0])) return ['deploy', null]
  }
  for (const [progs, prefixes, kind, withValue, where, unless] of SIGNAL_RULES) {
    if (!progs.includes(prog)) continue
    const pos = positionals(args, withValue)
    for (const prefix of prefixes) {
      if (pos.length >= prefix.length && prefix.every((p, i) => p === '*' || p === pos[i])) {
        // A veto is a subcommand (webpack serve) or a flag (tsc --watch)
        if ((pos.length && unless.includes(pos[0])) || words.some(w => w.startsWith('-') && unless.includes(w))) return null
        let target
        if (typeof where === 'number') {
          const rest = pos.slice(prefix.length)
          target = rest.length > where ? nameOf(rest[where]) : null
        } else {
          target = where ? nameOf(flagValue(args, where)) : null
        }
        return [kind, target]
      }
    }
  }
  return null
}

// git push [flags] [remote [refspec...]] -> entries (a tag push is a deploy)
function gitPush(args) {
  const flags = new Set()
  const pos = []
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (['-o', '--push-option', '--repo', '--receive-pack', '--exec'].includes(a)) {
      i += 2
      continue
    }
    if (a.startsWith('-') && a.length > 1) flags.add(a.split('=')[0])
    else pos.push(a)
    i++
  }
  const anyFlag = names => names.some(f => flags.has(f))
  if (anyFlag(['-n', '--dry-run', '-d', '--delete', '--prune'])) return []
  if (pos.length && pos[0].startsWith('heroku')) return [{ kind: 'deploy' }]
  const dests = []
  for (let ref of pos.slice(1)) {
    ref = ref.replace(/^\++/, '').split(':').at(-1)
    ref = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    if (ref) dests.push(ref)
  }
  const tags = dests.filter(isTag)
  const branches = dests.filter(x => !isTag(x))
  const out = tags.length || anyFlag(['--tags', '--follow-tags']) ? [{ kind: 'deploy' }] : []
  if (!branches.length && (tags.length || flags.has('--tags'))) return out
  const entry = { kind: 'push' }
  const named = branches.filter(b => b !== 'HEAD')
  if (named.length && !anyFlag(['--all', '--mirror', '--branches'])) {
    entry.branch = named[0]
    entry.toDefault = named.some(b => DEFAULT_BRANCHES.includes(b))
  }
  return [...out, entry]
}

// [(segment, operator after it)]: split on && || ; | & and newlines
// outside quotes, backticks and $(...). 2>&1, &> and >&2 are
// redirections, not operators; a heredoc body is never read as commands.
function splitCommand(command) {
  let s = pyStr(or(command, ''))
  const h = s.indexOf('<<')
  if (h >= 0 && s.slice(h + 2, h + 3) !== '<') {
    const nl = s.indexOf('\n', h)
    if (nl >= 0) s = s.slice(0, nl)
  }
  const cps = Array.from(s)
  const n = cps.length
  const segs = []
  let buf = []
  let quote = null
  let depth = 0
  let i = 0
  const lastChar = () => (buf.length ? Array.from(buf.at(-1)).at(-1) : '')
  while (i < n) {
    const c = cps[i]
    const two = cps.slice(i, i + 2).join('')
    if (quote) {
      if (c === '\\' && quote === '"') {
        buf.push(two)
        i += 2
        continue
      }
      quote = c === quote ? null : quote
    } else if (c === '\\') {
      buf.push(two)
      i += 2
      continue
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c
    } else if (two === '$(') {
      depth++
      buf.push(two)
      i += 2
      continue
    } else if (depth) {
      depth += c === '(' ? 1 : c === ')' ? -1 : 0
    } else if (c === '#' && (!buf.length || WS_ONE.test(lastChar()))) {
      const nl = cps.indexOf('\n', i)
      i = nl < 0 ? n : nl
      continue
    } else if (two === '&&' || two === '||' || c === ';' || c === '\n' || c === '|'
      || (c === '&' && cps[i + 1] !== '>' && lastChar() !== '' && lastChar() !== '<' && lastChar() !== '>')) {
      const op = two === '&&' || two === '||' ? two : c === ';' || c === '\n' ? ';' : c
      segs.push([pyStrip(buf.join('')), op])
      buf = []
      i += two === '&&' || two === '||' || two === '|&' ? 2 : 1
      continue
    }
    buf.push(c)
    i++
  }
  segs.push([pyStrip(buf.join('')), null])
  return segs
}

const WRAPPERS = ['sudo', 'env', 'npx', 'pnpx', 'bunx', 'time', 'nohup', 'exec', 'command', 'builtin', 'nice', 'timeout', 'stdbuf']
const WRAPPER_PAIRS = [['uv', 'run'], ['poetry', 'run'], ['pipenv', 'run'], ['bundle', 'exec'], ['pnpm', 'exec'], ['pnpm', 'dlx'],
  ['yarn', 'dlx'], ['yarn', 'exec'], ['npm', 'exec'], ['hatch', 'run'], ['rye', 'run'], ['pdm', 'run']]
const WRAPPER_VALUES = ['-u', '-g', '-C', '-D', '-p', '-r', '-U', '--unset', '--chdir', '-S', '--package', '-c', '-n', '--adjustment', '-s', '--signal', '-k', '--kill-after']
const baseOf = t => t.slice(t.lastIndexOf('/') + 1)

// FOO=1 sudo -E npx --yes vitest run -> [vitest, run]
function stripWrappers(tokens) {
  let i = 0
  const n = tokens.length
  while (i < n) {
    const base = baseOf(tokens[i])
    if (isAssign(tokens[i])) {
      i++
    } else if (WRAPPERS.includes(base)) {
      i++
      while (i < n && (tokens[i].startsWith('-') || (base === 'env' && isAssign(tokens[i])))) i += WRAPPER_VALUES.includes(tokens[i]) ? 2 : 1
      i += base === 'timeout' ? 1 : 0 // its duration
    } else if (i + 1 < n && WRAPPER_PAIRS.some(([a, b]) => a === base && b === tokens[i + 1])) {
      i += 2
      while (i < n && tokens[i].startsWith('-')) i++
    } else {
      break
    }
  }
  return tokens.slice(i)
}

function tokenize(segment) {
  let tokens
  try {
    tokens = shlexSplit(segment)
  } catch {
    tokens = pySplit(segment)
  }
  // A subshell's parentheses, a group's braces and redirections are not arguments
  if (tokens.length) {
    tokens[0] = tokens[0].replace(/^[({!]+/, '')
    tokens[tokens.length - 1] = tokens.at(-1).replace(/[)}]+$/, '')
  }
  const out = []
  let skip = false
  for (const t of tokens) {
    const op = t.replace(/^[0-9]+/, '')
    if (skip || !t) {
      skip = false
      continue
    }
    if (['>', '>>', '<', '&>', '&>>'].includes(op)) skip = true
    else if (!(op.startsWith('>') || op.startsWith('<') || op.startsWith('&>'))) out.push(t)
  }
  return out
}

// os.path.normpath(os.path.join(here, os.path.expanduser(arg))): the posix
// rules, or the Windows ones when the working directory is a Windows path
function moveDir(here, arg) {
  if (arg === '~' || arg.startsWith('~/')) arg = homedir().replace(/[\\/]+$/, '') + arg.slice(1)
  const m = /^[A-Za-z]:[\\/]|^\\\\/.test(here) ? path.win32 : path.posix
  return m.normalize(m.isAbsolute(arg) ? arg : m.join(here, arg))
}

// Every meaningful segment, with what the outcome logic needs:
// {kind, target?, branch?, toDefault?, masked, dir, seg}. `stats`, when
// given, gets 'gates': how many segments of the WHOLE chain decide its
// exit status (unmasked), classified or not, so a failure is never
// pinned on a deploy when an unclassified `npm ci` before it could just
// as well have been the one that failed. A `cd` is not counted: it rarely
// fails, and `cd api && npm test` is the commonest chain there is.
function classifySegments(command, cwd = null, stats = null) {
  const out = []
  let here = typeof cwd === 'string' && cwd ? cwd : null
  let prev = null
  let gates = 0
  splitCommand(command).forEach(([text, op], seg) => {
    const masked = ['|', '||', ';', '&'].includes(op) || prev === '||'
    prev = op
    const tokens = text ? stripWrappers(tokenize(text)) : []
    if (!tokens.length) return
    const prog = baseOf(tokens[0])
    const args = tokens.slice(1)
    if ((prog === 'cd' || prog === 'pushd') && args.length && args[0] !== '-') {
      here = moveDir(here ?? '', args[0])
      return
    }
    if (!masked) {
      gates++
      if (stats) stats.gates = gates
    }
    if (prog === 'git') {
      const sub = positionals(args, ['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
      if (sub[0] === 'push') {
        const gdir = flagValue(args, ['-C'])
        const where = gdir ? moveDir(here ?? '', gdir) : here
        for (const entry of gitPush(args.slice(args.indexOf('push') + 1))) out.push({ ...entry, masked, dir: where, seg })
      }
      return
    }
    const hit = classifyProgram(prog, args)
    if (hit) {
      const entry = { kind: hit[0], masked, dir: here, seg }
      if (hit[1]) entry.target = cut(hit[1], 80)
      out.push(entry)
    }
  })
  return out
}

/**
 * The pure classifier: [{kind, target?, branch?, toDefault?}], one per
 * meaningful segment, without repeats. A target the command does not
 * name comes from the directory a `cd` in it moved to.
 */
export function classifyCommand(command, cwd = null) {
  const out = []
  for (const e of classifySegments(command, cwd)) {
    const entry = { kind: e.kind }
    const target = e.target || (e.dir && e.dir !== cwd ? nameOf(e.dir) : null)
    if (target) entry.target = target
    for (const k of ['branch', 'toDefault']) if (has(e, k)) entry[k] = e[k]
    const text = JSON.stringify(entry)
    if (!out.some(o => JSON.stringify(o) === text)) out.push(entry)
  }
  return out
}

const prints = (tables, kind, text) => has(tables, kind) && tables[kind].test(text)

// Output as text: the last 6000 characters, colour codes removed
function plain(text) {
  text = tail(pyStr(or(text, '')), 6000)
  return text.includes('\x1b') ? text.replace(signalTables.ansi, '') : text
}

// A masked run, judged by its output: 'fail', 'ok' or null (silent)
function judged(kind, text) {
  if (prints(signalTables.fail, kind, text)) return 'fail'
  return prints(signalTables.pass, kind, text) ? 'ok' : null
}

const ERROR_WORDS = ['error', 'fail', 'fatal', 'denied', 'not found', 'no such', 'cannot', 'could not', 'unable', 'refused', 'rejected', 'exception', 'panic', 'timed out']
// str.splitlines() splits on more than \n
const LINE_BREAKS = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u{2028}\u{2029}]/u

function firstMeaningful(text) {
  const lines = text.split(LINE_BREAKS).map(pyStrip).filter(l => Array.from(l).some(pyIsAlnum))
  for (const l of lines) {
    const low = l.toLowerCase()
    if (ERROR_WORDS.some(w => low.includes(w))) return l
  }
  return lines.length ? lines[0] : ''
}

const countOf = (text, sub) => text.split(sub).length - 1

// "3 failing" for a test run, "2 errors" for a build, when the output says
function failureDetail(kind, text, oneLine) {
  if (kind === 'test') {
    for (const re of signalTables.detailTest) {
      const m = re.exec(text)
      if (m) return `${m[1]} failing`
    }
    const go = countOf(text, '\n--- FAIL') + (text.startsWith('--- FAIL') ? 1 : 0)
    if (go) return `${go} failing`
    const m = signalTables.detailFail.exec(text)
    return m ? oneLine(m[1], 80) : null
  }
  if (kind === 'build') {
    const found = signalTables.detailFound.exec(text)
    const n = found ? pyInt(found[1]) : countOf(text, 'error TS')
    return n ? `${n} error${n === 1 ? '' : 's'}` : null
  }
  return null
}

// The branch checked out where a bare `git push` runs: .git/HEAD of the
// nearest repository (a worktree's .git file points at its own HEAD).
// A few stats and one small read; null when it cannot be known.
function currentBranch(start) {
  let here = typeof start === 'string' && path.isAbsolute(start) ? start : null
  const isFile = p => { try { return statSync(p).isFile() } catch { return false } }
  const isDir = p => { try { return statSync(p).isDirectory() } catch { return false } }
  const join = (a, b) => (path.isAbsolute(b) ? b : path.join(a, b))
  while (here) {
    let dotgit = path.join(here, '.git')
    let ref
    try {
      if (isFile(dotgit)) {
        const line = pyStrip(cut(readFileSync(dotgit, 'utf8'), 512))
        if (!line.startsWith('gitdir:')) return null
        dotgit = join(here, pyStrip(line.slice('gitdir:'.length)))
      } else if (!isDir(dotgit)) {
        const parent = path.dirname(here)
        here = parent !== here ? parent : null
        continue
      }
      ref = pyStrip(cut(readFileSync(path.join(dotgit, 'HEAD'), 'utf8'), 256))
    } catch {
      return null
    }
    return ref.startsWith('ref: refs/heads/') ? ref.slice('ref: refs/heads/'.length) : null
  }
  return null
}

// This Bash call's signals for the current hook phase
function bashSignals(d, hookEvent, SESSION, clamp, oneLine) {
  const rawInp = pget(d, 'tool_input')
  const inp = isDict(rawInp) ? rawInp : {}
  const command = pget(inp, 'command')
  const phase = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].indexOf(hookEvent)
  const rawCwd = pget(d, 'cwd')
  const cwd = typeof rawCwd === 'string' ? rawCwd : null
  const chain = { gates: 0 }
  const segs = classifySegments(command, cwd, chain)
  if (!segs.length || (phase === 1 && truthy(pget(inp, 'run_in_background')))) return [] // a backgrounded command is still running: no outcome yet
  let error = null
  let exitCode = null
  let text = ''
  let interrupted = false
  let outcomes
  if (phase === 0) {
    outcomes = segs.map(() => 'start')
  } else if (phase === 1) {
    const resp = pget(d, 'tool_response')
    interrupted = isDict(resp) && pget(resp, 'interrupted') === true
    text = plain(isDict(resp) ? ['stdout', 'stderr'].map(k => pyStr(or(pget(resp, k), ''))).join('\n') : resp)
    outcomes = segs.map(s => (interrupted ? 'fail' : !s.masked ? 'ok' : judged(s.kind, text)))
  } else {
    let err = pyStr(or(pget(d, 'error'), ''))
    interrupted = pget(d, 'is_interrupt') === true
    const nl = err.indexOf('\n')
    const head = nl < 0 ? err : err.slice(0, nl)
    const rest = nl < 0 ? '' : err.slice(nl + 1)
    if (head.startsWith('Exit code ') && pyIsDigitStr(pyStrip(head.slice(10)))) {
      exitCode = pyInt(pyStrip(head.slice(10)))
      err = rest
    }
    text = plain(err)
    error = firstMeaningful(text) || (exitCode !== null ? `exit code ${exitCode}` : '')
    // A lone segment that decides the exit status is the culprit; only a
    // chain needs the output to say which of its segments failed. With no
    // pointer in the output, the first classified gate is blamed only
    // when every gate of the chain is classified: `npm ci && vercel
    // deploy` failing on npm says nothing about the deploy, which never ran
    const alone = segs.length === 1 && !segs[0].masked && chain.gates === 1
    const pointed = alone ? [] : segs.flatMap((s, i) => (prints(signalTables.fail, s.kind, text) ? [i] : []))
    const gates = segs.flatMap((s, i) => (!s.masked ? [i] : []))
    const allKnown = chain.gates === new Set(gates.map(i => segs[i].seg)).size
    const blamed = (pointed.length ? pointed : allKnown && gates.length ? gates : [null])[0]
    outcomes = segs.map((s, i) => (interrupted || i === blamed || (s.masked && pointed.includes(i)) ? 'fail' : null))
  }
  const out = []
  segs.forEach((s, idx) => {
    const outcome = outcomes[idx]
    if (outcome === null) return
    const sig = { kind: SIGNAL_NAMES[s.kind][['start', 'ok', 'fail'].indexOf(outcome)] }
    const target = s.target || nameOf(s.dir) || SESSION.project
    if (target) sig.target = cut(target, 80)
    if (s.kind === 'push') {
      const branch = has(s, 'branch') ? s.branch : currentBranch(s.dir)
      if (branch) {
        sig.branch = cut(branch, 120)
        sig.toDefault = has(s, 'toDefault') ? s.toDefault : DEFAULT_BRANCHES.includes(branch)
      }
    }
    sig.command = clamp(command, 160)
    if (outcome === 'fail') {
      if (interrupted) sig.interrupted = true
      if (error) sig.error = clamp(error, 200)
      if (exitCode !== null) sig.exitCode = exitCode
      const detail = failureDetail(s.kind, text, oneLine)
      if (detail) sig.detail = clamp(detail, 120)
    }
    if (!out.some(o => o.kind === sig.kind && o.target === sig.target && o.branch === sig.branch)) out.push(sig)
  })
  return out.slice(0, MAX_SIGNALS)
}

// ── The office conversation (the bash wrapper) ──────────────────────────────

/** The hook output for a decision word, built here and nowhere else. */
function permissionOutput(decision, suggestions) {
  let dec
  if (decision === 'allow') dec = { behavior: 'allow' }
  else if (decision === 'allow-remember') {
    // Echo only the dialog's OWN permission_suggestions, never anything the
    // server made up, and never an updatedInput.
    dec = { behavior: 'allow', updatedPermissions: suggestions }
  } else dec = { behavior: 'deny', message: 'Denied from Claude Office', interrupt: false }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: dec } })
}

const parseReply = text => {
  try {
    const r = JSON.parse(text || '{}')
    return isDict(r) ? r : {}
  } catch {
    return {}
  }
}
const okReply = r => r !== null && r.status < 400 // curl -f

/**
 * PermissionRequest the office may answer: POST in the foreground, then poll
 * the pending permission until it is decided here (return the hook output we
 * build from the decision word), answered in the terminal, expired or gone
 * (return null). Any failure to reach the server ends the wait at once,
 * silently. The nonce and the dialog's own suggestions are lifted out of the
 * event so the proof can be verified and allow-remember echoed back.
 */
async function answerFromOffice(event, url, token, now = Date.now) {
  const base = url.endsWith('/event') ? url.slice(0, -'/event'.length) : url
  const body = JSON.stringify(event)
  const nonce = pyStr(event.nonce ?? '')
  const suggestions = event.suggestions ?? []
  let reply = await send(url, { method: 'POST', body, headers: signHeaders(token, 'POST', url, body), timeoutMs: 2000 })
  if (!okReply(reply)) return null
  const created = parseReply(reply.body)
  const wait = isDict(created.wait) ? created.wait : {}
  const id = created.permissionId
  if (typeof id !== 'string' || !id) return null
  const pollMs = pyInt(or(wait.pollMs, 20000))
  pyInt(or(wait.deadline, 0))
  const waitS = Math.min(30, Math.max(1, Math.trunc(pollMs / 1000)))
  // Each poll is bounded; the server ends the wait at the deadline it set
  // (extended when the session turns out to be interactive), and the loop cap
  // is a backstop under the hook's 600 s timeout
  for (let polls = 0; polls < 40; polls++) {
    const pollUrl = `${base}/permission/${encodeURIComponent(id)}?wait=${waitS}`
    reply = await send(pollUrl, { headers: signHeaders(token, 'GET', pollUrl, ''), timeoutMs: (waitS + 5) * 1000 })
    if (!okReply(reply)) return null
    const r = parseReply(reply.body)
    const status = typeof r.status === 'string' ? r.status : ''
    const deadline = r.deadline
    const late = (typeof deadline === 'number' || typeof deadline === 'boolean') && now() > deadline + 2000
    if (status === 'allowed' || status === 'denied') {
      const decision = typeof r.decision === 'string' ? r.decision : ''
      const proof = typeof r.proof === 'string' ? r.proof : ''
      if (!token || !nonce || !['allow', 'allow-remember', 'deny'].includes(decision)) return null
      // Constant-time check that the answer came from a holder of the token.
      // A squatter cannot produce this, so its answer prints nothing and the
      // terminal dialog stays in charge.
      const expected = Buffer.from(createHmac('sha256', token).update(nonce + id + decision).digest('hex'))
      const given = Buffer.from(proof)
      return given.length === expected.length && timingSafeEqual(expected, given) ? permissionOutput(decision, suggestions) : null
    }
    if (status === 'pending' && !late) continue
    return null
  }
  return null
}

const writeOut = text => new Promise(resolve => process.stdout.write(text, () => resolve()))

async function main() {
  try {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    // Strict UTF-8, BOM kept: bytes that are not text give "nothing to say", as sys.stdin.read() raising did
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))
    const built = buildEvent(text)
    if (!built) return
    const env = process.env
    // The token never leaves this process: each request is SIGNED with it
    const token = readToken(env)
    const url = officeUrl('/event', env.AGENT_OFFICE_EVENT_URL, env)
    if (built.wait) {
      const out = await answerFromOffice(built.event, url, token)
      if (out) await writeOut(`${out}\n`)
      return
    }
    const body = JSON.stringify(built.event)
    await send(url, { method: 'POST', body, headers: signHeaders(token, 'POST', url, body), timeoutMs: 1000 })
  } catch {
    // a hook never fails the tool call it watches
  }
}

function isMain() {
  try {
    if (!process.argv[1]) return false
    const self = realpathSync(fileURLToPath(import.meta.url))
    const arg = realpathSync(path.resolve(process.argv[1]))
    return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg
  } catch {
    return false
  }
}

if (isMain()) {
  // a hook never fails the tool call it watches: whatever goes wrong, exit 0 and say nothing
  process.stdout.on('error', () => {})
  process.on('uncaughtException', () => process.exit(0))
  process.on('unhandledRejection', () => process.exit(0))
  main().finally(() => { process.exitCode = 0 })
}
