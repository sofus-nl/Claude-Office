/**
 * chat-ai-watcher.mjs — Watches office chat and replies as Claude.
 * Started by start-office, stopped by stop-office.
 *
 * Only messages a person typed into the office chat are answered. The server
 * stores those with role 'default', is_system 0 and no recipient; the
 * watcher's own replies and the server's "starting: / done:" announcements
 * carry an agent role, and agent-to-agent messages carry a recipient, so none
 * of them can trigger another `claude -p` call.
 *
 * Environment (all optional):
 *   AGENT_OFFICE_HOME            state dir            (default ~/.agent-office)
 *   AGENT_OFFICE_PORT            office server port   (default 3334)
 *   CHAT_AI_POLL_INTERVAL        seconds between polls (default 8)
 *   CHAT_AI_MODEL                model for `claude -p` (default claude-haiku-5-5)
 *   CHAT_AI_TIMEOUT              seconds before a `claude -p` call is killed (default 60)
 *   CHAT_AI_MAX_REPLIES_PER_MIN  backstop against reply loops (default 5)
 *   CHAT_AI_CLAUDE               path of the claude binary (a .mjs/.js runs under node)
 */

import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { officeHome, officeUrl, readToken, send } from '../hooks/office-client.mjs'
import { gatherContext } from './gather-context.mjs'

const WIN = process.platform === 'win32'
const POLL_INTERVAL_MS = Number(process.env.CHAT_AI_POLL_INTERVAL || 8) * 1000
const MODEL = process.env.CHAT_AI_MODEL || 'claude-haiku-5-5'
const CLAUDE_TIMEOUT_MS = Number(process.env.CHAT_AI_TIMEOUT || 60) * 1000
const MAX_REPLIES_PER_MIN = Number(process.env.CHAT_AI_MAX_REPLIES_PER_MIN || 5)

const STATE_DIR = officeHome()
const PID_FILE = join(STATE_DIR, 'chat-watcher.pid')
const LAST_TS_FILE = join(STATE_DIR, 'chat-ai-last-ts')
const LOCK_FILE = join(STATE_DIR, 'chat-ai.lock')

// Flags for every `claude -p` call (the prompt goes on stdin, never argv):
//   --safe-mode           no hooks, CLAUDE.md, MCP servers, skills or plugins —
//                         the office's own agent-tracker hook must not fire for
//                         each reply, and no project MCP server should start.
//                         (--bare also skips hooks but only accepts an API key,
//                         not the OAuth login most people use.)
//   --strict-mcp-config   belt and braces: ignore every MCP config not given
//                         on the command line (and none is).
//   --tools ""            nothing to call, so --max-turns 1 always ends in text.
//   --no-session-persistence  do not litter ~/.claude with one-shot sessions.
//   --name agent-office-bot   every `claude -p` registers in Claude Code's
//                         session registry (~/.claude/sessions) for as long as
//                         it runs, and the office reads that registry to show
//                         sessions that have no hooks (server/sessions.js). The
//                         name marks these calls as the office's own so they
//                         never flicker through the session strip; keep it in
//                         step with BOT_SESSION_NAME there.
const CLAUDE_ARGS = ['-p', '--max-turns', '1', '--model', MODEL, '--safe-mode', '--strict-mcp-config', '--tools', '', '--no-session-persistence', '--name', 'agent-office-bot']

// stdout may be a pipe the parent closed; a lost log line must not crash us
const log = line => { try { writeSync(1, line + '\n') } catch {} }
const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * The claude command to spawn as { cmd, args }, or null. Never a .cmd: it
 * cannot be spawned without a shell (EINVAL), and chat text must not meet one.
 */
function findClaude() {
  const override = process.env.CHAT_AI_CLAUDE
  if (override) return /\.(mjs|cjs|js)$/i.test(override) ? { cmd: process.execPath, args: [override] } : { cmd: override, args: [] }
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean)
  const isBinary = file => {
    try {
      if (!statSync(file).isFile()) return false
      if (!WIN) accessSync(file, constants.X_OK)
      return true
    } catch { return false }
  }
  for (const dir of dirs) {
    for (const name of WIN ? ['claude.exe', 'claude.com'] : ['claude']) {
      if (isBinary(join(dir, name))) return { cmd: join(dir, name), args: [] }
    }
  }
  if (WIN) {
    // An npm global install leaves claude.cmd; the native binary sits beside it
    for (const dir of dirs) {
      if (!existsSync(join(dir, 'claude.cmd'))) continue
      const exe = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
      if (isBinary(exe)) return { cmd: exe, args: [] }
    }
  }
  return null
}

