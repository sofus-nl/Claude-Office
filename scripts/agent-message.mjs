#!/usr/bin/env node
/**
 * Agent-to-agent messaging through the office.
 *
 * Send a directed message:
 *     node agent-message.mjs --from Reviewer --role code-reviewer --to Debugger \
 *         [--type question|review_request|task_handoff] [--reply-to <id>] 'can you look at auth.ts?'
 *
 * Read messages addressed to you (clears your unread badge unless --peek):
 *     node agent-message.mjs --inbox Debugger [--since <timestamp_ms>] [--peek]
 *
 * See who is in the office:
 *     node agent-message.mjs --who
 */

import { STATUS_CODES } from 'node:http'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { officeHome, officeUrl, readToken, send } from '../hooks/office-client.mjs'

const PORT = process.env.AGENT_OFFICE_PORT || '3334'
const TYPES = ['message', 'question', 'review_request', 'task_handoff']
const USAGE = `usage: agent-message.mjs [-h] [--from SENDER] [--role ROLE] [--to RECIPIENT]
                        [--type {${TYPES.join(',')}}]
                        [--reply-to REPLY_TO] [--inbox NAME] [--since SINCE]
                        [--peek] [--who]
                        [text]`
const HELP = `${USAGE}

Message other agents in the office

positional arguments:
  text

options:
  -h, --help            show this help message and exit
  --from SENDER
  --role ROLE
  --to RECIPIENT
  --type {${TYPES.join(',')}}
  --reply-to REPLY_TO
  --inbox NAME          list messages sent to NAME
  --since SINCE
  --peek                read the inbox without marking it read
  --who                 list agents in the office`

/** A user-facing failure: the message goes to stderr, the process exits with `code`. */
class Fail extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}

// The office token, written by the server once it is up — the same file the
// hook reads. Every call that speaks as an agent (/chat/reply, /chat/inbox/read)
// needs it; reads (/agents, /chat) do not.
const tokenFile = () => join(officeHome(), 'auth-token')

async function call(path, body) {
  const token = readToken()
  const res = await send(officeUrl(path), {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? '' : JSON.stringify(body),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    timeoutMs: 3000,
  })
  if (!res) throw new Fail(`office server is not running on port ${PORT}`)
  if (res.status >= 400) {
    let err
    try { err = JSON.parse(res.body).error } catch {}
    err ??= STATUS_CODES[res.status] ?? ''
    if (res.status === 401) err = `${err} — the office token at ${tokenFile()} is missing or stale (is the server running?)`
    throw new Fail(`office refused: ${err}`)
  }
  return JSON.parse(res.body)
}

/** argparse-style parsing: usage errors exit 2, like the Python version. */
function parse(argv) {
  const bad = msg => new Fail(`${USAGE}\nagent-message.mjs: error: ${msg}`, 2)
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        from: { type: 'string', default: 'Claude' },
        role: { type: 'string', default: 'default' },
        to: { type: 'string' },
        type: { type: 'string', default: 'message' },
        'reply-to': { type: 'string' },
        inbox: { type: 'string' },
        since: { type: 'string', default: '0' },
        peek: { type: 'boolean' },
        who: { type: 'boolean' },
      },
    })
  } catch (e) {
    throw bad(e.message)
  }
  const { values, positionals } = parsed
  if (values.help) return { help: true }
  if (!TYPES.includes(values.type)) throw bad(`argument --type: invalid choice: '${values.type}' (choose from ${TYPES.map(t => `'${t}'`).join(', ')})`)
  for (const k of ['reply-to', 'since']) {
    if (values[k] !== undefined && !/^[-+]?\d+$/.test(values[k])) throw bad(`argument --${k}: invalid int value: '${values[k]}'`)
  }
  if (positionals.length > 1) throw bad(`unrecognized arguments: ${positionals.slice(1).join(' ')}`)
  return { ...values, text: positionals[0], since: Number(values.since), replyTo: Number(values['reply-to'] ?? 0) }
}

async function main() {
  const args = parse(process.argv.slice(2))
  if (args.help) {
    console.log(HELP)
    return
  }

  if (args.who) {
    for (const a of (await call('/agents')).agents) {
      const unread = a.unread ? `✉ ${a.unread}` : ''
      console.log(`${a.name.padEnd(12)} ${a.role.padEnd(22)} ${a.state.padEnd(10)} ${unread.padEnd(5)} ${a.task || ''}`)
    }
  } else if (args.inbox) {
    const q = new URLSearchParams({ recipient: args.inbox, since: args.since })
    for (const m of (await call(`/chat?${q}`)).messages) {
      const kind = m.msg_type || 'message'
      const reply = m.thread_id ? ` (re #${m.thread_id})` : ''
      console.log(`#${m.id} [${kind}] ${m.sender}${reply}: ${m.text}`)
    }
    if (!args.peek) await call('/chat/inbox/read', { recipient: args.inbox })
  } else if (args.to && args.text) {
    const body = { sender: args.from, role: args.role, recipient: args.to, type: args.type, text: args.text }
    if (args.replyTo) body.replyTo = args.replyTo
    const r = await call('/chat/reply', body)
    const where = r.delivered ? 'delivered' : 'queued (recipient not in the office)'
    console.log(`#${r.id} -> ${args.to}: ${where}`)
  } else {
    console.log(HELP)
    process.exitCode = 1
  }
}

try {
  await main()
} catch (e) {
  if (!(e instanceof Fail)) throw e
  console.error(e.message)
  process.exitCode = e.code
}
