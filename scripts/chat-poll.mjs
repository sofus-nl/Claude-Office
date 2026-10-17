#!/usr/bin/env node
/** Chat poll helper — called by cron, no interactive prompts needed. */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { officeHome, officeUrl, send } from '../hooks/office-client.mjs'

const statePath = join(officeHome(), 'chat-poll-state')

let state
try {
  state = JSON.parse(readFileSync(statePath, 'utf8'))
} catch {
  state = { last_seen_timestamp: 0, consecutive_idle_count: 0, paused: false }
}

if (state.paused) process.exit(0)

let msgs
const res = await send(officeUrl('/chat'), { timeoutMs: 5000 })
try {
  if (!res || res.status >= 400) throw new Error('office not answering')
  msgs = JSON.parse(res.body).messages
  if (!Array.isArray(msgs)) throw new Error('no messages')
} catch {
  process.exit(0)
}

const lastTs = state.last_seen_timestamp ?? 0
// Only messages a person typed: role 'default', not system, not directed at an
// agent, not a slash command (replies and announcements carry an agent role)
const newMsgs = msgs.filter(m => m.timestamp > lastTs
  && (m.role === undefined ? 'default' : m.role) === 'default' && !m.is_system
  && !m.recipient && !String(m.text ?? '').trimStart().startsWith('/'))

if (newMsgs.length) {
  for (const m of newMsgs) console.log(`NEW: ${m.sender}: ${m.text}`)
  state.last_seen_timestamp = Math.max(...newMsgs.map(m => m.timestamp))
  state.consecutive_idle_count = 0
} else {
  state.consecutive_idle_count = (state.consecutive_idle_count ?? 0) + 1
  const idle = state.consecutive_idle_count
  if (idle > 10) {
    writeFileSync(statePath, JSON.stringify(state))
    process.exit(0)
  }
  console.log(`No new messages. (idle count: ${idle})`)
}

writeFileSync(statePath, JSON.stringify(state))