let running = null // the in-flight `claude -p`, if any

// The whole tree on Windows. On POSIX the child alone: it shares the watcher's
// process group, so a group kill of the watcher (stop-office) takes it too.
function killClaude(child) {
  if (!child || child.exitCode !== null || child.pid === undefined) return
  if (WIN) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else child.kill('SIGTERM')
}

// The watermark: the newest chat row (ms epoch) the watcher has seen. It is
// replaced through a temp file and a rename, so a crash mid-write cannot
// leave it empty.
function saveLastTs() {
  writeFileSync(`${LAST_TS_FILE}.tmp`, `${lastTs}\n`)
  renameSync(`${LAST_TS_FILE}.tmp`, LAST_TS_FILE)
}

mkdirSync(STATE_DIR, { recursive: true })
writeFileSync(PID_FILE, `${process.pid}\n`)
// A lock left behind by a crashed or killed watcher must not block this one
rmSync(LOCK_FILE, { force: true })

// Initialise it from the file, or to now. Anything in the file that is not a
// plain timestamp up to now — empty, junk, a time in the future — starts from
// now too: GET /chat?since= with a value it cannot parse returns every recent
// row, so the same message would be answered on every poll, and a future one
// would never let a message through.
const nowMs = Math.floor(Date.now() / 1000) * 1000
let lastTs = ''
try { lastTs = readFileSync(LAST_TS_FILE, 'utf8').replace(/\s/g, '') } catch {}
if (!/^\d+$/.test(lastTs) || lastTs.length > 15 || Number(lastTs) > nowMs) {
  if (existsSync(LAST_TS_FILE)) log(`[chat-ai] ${LAST_TS_FILE} did not hold a timestamp — starting from now`)
  lastTs = nowMs
  saveLastTs()
}
lastTs = Number(lastTs)

log(`[chat-ai] Started (pid ${process.pid}), polling ${officeUrl('')} every ${POLL_INTERVAL_MS / 1000}s, model ${MODEL}`)
if (!findClaude()) log("[chat-ai] Warning: 'claude' CLI not found — messages will be seen but not answered")

process.on('exit', () => {
  killClaude(running)
  for (const f of [PID_FILE, LOCK_FILE, `${LAST_TS_FILE}.tmp`]) rmSync(f, { force: true })
  log('[chat-ai] Stopped')
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0))

// --- helpers -----------------------------------------------------------------

// Reply-rate backstop: ms epochs of the `claude -p` calls made in the last
// minute, so a misclassified message can never burn tokens indefinitely.
let callTimes = []
function rateCapHit() {
  const now = Date.now()
  callTimes = callTimes.filter(t => now - t < 60_000)
  return callTimes.length >= MAX_REPLIES_PER_MIN
}

