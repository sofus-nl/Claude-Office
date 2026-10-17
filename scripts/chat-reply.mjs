#!/usr/bin/env node
/** Post a reply to office chat. Usage: node chat-reply.mjs 'message text' */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { officeHome, officeUrl, readToken, send } from '../hooks/office-client.mjs'

async function main() {
  const text = process.argv[2]
  if (text === undefined) {
    console.log("Usage: node chat-reply.mjs 'message'")
    process.exitCode = 1
    return
  }

  // The office token (written by the server once it is up): /chat/reply speaks
  // as an agent, so it needs it. Same file the hook reads.
  const token = readToken()
  if (!token) console.error(`no office token at ${join(officeHome(), 'auth-token')} — is the server running?`)

  // /chat/reply with an agent role: /chat is for messages a person typed, and
  // the chat watchers answer those
  const res = await send(officeUrl('/chat/reply'), {
    method: 'POST',
    body: JSON.stringify({ sender: 'Claude', role: 'assistant', text }),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    timeoutMs: 5000,
  })
  if (!res || res.status >= 400) {
    console.error(res ? `Failed: HTTP ${res.status}: ${res.body}` : `Failed: could not reach the office on port ${process.env.AGENT_OFFICE_PORT || 3334}`)
    process.exitCode = 1
    return
  }

  // Update state timestamp so we don't reply to our own message
  const statePath = join(officeHome(), 'chat-poll-state')
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    // Bump timestamp past any current messages
    state.last_seen_timestamp = Math.max(state.last_seen_timestamp ?? 0, Date.now())
    state.consecutive_idle_count = 0
    writeFileSync(statePath, JSON.stringify(state))
  } catch {}

  console.log(`Sent: ${text}`)
}

await main()
