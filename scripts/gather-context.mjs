/**
 * Gathers current dev context for the chat AI prompt: git branch, last commit
 * and changed files, plus the roster's active agents. Imported by
 * chat-ai-watcher.mjs; run directly it prints the same text.
 *
 * Git context comes from the first of these that is a git checkout:
 * $AGENT_OFFICE_PROJECT (if set), the current directory, then this repo.
 * Every line is optional — missing git, a non-repo cwd or a stopped office
 * server just leave it out.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { officeUrl, send } from '../hooks/office-client.mjs'

const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** stdout of `git -C dir ...args`, or '' on any failure. */
function git(dir, args) {
  return new Promise(res => {
    execFile('git', ['-C', dir, ...args], { windowsHide: true, timeout: 5000 }, (err, stdout) => res(err ? '' : stdout.trim()))
  })
}

export async function gatherContext(env = process.env) {
  const lines = ['Current context:']

  for (const dir of [env.AGENT_OFFICE_PROJECT, process.cwd(), REPO_DIR]) {
    if (!dir || !existsSync(dir)) continue
    const branch = await git(dir, ['branch', '--show-current'])
    if (!branch) continue
    lines.push(`- Branch: ${branch}`, `- Last commit: ${await git(dir, ['log', '--oneline', '-1'])}`)
    const changed = (await git(dir, ['diff', '--name-only', 'HEAD~1'])).split('\n').filter(Boolean).slice(0, 3)
    lines.push(...changed.map(f => `- Changed: ${f}`))
    break
  }

  const res = await send(officeUrl('/roster', undefined, env), { timeoutMs: 5000 })
  if (res && res.status < 400) {
    try {
      const agents = JSON.parse(res.body).activeAgents || []
      if (agents.length) {
        for (const a of agents.slice(0, 5)) lines.push(`- Agent: ${a.name ?? '?'} (${a.role ?? '?'}) — ${[...String(a.task ?? '')].slice(0, 40).join('')}`)
      } else {
        lines.push('- No active agents')
      }
    } catch {}
  }
  return lines.join('\n') + '\n'
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(await gatherContext())
}