// Keyword routing: which office persona answers.
const ROUTES = [
  [['bug', 'error', 'crash', 'fix', 'broken', 'debug', 'exception', 'traceback', 'stack trace', 'segfault'], 'debugger', 'Debugger'],
  [['review', 'pr', 'merge', 'approve', 'lgtm', 'pull request', 'code review', 'diff'], 'code-reviewer', 'Reviewer'],
  [['css', 'ui', 'ux', 'component', 'design', 'frontend', 'style', 'layout', 'responsive', 'tailwind', 'animation', 'pixel', 'theme', 'dark mode', 'light mode', 'color', 'font', 'spacing', 'padding', 'margin'], 'frontend-developer', 'Frontend'],
  [['test', 'coverage', 'spec', 'jest', 'pytest', 'unit test', 'e2e', 'playwright', 'cypress', 'assertion', 'mock'], 'test-engineer', 'Tester'],
  [['security', 'auth', 'vuln', 'xss', 'injection', 'csrf', 'cors', 'token', 'jwt', 'oauth', 'password', 'encrypt', 'ssl', 'tls', 'certificate'], 'security-auditor', 'Security'],
  [['deploy', 'ci', 'pipeline', 'docker', 'devops', 'kubernetes', 'k8s', 'terraform', 'aws', 'gcp', 'azure', 'vercel', 'netlify', 'heroku', 'nginx', 'cdn', 'dns', 'domain', 'ssl cert'], 'devops-engineer', 'DevOps'],
  [['perf', 'slow', 'optimize', 'speed', 'latency', 'bundle', 'lighthouse', 'core web vitals', 'memory leak', 'cache', 'lazy load', 'render', 'fps', 'bottleneck'], 'performance-engineer', 'PerfEng'],
  [['db', 'query', 'schema', 'migration', 'sql', 'postgres', 'mysql', 'mongo', 'redis', 'index', 'join', 'table', 'row', 'column', 'orm', 'prisma', 'drizzle', 'supabase', 'neon'], 'database-architect', 'DBA'],
  [['typescript', 'type', 'interface', 'generic', 'enum', 'union', 'infer', 'zod', 'validation', 'schema'], 'typescript-pro', 'TS Pro'],
  [['ai', 'llm', 'prompt', 'model', 'openai', 'anthropic', 'embedding', 'vector', 'rag', 'agent', 'token', 'context window'], 'ai-engineer', 'AI Eng'],
  [['api', 'endpoint', 'rest', 'graphql', 'webhook', 'route', 'middleware', 'request', 'response', 'http', 'fetch', 'axios', 'cors'], 'fullstack-developer', 'Fullstack'],
  [['git', 'branch', 'commit', 'rebase', 'cherry-pick', 'stash', 'conflict', 'remote', 'origin'], 'code-reviewer', 'Reviewer'],
  [['refactor', 'clean', 'abstract', 'pattern', 'solid', 'dry', 'yagni', 'architecture', 'module', 'package', 'monorepo'], 'architect-reviewer', 'Architect'],
]
function routeMessage(aMessage) {
  const msg = aMessage.toLowerCase()
  const hit = ROUTES.find(([keywords]) => keywords.some(w => msg.includes(w)))
  return hit ? { role: hit[1], name: hit[2] } : { role: 'assistant', name: 'Claude' }
}

/** GET an office endpoint and parse its JSON; null on any failure (curl -sf semantics). */
async function getJson(aEndpoint) {
  const res = await send(officeUrl(aEndpoint), { timeoutMs: 5000 })
  if (!res || res.status >= 400) return null
  try { return JSON.parse(res.body) } catch { return null }
}

/**
 * One `claude -p` call: the prompt on stdin, killed after CHAT_AI_TIMEOUT.
 * Resolves { out, err } and never rejects.
 */
function runClaude(aPrompt) {
  return new Promise(resolve => {
    const claude = findClaude()
    if (!claude) return resolve({ out: '', err: "'claude' CLI not found" })
    let out = ''
    let err = ''
    let done = false
    // No shell: the argv is fixed and the chat text only ever travels on stdin
    const child = spawn(claude.cmd, [...claude.args, ...CLAUDE_ARGS], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    running = child
    const timer = setTimeout(() => killClaude(child), CLAUDE_TIMEOUT_MS)
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      running = null
      resolve({ out, err })
    }
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.stdin.on('error', () => {})
    child.on('error', e => { err += e.message; finish() })
    child.on('close', finish)
    child.stdin.end(aPrompt)
  })
}

