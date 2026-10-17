#!/usr/bin/env node
/**
 * Post a message to the office chat as Claude. Truncates to first ~10 words.
 *
 * A slash command (`node scripts/chat-post.mjs /clear`, `/incident`,
 * `/all-clear`, `/status`) goes to POST /chat with the office token instead:
 * that is the route that runs commands (/chat/reply only ever posts a line),
 * and /clear, which wipes the chat history with every stored prompt and reply,
 * needs the token. Exits 1 when the server refuses the command.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { officeHome, officeUrl, readToken, send } from '../hooks/office-client.mjs'

/**
 * Git Bash (MSYS) rewrites a lone `/clear` argument into `C:/Program Files/Git/clear`
 * before node sees it. Undo that: under MSYS, an argument that is an existing
 * directory plus one missing name was a slash command.
 */
function unMsys(args) {
  if (!process.env.MSYSTEM || args.length !== 1) return args
  const m = /^[A-Za-z]:[\\/].*[\\/]([a-z][\w-]*)$/i.exec(args[0])
  return m && !existsSync(args[0]) && existsSync(dirname(args[0])) ? [`/${m[1]}`] : args
}

async function main() {
  let text = unMsys(process.argv.slice(2)).join(' ')
  if (!text) {
    console.log('Usage: node chat-post.mjs <message>   (or a slash command: /clear, /incident, ...)')
    process.exitCode = 1
    return
  }

  const command = text.startsWith('/')
  if (!command) {
    // Truncate to ~10 words
    const words = text.split(/\s+/).filter(Boolean)
    if (words.length > 12) text = words.slice(0, 10).join(' ') + '...'
  }

  // The office token (written by the server once it is up): /chat/reply speaks
  // as an agent, so it needs it. Same file the hook reads.
  const token = readToken()
  if (!token) console.error(`no office token at ${join(officeHome(), 'auth-token')} — is the server running?`)

  const [route, payload] = command
    ? ['/chat', { sender: 'Claude', text }]
    : ['/chat/reply', { sender: 'Claude', role: 'assistant', text }]
  const res = await send(officeUrl(route), {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    timeoutMs: 5000,
  })

  if (res && res.status < 400) {
    console.log(`Posted: ${text}`)
    return
  }
  if (res) {
    let reason = res.body
    try { reason = JSON.parse(res.body).error || res.body } catch {}
    console.error(`Failed: HTTP ${res.status}: ${reason}`)
  } else {
    console.error(`Failed: could not reach the office on port ${process.env.AGENT_OFFICE_PORT || 3334}`)
  }
  if (command) process.exitCode = 1
}

await main()