// Generate and post one reply. Returns false when nothing was posted; the
// caller (replyToMessage) clears the lock either way.
async function doReply(aMsg) {
  const { role, name } = routeMessage(aMsg)
  log(`[chat-ai] Routed to: ${name} (${role})`)

  const devContext = (await gatherContext().catch(() => '')).replace(/\n+$/, '')

  let persona = ''
  try { persona = readFileSync(join(STATE_DIR, 'claude-persona.md'), 'utf8').replace(/\n+$/, '') } catch {}

  // Last 10 messages for context
  const messages = (await getJson('/chat'))?.messages
  const context = Array.isArray(messages) ? messages.slice(-10).map(m => `${m.sender ?? '?'}: ${m.text ?? ''}`).join('\n') : ''

  const prompt = `${persona}

You are responding as ${name}, the office ${role}. Stay in character.

${devContext}

Recent conversation:
${context}

Reply to the latest message naturally. Keep it short (8-12 words). Continue the conversation — reference previous messages if relevant.`

  log('[chat-ai] Generating reply...')
  callTimes.push(Date.now())
  const { out, err } = await runClaude(prompt)
  const raw = out.replace(/\n/g, ' ').trim()

  if (!raw) {
    log('[chat-ai] Empty reply from claude — nothing posted')
    for (const line of err.split(/\r?\n/).filter(Boolean)) log(`[chat-ai]   claude: ${line}`)
    return false
  }

  // Truncate to 15 words max
  const reply = raw.split(/\s+/).slice(0, 15).join(' ')
  log(`[chat-ai] Replying as ${name}: ${reply}`)

  // Post the reply with its agent role and name. /chat/reply speaks as an
  // agent, so it carries the office token (the file the server writes once it
  // is up — the same one the hook reads).
  //
  // The watermark is not moved past the reply: it stays at the newest row
  // seen before generating, so a message typed while `claude -p` was
  // thinking is still ahead of it and is answered on the next poll. The
  // reply itself comes back on that poll too, but it carries an agent role,
  // which typedByAPerson never answers, and the poll moves the watermark
  // past it.
  const token = readToken()
  const res = await send(officeUrl('/chat/reply'), {
    method: 'POST',
    body: JSON.stringify({ sender: name, role, text: reply }),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    timeoutMs: 5000,
  })
  if (!res || res.status >= 400) {
    log(`[chat-ai] Failed to post reply — ${res ? `HTTP ${res.status}` : 'no answer from the office'}`)
    return false
  }

  log('[chat-ai] Done')
  return true
}

// Hold the lock only while a reply is being generated; it is dropped on every
// exit path (and by the exit handler), so an empty or failed reply can never
// wedge the watcher.
async function replyToMessage(aMsg) {
  writeFileSync(LOCK_FILE, '')
  try {
    return await doReply(aMsg)
  } finally {
    rmSync(LOCK_FILE, { force: true })
  }
}

function typedByAPerson(m) {
  return (m.role ?? 'default') === 'default'
    && !m.is_system
    && !m.recipient
    && typeof m.text === 'string'
    && m.text.trim() !== ''
    && !m.text.trimStart().startsWith('/')
}

// --- poll loop ---------------------------------------------------------------

for (;;) {
  await sleep(POLL_INTERVAL_MS)
  try {
    // Check server
    const health = await send(officeUrl('/health'), { timeoutMs: 5000 })
    if (!health || health.status >= 400) continue

    // Check AI toggle (unreadable counts as paused)
    const cron = await getJson('/chat/cron-state')
    if (!cron || cron.paused) continue

    // Fetch messages since last seen
    const fetched = (await getJson(`/chat?since=${lastTs}`))?.messages
    const msgs = Array.isArray(fetched) ? fetched : []
    const human = msgs.filter(typedByAPerson)
    const newTs = Math.max(0, ...msgs.map(m => Math.trunc(Number(m.timestamp)) || 0))
    // The latest message a person typed, newlines flattened
    const result = human.length ? human.at(-1).text.replace(/[\r\n]/g, ' ') : ''

    // Advance past everything seen this poll — replies and announcements too
    if (newTs > lastTs) {
      lastTs = newTs
      saveLastTs()
    }

    // Skip if no new message from a person
    if (!result) continue

    // Skip if already generating a reply (prevent concurrent claude -p)
    if (existsSync(LOCK_FILE)) {
      log('[chat-ai] Skipping — already generating a reply')
      continue
    }

    if (rateCapHit()) {
      log(`[chat-ai] Reply cap reached (${MAX_REPLIES_PER_MIN} per minute) — not answering: ${result}`)
      continue
    }

    if (!findClaude()) {
      log(`[chat-ai] 'claude' CLI not found — not answering: ${result}`)
      continue
    }

    log(`[chat-ai] New message: ${result}`)
    await replyToMessage(result)
  } catch (e) {
    log(`[chat-ai] Poll failed — ${e.message}`)
  }
}
