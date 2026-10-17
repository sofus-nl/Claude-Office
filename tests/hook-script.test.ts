/**
 * hooks/agent-tracker.mjs — turns a Claude Code hook payload into an office
 * event (buildEvent, called in-process against real 2.1.x payload shapes) and
 * talks to the office: the last groups run the hook the way Claude Code
 * starts it, `node hooks/agent-tracker.mjs` with the payload on stdin,
 * against a fake office HTTP server on a loopback port.
 */

import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { buildEvent, classifyCommand, loadSignals, mightSignal, resetSignals, signalsLoaded } from '../hooks/agent-tracker.mjs'
import { officeUrl } from '../hooks/office-client.mjs'

const TRACKER = fileURLToPath(new URL('../hooks/agent-tracker.mjs', import.meta.url))

// The hook looks for $AGENT_OFFICE_HOME/answer-permissions (the server keeps
// that marker in step with its answerPermissions setting): point it at an
// empty dir so a marker in the developer's real ~/.agent-office never changes
// what the tests below see. The answer-from-the-office group sets its own.
const NO_MARKER_HOME = mkdtempSync(join(tmpdir(), 'agent-office-hook-home-'))
afterAll(() => rmSync(NO_MARKER_HOME, { recursive: true, force: true }))

/**
 * The hook's event for a payload, as the lines the old Python section
 * printed: the event as one JSON line, then `wait` for an answerable
 * PermissionRequest. No lines when the hook has nothing to say.
 */
function runHookLines(payload: unknown, env: Record<string, string> = {}): string[] {
  const built = buildEvent(typeof payload === 'string' ? payload : JSON.stringify(payload), { ...process.env, AGENT_OFFICE_HOME: NO_MARKER_HOME, ...env })
  return built ? [JSON.stringify(built.event), ...(built.wait ? ['wait'] : [])] : []
}

/** Canonical JSON as the hook's call_key writes it: keys sorted, no spaces. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** The callKey the hook sends for a call: 16 hex of sha256(tool name, NUL, the input). */
function callKeyOf(toolName: string, input: unknown): string {
  return createHash('sha256').update(`${toolName}\0${canonical(input)}`).digest('hex').slice(0, 16)
}

/** Run the hook against a payload; null when it printed nothing. */
function runHook(payload: unknown): Record<string, any> | null {
  const lines = runHookLines(payload)
  if (lines.length > 1) throw new Error(`expected one line, got ${lines.length}: ${lines.join(' | ')}`)
  return lines.length ? JSON.parse(lines[0]) : null
}

describe('agent-tracker.mjs: Agent tool', () => {
  it('PreToolUse Agent -> agent_spawned, with the role hinted from the task and background flag', () => {
    expect(runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_use_id: 'toolu_01X',
      tool_input: { description: 'Write tests for parser', prompt: '...', subagent_type: 'general-purpose', run_in_background: true },
    })).toEqual({
      type: 'agent_spawned',
      agent: {
        id: 'agent-toolu_01X',
        name: 'Tester',
        role: 'test-engineer',
        task: 'Write tests for parser',
        agentType: 'general-purpose',
        background: true,
      },
    })
  })

  it('PreToolUse Agent with an explicit subagent_type keeps that role (Task alias too)', () => {
    expect(runHook({
      hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: 'toolu_02Y',
      tool_input: { description: 'Look into the crash', prompt: '...', subagent_type: 'debugger' },
    })).toEqual({
      type: 'agent_spawned',
      agent: { id: 'agent-toolu_02Y', name: 'Debugger', role: 'debugger', task: 'Look into the crash', agentType: 'debugger', background: false },
    })

    expect(runHook({
      hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_03Z',
      tool_input: { description: 'Find the config loader', prompt: '...', subagent_type: 'Explore' },
    })?.agent).toMatchObject({ name: 'Explorer', role: 'Explore', agentType: 'Explore' })
  })

  it('PostToolUse Agent (background launch) -> agent_linked with the subagent id', () => {
    expect(runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_use_id: 'toolu_01X',
      tool_input: { description: 'Write tests for parser', prompt: '...', subagent_type: 'general-purpose', run_in_background: true },
      tool_response: { isAsync: true, status: 'async_launched', agentId: 'a1921bf97b0af9fd1', description: 'Write tests for parser' },
    })).toEqual({ type: 'agent_linked', agentId: 'agent-toolu_01X', subagentId: 'a1921bf97b0af9fd1' })
  })

  it('PostToolUse Agent (foreground) -> agent_completed with the result text', () => {
    expect(runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_use_id: 'toolu_02Y',
      tool_input: { description: 'What is the date', prompt: '...', subagent_type: 'general-purpose' },
      tool_response: {
        status: 'completed',
        agentId: 'afbfba07a82436af6',
        agentType: 'general-purpose',
        content: [{ type: 'text', text: 'The current date is Tuesday, October 14, 2026.' }],
      },
    })).toEqual({ type: 'agent_completed', agentId: 'agent-toolu_02Y', result: 'The current date is Tuesday, October 14, 2026.' })
  })

  it('truncates long results to 120 characters', () => {
    const long = 'z'.repeat(500)
    const ev = runHook({
      hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_02Y',
      tool_input: { subagent_type: 'general-purpose' },
      tool_response: { status: 'completed', content: [{ type: 'text', text: long }] },
    })
    expect(ev?.result).toHaveLength(120)
  })
})

describe('agent-tracker.mjs: inside a subagent', () => {
  it('PreToolUse Bash with agent_id -> agent_working tagged with the subagent', () => {
    expect(runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      agent_id: 'a1921bf97b0af9fd1',
      agent_type: 'general-purpose',
      tool_input: { command: 'ls /etc | wc -l' },
    })).toEqual({
      type: 'agent_working',
      status: 'running: ls /etc | wc -l',
      tool: 'Bash',
      agentId: 'a1921bf97b0af9fd1',
      agentType: 'general-purpose',
      role: 'general-purpose',
      name: 'Agent',
    })
  })

  it('PreToolUse Read on the main thread -> agent_working without an agent id', () => {
    expect(runHook({
      hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/server/index.js' },
    })).toEqual({ type: 'agent_working', status: 'reading index.js', tool: 'Read' })
  })

  it('SubagentStop -> agent_completed with the last assistant message', () => {
    expect(runHook({
      hook_event_name: 'SubagentStop',
      agent_id: 'af4d4090b68ebb5f9',
      agent_type: 'general-purpose',
      last_assistant_message: 'The Bash command ran and printed hi.',
    })).toEqual({ type: 'agent_completed', agentId: 'af4d4090b68ebb5f9', result: 'The Bash command ran and printed hi.' })

    expect(runHook({ hook_event_name: 'SubagentStop', agent_id: 'af4d4090b68ebb5f9', agent_type: 'general-purpose' })?.result).toBe('done')
    expect(runHook({ hook_event_name: 'SubagentStop' })).toBeNull()
  })

  it('PostToolUseFailure with agent_id -> failed agent_working tagged with the subagent', () => {
    // Shape captured on the main thread (see below) plus the agent_id/agent_type
    // every hook fired inside a subagent carries — not captured inside one.
    expect(runHook({
      hook_event_name: 'PostToolUseFailure',
      agent_id: 'a29964dc791f62039',
      agent_type: 'general-purpose',
      tool_name: 'Bash',
      tool_input: { command: 'cat /definitely/not/here', description: 'Attempt to read a nonexistent file' },
      tool_use_id: 'toolu_01NT86yPHDT746zG29pswfa9',
      error: 'Exit code 1\ncat: /definitely/not/here: No such file or directory',
      is_interrupt: false,
      duration_ms: 135,
    })).toEqual({
      type: 'agent_working',
      status: 'failed: Bash — Exit code 1 cat: /definitely/not/here: No such file or direc',
      failed: true,
      tool: 'Bash',
      agentId: 'a29964dc791f62039',
      agentType: 'general-purpose',
      role: 'general-purpose',
      name: 'Agent',
    })
  })

  it('nested PreToolUse Agent (a subagent spawning a subagent) -> agent_spawned with parentSubagentId', () => {
    // The Agent call is made inside subagent a29964dc791f62039, so the hook
    // carries its agent_id/agent_type like any other tool call made in there.
    expect(runHook({
      hook_event_name: 'PreToolUse',
      agent_id: 'a29964dc791f62039',
      agent_type: 'general-purpose',
      tool_name: 'Agent',
      tool_input: { description: 'Find hostname', prompt: 'Read /etc/hostname and report it.', subagent_type: 'Explore', run_in_background: false },
      tool_use_id: 'toolu_012RzmXCF41YXYEnVbdvuQTT',
    })).toEqual({
      type: 'agent_spawned',
      agent: {
        id: 'agent-toolu_012RzmXCF41YXYEnVbdvuQTT',
        name: 'Explorer',
        role: 'Explore',
        task: 'Find hostname',
        agentType: 'Explore',
        background: false,
        parentSubagentId: 'a29964dc791f62039',
      },
    })
  })
})

/**
 * Payloads captured verbatim from Claude Code 2.1.300 (scratchpad/hookcap,
 * 2026-10-14). Only the capture's own bookkeeping keys were dropped.
 */
describe('agent-tracker.mjs: captured 2.1.300 payloads', () => {
  const common = {
    session_id: '8cf68f64-5433-40f7-a130-557fc7f67e42',
    transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/8cf68f64-5433-40f7-a130-557fc7f67e42.jsonl',
    cwd: '/tmp/claude-0/-home-user-Claude-Office/c25c5511-f321-521a-825b-f189ac4d57e8/scratchpad/hookcap',
    scratchpad_dir: '/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/8cf68f64-5433-40f7-a130-557fc7f67e42/scratchpad',
    prompt_id: 'd0f0818e-428e-4732-b3f2-6830d470b485',
  }
  // What every event made from `common` carries: the session it came from
  const session = {
    sessionId: common.session_id,
    project: 'hookcap',
    cwd: common.cwd,
    transcriptPath: common.transcript_path,
  }
  // The other capture session (c25c5511…) that some payloads below belong to
  const other = {
    session_id: 'c25c5511-f321-521a-825b-f189ac4d57e8',
    transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/c25c5511-f321-521a-825b-f189ac4d57e8.jsonl',
  }
  const otherSession = { sessionId: other.session_id, project: 'hookcap', cwd: common.cwd, transcriptPath: other.transcript_path }

  it('SubagentStart -> agent_started: agent_id is the new subagent, no parent is named', () => {
    expect(runHook({
      ...common,
      agent_id: 'ac5ff55b850b4fecf',
      agent_type: 'general-purpose',
      hook_event_name: 'SubagentStart',
    })).toEqual({ type: 'agent_started', subagentId: 'ac5ff55b850b4fecf', agentType: 'general-purpose', ...session })

    // No agent_type: a sidechain, not a worker
    expect(runHook({ ...common, agent_id: 'a4b69979afca21afd', agent_type: '', hook_event_name: 'SubagentStart' })).toBeNull()
  })

  it('PreToolUse Agent (background) -> agent_spawned without parentSubagentId on the main thread', () => {
    expect(runHook({
      ...common,
      permission_mode: 'bypassPermissions',
      effort: { level: 'medium' },
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { description: 'Count etc', prompt: 'Run ls /etc | wc -l with Bash and report it.', subagent_type: 'general-purpose', run_in_background: true },
      tool_use_id: 'toolu_01B8Zp1BDnyYNe7SEsseUD22',
    })).toEqual({
      type: 'agent_spawned',
      agent: { id: 'agent-toolu_01B8Zp1BDnyYNe7SEsseUD22', name: 'Agent', role: 'general-purpose', task: 'Count etc', agentType: 'general-purpose', background: true },
      ...session,
    })
  })

  it('PostToolUse Agent (async_launched) -> agent_linked', () => {
    expect(runHook({
      ...common,
      permission_mode: 'bypassPermissions',
      effort: { level: 'medium' },
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_input: { description: 'Count etc', prompt: 'Run ls /etc | wc -l with Bash and report it.', subagent_type: 'general-purpose', run_in_background: true },
      tool_response: {
        isAsync: true,
        status: 'async_launched',
        agentId: 'ac5ff55b850b4fecf',
        description: 'Count etc',
        resolvedModel: 'claude-haiku-5-5',
        prompt: 'Run ls /etc | wc -l with Bash and report it.',
        outputFile: '/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/8cf68f64-5433-40f7-a130-557fc7f67e42/tasks/ac5ff55b850b4fecf.output',
        canReadOutputFile: true,
        canContinueAgent: true,
      },
      tool_use_id: 'toolu_01B8Zp1BDnyYNe7SEsseUD22',
      duration_ms: 10,
    })).toEqual({ type: 'agent_linked', agentId: 'agent-toolu_01B8Zp1BDnyYNe7SEsseUD22', subagentId: 'ac5ff55b850b4fecf', ...session })
  })

  it('PreToolUse Bash inside the subagent -> agent_working on that subagent', () => {
    // A hook fired inside a subagent carries the PARENT session's session_id
    // (the subagent transcript lives under <session_id>/subagents/), so the
    // working event files the worker under the terminal that spawned it
    expect(runHook({
      ...other,
      cwd: common.cwd,
      scratchpad_dir: '/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/c25c5511-f321-521a-825b-f189ac4d57e8/scratchpad',
      prompt_id: '60d87662-ef42-4452-a6bd-cd9718825c5b',
      permission_mode: 'bypassPermissions',
      agent_id: 'a29964dc791f62039',
      agent_type: 'general-purpose',
      effort: { level: 'medium' },
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls /etc | wc -l', description: 'Count entries in /etc' },
      tool_use_id: 'toolu_01YUQ8UYuNroNSSpa5Qp26CW',
    })).toEqual({
      type: 'agent_working',
      status: 'running: ls /etc | wc -l',
      tool: 'Bash',
      agentId: 'a29964dc791f62039',
      agentType: 'general-purpose',
      role: 'general-purpose',
      name: 'Agent',
      ...otherSession,
    })
  })

  it('SubagentStop of a real worker -> agent_completed with the first 120 chars of its last message', () => {
    const last = '`ls /etc | wc -l` returned **154**, so `/etc` has 154 entries.\n\nThe MCP connection failures in the system notice (design and sales plugin servers returning 403 from the proxy) are unrelated to this command and did not affect it.'
    expect(runHook({
      ...common,
      permission_mode: 'bypassPermissions',
      agent_id: 'ac5ff55b850b4fecf',
      agent_type: 'general-purpose',
      effort: { level: 'medium' },
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/8cf68f64-5433-40f7-a130-557fc7f67e42/subagents/agent-ac5ff55b850b4fecf.jsonl',
      last_assistant_message: last,
      background_tasks: [{ id: 'ac5ff55b850b4fecf', type: 'subagent', status: 'running', description: 'Count etc', agent_type: 'general-purpose' }],
      session_crons: [],
    })).toEqual({
      type: 'agent_completed', agentId: 'ac5ff55b850b4fecf', result: last.slice(0, 120),
      // The worker's own transcript travels as a path string (the inspector card tails it)
      agentTranscriptPath: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/8cf68f64-5433-40f7-a130-557fc7f67e42/subagents/agent-ac5ff55b850b4fecf.jsonl',
      ...session,
    })
  })

  it('phantom SubagentStop (compaction summariser, agent_type "") -> nothing', () => {
    expect(runHook({
      session_id: 'c25c5511-f321-521a-825b-f189ac4d57e8',
      transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/c25c5511-f321-521a-825b-f189ac4d57e8.jsonl',
      cwd: common.cwd,
      scratchpad_dir: '/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/c25c5511-f321-521a-825b-f189ac4d57e8/scratchpad',
      prompt_id: 'e40b57ac-50aa-4bae-a043-8852cc9ba9c7',
      permission_mode: 'bypassPermissions',
      agent_id: 'a4b69979afca21afd',
      agent_type: '',
      effort: { level: 'medium' },
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/c25c5511-f321-521a-825b-f189ac4d57e8/subagents/agent-a4b69979afca21afd.jsonl',
      last_assistant_message: '<analysis>\nThe conversation has three parts. The user first asked for two subagents: a background general-purpose agent described as "Count etc" to run `ls /etc | wc -l`, and a foreground Explore agent described as "Find hostname" to read `/etc/hostname`. They then asked me to wait for the background result and reply DONE. I launched both in one message. The foreground agent returned `vm` as the h...[+2447 chars]',
      background_tasks: [],
      session_crons: [],
    })).toBeNull()
  })

  it('phantom SubagentStop (prompt-suggestion sidechain, agent_type "") -> nothing', () => {
    expect(runHook({
      session_id: 'ce07e2db-35c7-42b0-b00b-fb2ebe9f8e3f',
      transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/ce07e2db-35c7-42b0-b00b-fb2ebe9f8e3f.jsonl',
      cwd: common.cwd,
      scratchpad_dir: '/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/ce07e2db-35c7-42b0-b00b-fb2ebe9f8e3f/scratchpad',
      prompt_id: 'b09cb9a5-0ed7-4592-b4cb-94b9c030e211',
      permission_mode: 'bypassPermissions',
      agent_id: 'a876884f19e1485b2',
      agent_type: '',
      effort: { level: 'medium' },
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/ce07e2db-35c7-42b0-b00b-fb2ebe9f8e3f/subagents/agent-a876884f19e1485b2.jsonl',
      last_assistant_message: 'try the team setup again',
      background_tasks: [],
      session_crons: [],
    })).toBeNull()

    // Missing agent_type altogether is treated the same way
    expect(runHook({ hook_event_name: 'SubagentStop', agent_id: 'a876884f19e1485b2', last_assistant_message: 'x' })).toBeNull()
  })

  it('PostToolUseFailure on the main thread (Bash exit 1) -> failed agent_working without an agent id', () => {
    const failure = {
      session_id: '17f46010-d2b1-4d95-bdde-34994b4b1d00',
      transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/17f46010-d2b1-4d95-bdde-34994b4b1d00.jsonl',
      cwd: common.cwd,
      scratchpad_dir: '/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/17f46010-d2b1-4d95-bdde-34994b4b1d00/scratchpad',
      prompt_id: '47795df5-e84a-4a57-8884-078b1e761a82',
      permission_mode: 'bypassPermissions',
      effort: { level: 'medium' },
      hook_event_name: 'PostToolUseFailure',
    }
    const failureSession = { sessionId: failure.session_id, project: 'hookcap', cwd: failure.cwd, transcriptPath: failure.transcript_path }
    expect(runHook({
      ...failure,
      tool_name: 'Bash',
      tool_input: { command: 'cat /definitely/not/here', description: 'Attempt to read a nonexistent file' },
      tool_use_id: 'toolu_01NT86yPHDT746zG29pswfa9',
      error: 'Exit code 1\ncat: /definitely/not/here: No such file or directory',
      is_interrupt: false,
      duration_ms: 135,
    })).toEqual({
      type: 'agent_working',
      status: 'failed: Bash — Exit code 1 cat: /definitely/not/here: No such file or direc',
      failed: true,
      tool: 'Bash',
      ...failureSession,
    })

    expect(runHook({
      ...failure,
      tool_name: 'Bash',
      tool_input: { command: 'false', description: 'Run false to exit with status 1' },
      tool_use_id: 'toolu_01CHztAKTp1SviXu1oRzVeh9',
      error: 'Exit code 1',
      is_interrupt: false,
      duration_ms: 53,
    })).toEqual({ type: 'agent_working', status: 'failed: Bash — Exit code 1', failed: true, tool: 'Bash', ...failureSession })
  })

  it('PostToolUseFailure of an MCP call -> mcp_done, of an Agent launch -> agent_completed', () => {
    expect(runHook({
      hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__github__get_me', tool_input: {}, tool_use_id: 'toolu_mcp',
      error: 'MCP error -32603: boom', is_interrupt: false, duration_ms: 20,
    })).toEqual({ type: 'mcp_done', server: 'github', tool: 'get_me', callKey: callKeyOf('mcp__github__get_me', {}) })

    expect(runHook({
      hook_event_name: 'PostToolUseFailure', tool_name: 'Agent', tool_use_id: 'toolu_01X',
      tool_input: { description: 'Nope', prompt: '...', subagent_type: 'does-not-exist' },
      error: 'Agent type \'does-not-exist\' not found.', is_interrupt: false, duration_ms: 3,
    })).toEqual({ type: 'agent_completed', agentId: 'agent-toolu_01X', result: "failed: Agent type 'does-not-exist' not found." })
  })
})

/**
 * Sessions. SessionStart / SessionEnd payloads captured verbatim from Claude
 * Code 2.1.300 (scratchpad/hookcap/events.jsonl, 2026-10-14): session_id,
 * transcript_path and cwd are in the base schema of every hook event.
 */
describe('agent-tracker.mjs: sessions', () => {
  const base = {
    session_id: 'c25c5511-f321-521a-825b-f189ac4d57e8',
    transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/c25c5511-f321-521a-825b-f189ac4d57e8.jsonl',
    cwd: '/tmp/claude-0/-home-user-Claude-Office/c25c5511-f321-521a-825b-f189ac4d57e8/scratchpad/hookcap',
    scratchpad_dir: '/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/c25c5511-f321-521a-825b-f189ac4d57e8/scratchpad',
  }
  const session = { sessionId: base.session_id, project: 'hookcap', cwd: base.cwd, transcriptPath: base.transcript_path }

  it('SessionStart {source: startup} -> session_started (no model on a bare startup)', () => {
    expect(runHook({ ...base, hook_event_name: 'SessionStart', source: 'startup' }))
      .toEqual({ type: 'session_started', source: 'startup', ...session })
  })

  it('SessionStart {source: startup, model} -> session_started with the model', () => {
    expect(runHook({
      session_id: '19616213-277c-4e70-9909-9883230a3394',
      transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/19616213-277c-4e70-9909-9883230a3394.jsonl',
      cwd: base.cwd,
      scratchpad_dir: '/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/19616213-277c-4e70-9909-9883230a3394/scratchpad',
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'claude-haiku-5-5',
    })).toEqual({
      type: 'session_started',
      source: 'startup',
      model: 'claude-haiku-5-5',
      sessionId: '19616213-277c-4e70-9909-9883230a3394',
      project: 'hookcap',
      cwd: base.cwd,
      transcriptPath: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/19616213-277c-4e70-9909-9883230a3394.jsonl',
    })
  })

  it('SessionStart {source: resume} (claude -r) -> session_started with the same session id; token fields are dropped', () => {
    expect(runHook({
      ...base,
      hook_event_name: 'SessionStart',
      source: 'resume',
      seconds_since_last_response: 5,
      context_tokens: 44052,
      prompt_cache_likely_expired: false,
      estimated_cache_write_usd: 0.0088,
    })).toEqual({ type: 'session_started', source: 'resume', ...session })
  })

  it('SessionStart {source: compact, model} -> session_started with the model (the server treats it as an update)', () => {
    expect(runHook({
      ...base,
      prompt_id: 'e40b57ac-50aa-4bae-a043-8852cc9ba9c7',
      hook_event_name: 'SessionStart',
      source: 'compact',
      model: 'claude-haiku-5-5',
    })).toEqual({ type: 'session_started', source: 'compact', model: 'claude-haiku-5-5', ...session })
  })

  it('a named session (session_title) -> title; source defaults to startup', () => {
    // session_title only exists when the session was named (--name / /rename)
    expect(runHook({ ...base, hook_event_name: 'SessionStart', source: 'fork', session_title: 'office refactor' }))
      .toEqual({ type: 'session_started', source: 'fork', title: 'office refactor', ...session })
    expect(runHook({ ...base, hook_event_name: 'SessionStart' })?.source).toBe('startup')
  })

  it('SessionEnd {reason: other} (every -p exit) and {reason: prompt_input_exit} (/exit) -> session_ended', () => {
    expect(runHook({ ...base, prompt_id: '54f01295-3ff5-45ab-a738-b0598eae881d', hook_event_name: 'SessionEnd', reason: 'other' }))
      .toEqual({ type: 'session_ended', reason: 'other', ...session })
    expect(runHook({
      session_id: '19616213-277c-4e70-9909-9883230a3394',
      transcript_path: '/t/19616213.jsonl',
      cwd: base.cwd,
      prompt_id: 'f2fb3821-dd71-4d36-95ff-ae5cdedfaf8f',
      hook_event_name: 'SessionEnd',
      reason: 'prompt_input_exit',
    })).toEqual({
      type: 'session_ended', reason: 'prompt_input_exit',
      sessionId: '19616213-277c-4e70-9909-9883230a3394', project: 'hookcap', cwd: base.cwd, transcriptPath: '/t/19616213.jsonl',
    })
  })

  it('SessionStart/SessionEnd without a session_id emit nothing', () => {
    expect(runHook({ hook_event_name: 'SessionStart', source: 'startup' })).toBeNull()
    expect(runHook({ hook_event_name: 'SessionEnd', reason: 'other' })).toBeNull()
  })

  it('every emitted event carries sessionId, project, cwd and transcriptPath', () => {
    const payloads: Array<Record<string, unknown>> = [
      { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { description: 'Count etc', subagent_type: 'general-purpose', run_in_background: true } },
      { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { run_in_background: true }, tool_response: { status: 'async_launched', agentId: 'ac5ff55b850b4fecf' } },
      { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_2', tool_input: {}, tool_response: { status: 'completed', content: [{ type: 'text', text: 'ok' }] } },
      { hook_event_name: 'PostToolUseFailure', tool_name: 'Agent', tool_use_id: 'toolu_3', tool_input: {}, error: 'nope' },
      { hook_event_name: 'SubagentStart', agent_id: 'ac5ff55b850b4fecf', agent_type: 'general-purpose' },
      { hook_event_name: 'SubagentStop', agent_id: 'ac5ff55b850b4fecf', agent_type: 'general-purpose', last_assistant_message: 'done' },
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x/y.js' } },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: 'ac5ff55b850b4fecf', agent_type: 'general-purpose', tool_input: { command: 'ls' } },
      { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'false' }, error: 'Exit code 1' },
      { hook_event_name: 'PreToolUse', tool_name: 'mcp__github__get_me', tool_input: {} },
      { hook_event_name: 'PostToolUse', tool_name: 'mcp__github__get_me', tool_input: {}, tool_response: {} },
      { hook_event_name: 'PostToolUse', tool_name: 'SubagentHandback', tool_input: { agent_id: 'ac5ff55b850b4fecf' }, tool_response: 'report' },
      { hook_event_name: 'SessionStart', source: 'startup' },
      { hook_event_name: 'SessionEnd', reason: 'other' },
    ]
    const types = payloads.map(p => {
      const ev = runHook({ ...base, ...p })
      expect(ev, JSON.stringify(p)).toMatchObject(session)
      return ev?.type
    })
    expect(types).toEqual([
      'agent_spawned', 'agent_linked', 'agent_completed', 'agent_completed', 'agent_started', 'agent_completed',
      'agent_working', 'agent_working', 'agent_working', 'mcp_call', 'mcp_done', 'agent_completed',
      'session_started', 'session_ended',
    ])
  })

  it('project is the last path segment of cwd (trailing slash tolerated; "/" stays "/")', () => {
    const read = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, session_id: 's', transcript_path: '/t.jsonl' }
    expect(runHook({ ...read, cwd: '/home/me/Claude-Office' })?.project).toBe('Claude-Office')
    expect(runHook({ ...read, cwd: '/home/me/Claude-Office/' })?.project).toBe('Claude-Office')
    expect(runHook({ ...read, cwd: '/' })?.project).toBe('/')
    // No cwd: no project/cwd keys, but the session id still travels
    expect(runHook({ ...read })).toEqual({ type: 'agent_working', status: 'reading x', tool: 'Read', sessionId: 's', transcriptPath: '/t.jsonl' })
  })

  it('payloads without session fields (older hooks, hand-made events) emit the old shapes unchanged', () => {
    expect(runHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/a/b.js' } }))
      .toEqual({ type: 'agent_working', status: 'reading b.js', tool: 'Read' })
  })
})

describe('agent-tracker.mjs: MCP tools', () => {
  it('PreToolUse mcp__github__get_me -> mcp_call', () => {
    expect(runHook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__github__get_me', tool_input: {} }))
      .toEqual({ type: 'mcp_call', server: 'github', tool: 'get_me' })
  })

  it('PostToolUse mcp__github__get_me -> mcp_done with the tool and the callKey (the server lowers the hand that call raised); inside a worker with its agentId', () => {
    expect(runHook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__github__get_me', tool_input: {}, tool_response: { login: 'w17ant' } }))
      .toEqual({ type: 'mcp_done', server: 'github', tool: 'get_me', callKey: callKeyOf('mcp__github__get_me', {}) })
    const input = { owner: 'W17ant', repo: 'Claude-Office', title: 'x' }
    expect(runHook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__github__create_issue', agent_id: 'a027f376ae8cdcbd0', agent_type: 'Explore', tool_input: input, tool_response: {} }))
      .toEqual({ type: 'mcp_done', server: 'github', tool: 'create_issue', callKey: callKeyOf('mcp__github__create_issue', input), agentId: 'a027f376ae8cdcbd0' })
  })

  it('splits server and tool on the first "__" only', () => {
    expect(runHook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__claude-code-remote__list_sessions' }))
      .toEqual({ type: 'mcp_call', server: 'claude-code-remote', tool: 'list_sessions' })
  })
})

describe('agent-tracker.mjs: every tool call is activity', () => {
  it('PreToolUse of a tool without a specific status line -> a generic "using <tool>" working status, main thread or worker', () => {
    expect(runHook({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }))
      .toEqual({ type: 'agent_working', status: 'using WebFetch', tool: 'WebFetch' })
    expect(runHook({ hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', agent_id: 'a1921bf97b0af9fd1', agent_type: 'Explore', tool_input: { todos: [] } }))
      .toEqual({ type: 'agent_working', status: 'using TodoWrite', tool: 'TodoWrite', agentId: 'a1921bf97b0af9fd1', agentType: 'Explore', role: 'Explore', name: 'Explorer' })
    // The known tools keep their specific lines; a tool_input that is not an object does not crash the hook
    expect(runHook({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'needle' } })?.status).toBe("searching for 'needle'")
    expect(runHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: null })).toEqual({ type: 'agent_working', status: 'reading ', tool: 'Read' })
  })

  it('PostToolUse of an ordinary tool -> session_tool_done {toolName, callKey} (lowers the permission hand that very call raised); inside a worker with its agentId; without a session, nothing', () => {
    const session = { session_id: 's1', cwd: '/x/proj', transcript_path: '/t.jsonl', prompt_id: 'p' }
    expect(runHook({ ...session, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'ok' }))
      .toEqual({ type: 'session_tool_done', toolName: 'Bash', callKey: callKeyOf('Bash', { command: 'ls' }), promptId: 'p', sessionId: 's1', project: 'proj', cwd: '/x/proj', transcriptPath: '/t.jsonl' })
    expect(runHook({ ...session, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/x/probe.txt', content: 'hello' }, tool_response: { filePath: '/x/probe.txt', success: true } }))
      .toMatchObject({ type: 'session_tool_done', toolName: 'Write' })
    // A worker's call: its dialog (agent_id on the PermissionRequest) is answered by its own finish
    expect(runHook({ ...session, hook_event_name: 'PostToolUse', tool_name: 'Bash', agent_id: 'a1921bf97b0af9fd1', agent_type: 'general-purpose', tool_input: { command: 'ls' }, tool_response: 'ok' }))
      .toEqual({ type: 'session_tool_done', toolName: 'Bash', callKey: callKeyOf('Bash', { command: 'ls' }), agentId: 'a1921bf97b0af9fd1', promptId: 'p', sessionId: 's1', project: 'proj', cwd: '/x/proj', transcriptPath: '/t.jsonl' })
    expect(runHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'ok' })).toBeNull()
    expect(runHook({ hook_event_name: 'PostToolUse', tool_name: 'WebFetch', tool_input: {}, tool_response: 'page' })).toBeNull()
  })

  it('callKey: the PermissionRequest and the PostToolUse of one call carry the same key; another call of that tool (git status beside git push) another one', () => {
    const session = { session_id: 's1', cwd: '/x/proj', transcript_path: '/t.jsonl', prompt_id: 'p', permission_mode: 'default' }
    const push = { command: 'git push origin main', description: 'Push' }
    const asked = runHook({ ...session, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: push })
    const ran = runHook({ ...session, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { description: 'Push', command: 'git push origin main' }, tool_response: { stdout: '', stderr: '' } })
    const sibling = runHook({ ...session, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git status', description: 'Status' }, tool_response: { stdout: '', stderr: '' } })
    expect(asked?.callKey).toMatch(/^[0-9a-f]{16}$/)
    expect(ran?.callKey).toBe(asked?.callKey)                     // key order in the input does not matter
    expect(sibling?.callKey).not.toBe(asked?.callKey)
    // The tool name is part of it: the same input to another tool is another call
    expect(runHook({ ...session, hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: push })?.callKey).not.toBe(asked?.callKey)
  })

  it('PostToolUse Agent (foreground, captured) -> agent_completed with what the agent cost: tokens, durationMs, toolUses, model', () => {
    // Captured 2.1.300: the foreground Explore agent of session c25c5511 (prompt 60d87662)
    expect(runHook({
      session_id: 'c25c5511-f321-521a-825b-f189ac4d57e8',
      transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/c25c5511-f321-521a-825b-f189ac4d57e8.jsonl',
      cwd: '/tmp/claude-0/-home-user-Claude-Office/c25c5511-f321-521a-825b-f189ac4d57e8/scratchpad/hookcap',
      prompt_id: '60d87662-ef42-4452-a6bd-cd9718825c5b',
      permission_mode: 'bypassPermissions',
      effort: { level: 'medium' },
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_input: { description: 'Find hostname', prompt: 'Read /etc/hostname and report it.', subagent_type: 'Explore', run_in_background: false },
      tool_response: {
        status: 'completed', prompt: 'Read /etc/hostname and report it.', agentId: 'a090f8b6e472b3cf9', agentType: 'Explore',
        harnessNoteCount: 0, harnessTailCount: 0, harnessSectionHash: '71f94196794b0023',
        content: [{ type: 'text', text: 'The hostname in `/etc/hostname` is `vm`.' }],
        resolvedModel: 'claude-haiku-5-5', totalDurationMs: 2913, totalTokens: 20442, totalToolUseCount: 1,
        usage: { output_tokens_details: { thinking_tokens: 97 }, input_tokens: 2, cache_creation_input_tokens: 1497, cache_read_input_tokens: 18824, output_tokens: 119, service_tier: 'standard' },
        toolStats: { readCount: 1, searchCount: 0, bashCount: 0, editFileCount: 0, linesAdded: 0, linesRemoved: 0, otherToolCount: 0 },
        canContinueAgent: true,
      },
      tool_use_id: 'toolu_01GxFiqPkJRKxd5Qkyus2tLN',
      duration_ms: 2926,
    })).toEqual({
      type: 'agent_completed', agentId: 'agent-toolu_01GxFiqPkJRKxd5Qkyus2tLN', result: 'The hostname in `/etc/hostname` is `vm`.',
      tokens: 20442, durationMs: 2913, toolUses: 1, model: 'claude-haiku-5-5',
      sessionId: 'c25c5511-f321-521a-825b-f189ac4d57e8', project: 'hookcap',
      cwd: '/tmp/claude-0/-home-user-Claude-Office/c25c5511-f321-521a-825b-f189ac4d57e8/scratchpad/hookcap',
      transcriptPath: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/c25c5511-f321-521a-825b-f189ac4d57e8.jsonl',
    })
    // Odd values are left out rather than forwarded
    expect(runHook({
      hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_x', tool_input: {},
      tool_response: { status: 'completed', content: 'ok', totalTokens: true, totalDurationMs: -5, totalToolUseCount: '3', resolvedModel: 7 },
    })).toEqual({ type: 'agent_completed', agentId: 'agent-toolu_x', result: 'ok' })
  })
})

describe('agent-tracker.mjs: ignored payloads', () => {
  it('prints nothing for an empty payload or one with neither a tool_name nor a session', () => {
    expect(runHook({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' })).toBeNull()
    expect(runHook({ hook_event_name: 'Stop', last_assistant_message: 'x' })).toBeNull()
    expect(runHook({})).toBeNull()
  })

  it('prints nothing (and exits 0) for a payload that is not JSON, or JSON that is not an object', () => {
    expect(runHook('not json at all')).toBeNull()
    expect(runHook('')).toBeNull()
    expect(runHook('[1, 2]')).toBeNull()
    expect(runHook('"a string"')).toBeNull()
  })
})

/**
 * The session's own Claude — the main-thread events. Payloads captured
 * verbatim from Claude Code 2.1.300 (scratchpad/hookcap/events.jsonl and the
 * session-a transcript, 2026-10-14) unless marked synthetic; only the
 * capture's own bookkeeping keys were dropped. None of these carries a
 * tool_name except PermissionRequest.
 */
describe('agent-tracker.mjs: the main thread (session_* events)', () => {
  const HOOKCAP = '/tmp/claude-0/-home-user-Claude-Office/c25c5511-f321-521a-825b-f189ac4d57e8/scratchpad/hookcap'
  const PROJECTS = '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap'
  /** Common keys of a captured session: session_id, transcript_path, cwd, scratchpad_dir */
  const captured = (sid: string) => ({
    session_id: sid,
    transcript_path: `${PROJECTS}/${sid}.jsonl`,
    cwd: HOOKCAP,
    scratchpad_dir: `/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/${sid}/scratchpad`,
  })
  /** What every event made from that session carries */
  const forwarded = (sid: string) => ({ sessionId: sid, project: 'hookcap', cwd: HOOKCAP, transcriptPath: `${PROJECTS}/${sid}.jsonl` })
  const C = 'c25c5511-f321-521a-825b-f189ac4d57e8'   // the round-1 capture session (session a's twin)
  const A = '8cf68f64-5433-40f7-a130-557fc7f67e42'   // round-2 session a: background + foreground subagent

  it('UserPromptSubmit -> session_prompt with the prompt text and the prompt id', () => {
    const prompt = "Launch ONE background subagent with the Agent tool (run_in_background: true, subagent_type general-purpose, description 'Count etc') whose prompt is 'Run ls /etc | wc -l with Bash and report it.' Then launch ONE foreground subagent (subagent_type Explore, description 'Find hostname') with prompt 'Read /etc/hostname and report it.' Wait for the background result, then reply DONE."
    expect(runHook({
      ...captured(C),
      prompt_id: '60d87662-ef42-4452-a6bd-cd9718825c5b',
      permission_mode: 'bypassPermissions',
      hook_event_name: 'UserPromptSubmit',
      prompt,
    })).toEqual({ type: 'session_prompt', text: prompt, isWakeup: false, promptId: '60d87662-ef42-4452-a6bd-cd9718825c5b', ...forwarded(C) })
  })

  it('a <task-notification> prompt (a background worker reporting back) -> session_prompt {isWakeup, wakeupAgentId}; only the <summary> travels', () => {
    // The full prompt as written to session a's transcript (the hook capture clipped it at 400 chars)
    const prompt = '<task-notification>\n<task-id>ac5ff55b850b4fecf</task-id>\n<tool-use-id>toolu_01B8Zp1BDnyYNe7SEsseUD22</tool-use-id>\n<output-file>/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/8cf68f64-5433-40f7-a130-557fc7f67e42/tasks/ac5ff55b850b4fecf.output</output-file>\n<status>completed</status>\n<summary>Agent "Count etc" finished</summary>\n<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>\n<result>`ls /etc | wc -l` returned **154**, so `/etc` has 154 entries.\n\nThe MCP connection failures in the system notice (design and sales plugin servers returning 403 from the proxy) are unrelated to this command and did not affect it.</result>\n<usage><subagent_tokens>29829</subagent_tokens><tool_uses>1</tool_uses><duration_ms>3973</duration_ms></usage>\n</task-notification>'
    const ev = runHook({
      ...captured(A),
      prompt_id: 'd0f0818e-428e-4732-b3f2-6830d470b485',
      permission_mode: 'bypassPermissions',
      hook_event_name: 'UserPromptSubmit',
      prompt,
    })
    expect(ev).toEqual({
      type: 'session_prompt',
      text: 'Agent "Count etc" finished',
      isWakeup: true,
      wakeupAgentId: 'ac5ff55b850b4fecf',   // the subagent id the server already resolves to its office agent
      wakeupStatus: 'completed',
      promptId: 'd0f0818e-428e-4732-b3f2-6830d470b485',
      ...forwarded(A),
    })
    // Neither the XML nor the worker's result leaks
    expect(JSON.stringify(ev)).not.toMatch(/<task-notification>|returned \*\*154\*\*|output-file/)
  })

  it('clamps a long prompt to 2000 characters hook-side (the server would refuse an oversize body whole)', () => {
    const ev = runHook({ ...captured(C), prompt_id: 'p', hook_event_name: 'UserPromptSubmit', prompt: 'z'.repeat(10_000) })
    expect(ev?.text).toHaveLength(2000)
    // A prompt that is not a string (never seen; schema says string) is forwarded as empty text, not a crash
    expect(runHook({ ...captured(C), hook_event_name: 'UserPromptSubmit', prompt: 42 })).toMatchObject({ type: 'session_prompt', text: '', isWakeup: false })
  })

  it('Stop -> session_turn_end with the reply, the (empty) task list and the cron count', () => {
    // Captured while the background agent was still running: background_tasks was [] all the same (see the synthetic case below)
    const last = "The foreground Explore agent reports that `/etc/hostname` contains `vm`.\n\nThe background agent that runs `ls /etc | wc -l` is still running. I'll reply DONE when its completion notification arrives."
    expect(runHook({
      ...captured(C),
      prompt_id: '60d87662-ef42-4452-a6bd-cd9718825c5b',
      permission_mode: 'bypassPermissions',
      effort: { level: 'medium' },
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: last,
      background_tasks: [],
      session_crons: [],
    })).toEqual({
      type: 'session_turn_end', text: last, backgroundTasks: [], crons: 0, stopHookActive: false,
      promptId: '60d87662-ef42-4452-a6bd-cd9718825c5b', ...forwarded(C),
    })

    // The auto-continuation turn after the wake-up
    expect(runHook({
      ...captured(C), prompt_id: '54f01295-3ff5-45ab-a738-b0598eae881d', permission_mode: 'bypassPermissions', effort: { level: 'medium' },
      hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'DONE', background_tasks: [], session_crons: [],
    })).toMatchObject({ type: 'session_turn_end', text: 'DONE', promptId: '54f01295-3ff5-45ab-a738-b0598eae881d' })
  })

  it('Stop with a running background task (synthetic: the entry shape is the one SubagentStop carried) -> backgroundTasks, max 10, descriptions at 120', () => {
    const running = { id: 'a29964dc791f62039', type: 'subagent', status: 'running', description: 'Count etc', agent_type: 'general-purpose' }
    const ev = runHook({
      ...captured(C), prompt_id: 'p', permission_mode: 'bypassPermissions', effort: { level: 'medium' },
      hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'Waiting for the count.',
      background_tasks: [
        running,
        { id: 'sh1', type: 'shell', status: 'running', description: 'x'.repeat(500), command: 'sleep 1000' },
        'junk',
        ...Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, type: 'monitor', status: 'pending', description: `m${i}` })),
      ],
      session_crons: [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check CI' }],
    })
    expect(ev).toMatchObject({ type: 'session_turn_end', text: 'Waiting for the count.', crons: 1, stopHookActive: true })
    expect(ev?.backgroundTasks[0]).toEqual({ id: 'a29964dc791f62039', type: 'subagent', status: 'running', description: 'Count etc' })
    expect(ev?.backgroundTasks[1].description).toHaveLength(120)
    expect(ev?.backgroundTasks).toHaveLength(9)  // the first ten raw entries, minus the junk one
    expect(ev?.backgroundTasks.every((t: any) => Object.keys(t).sort().join() === 'description,id,status,type')).toBe(true)
    // A reply over 2000 characters is clamped here too
    expect(runHook({ ...captured(C), hook_event_name: 'Stop', last_assistant_message: 'r'.repeat(5000) })?.text).toHaveLength(2000)
  })

  it('PermissionRequest Write -> session_needs_you {kind: permission, toolName, summary: the file name, callKey}', () => {
    expect(runHook({
      ...captured('4a9dd43b-f941-406a-809a-01149a62b597'),
      prompt_id: '273fe3a9-5b8d-4724-bb83-0c5e06bca880',
      permission_mode: 'default',
      effort: { level: 'medium' },
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: `${HOOKCAP}/probe.txt`, content: 'hello' },
      permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    })).toEqual({
      type: 'session_needs_you', kind: 'permission', toolName: 'Write', summary: 'probe.txt',
      callKey: callKeyOf('Write', { file_path: `${HOOKCAP}/probe.txt`, content: 'hello' }),
      promptId: '273fe3a9-5b8d-4724-bb83-0c5e06bca880', ...forwarded('4a9dd43b-f941-406a-809a-01149a62b597'),
    })
  })

  it('PermissionRequest Bash -> the first 80 characters of the command; other tools -> the tool name; inside a subagent -> agentId', () => {
    // Shapes from the hooks reference (only Write was captured)
    const base = { ...captured(C), prompt_id: 'p', permission_mode: 'default', hook_event_name: 'PermissionRequest' }
    const long = 'rm -rf node_modules && ' + 'echo again && '.repeat(20)
    expect(runHook({ ...base, tool_name: 'Bash', tool_input: { command: long, description: 'Remove node_modules directory' } }))
      .toMatchObject({ kind: 'permission', toolName: 'Bash', summary: long.slice(0, 80) })
    expect(runHook({ ...base, tool_name: 'Bash', tool_input: { command: 'rm -rf\n  node_modules' } })?.summary).toBe('rm -rf node_modules')
    expect(runHook({ ...base, tool_name: 'Edit', tool_input: { file_path: '/repo/src/App.tsx', old_string: 'a', new_string: 'b' } })?.summary).toBe('App.tsx')
    expect(runHook({ ...base, tool_name: 'mcp__github__create_pull_request', tool_input: { title: 'x' } }))
      .toMatchObject({ toolName: 'mcp__github__create_pull_request', summary: 'mcp__github__create_pull_request' })
    expect(runHook({ ...base, tool_name: 'WebFetch', tool_input: null })?.summary).toBe('WebFetch')
    // Raised inside a subagent (schema-only, not captured): the worker is named as well
    expect(runHook({ ...base, agent_id: 'ac5ff55b850b4fecf', agent_type: 'general-purpose', tool_name: 'Write', tool_input: { file_path: '/x/y.txt', content: '' } }))
      .toMatchObject({ kind: 'permission', toolName: 'Write', summary: 'y.txt', agentId: 'ac5ff55b850b4fecf' })
  })

  it('Notification permission_prompt (interactive, ~6 s after PermissionRequest) -> session_needs_you {kind: permission, notificationType, message}', () => {
    expect(runHook({
      ...captured('19616213-277c-4e70-9909-9883230a3394'),
      prompt_id: 'a7c849b6-361e-4cf8-84c8-7f387f16fafc',
      hook_event_name: 'Notification',
      message: 'Claude needs your permission',
      notification_type: 'permission_prompt',
    })).toEqual({
      type: 'session_needs_you', kind: 'permission', notificationType: 'permission_prompt', message: 'Claude needs your permission',
      promptId: 'a7c849b6-361e-4cf8-84c8-7f387f16fafc', ...forwarded('19616213-277c-4e70-9909-9883230a3394'),
    })
  })

  it('Notification idle_prompt / quota_auto_resume_* / agent_needs_input -> idle / quota / agent-input; every other type -> nothing', () => {
    // Types from the binary's string table and the hooks reference (only permission_prompt was captured)
    const base = { ...captured(C), prompt_id: 'p', hook_event_name: 'Notification' }
    const kindOf = (notification_type: string, message = 'msg') => runHook({ ...base, notification_type, message })?.kind ?? null
    expect(kindOf('idle_prompt', 'Claude is waiting for your input')).toBe('idle')
    expect(kindOf('quota_auto_resume_fired')).toBe('quota')
    expect(kindOf('quota_auto_resume_stale')).toBe('quota')
    expect(kindOf('quota_auto_resume_disabled')).toBe('quota')
    expect(kindOf('agent_needs_input')).toBe('agent-input')
    for (const ignored of ['auth_success', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_completed', 'worker_permission_prompt', 'push_notification', 'model_refusal_fallback', 'plugin_notification', '']) {
      expect(kindOf(ignored), ignored).toBeNull()
    }
    expect(runHook({ ...base, notification_type: 'idle_prompt', message: 'm'.repeat(500) })?.message).toHaveLength(200)
  })

  it('StopFailure -> session_error {error, detail} (shape from the hooks reference; never fired locally)', () => {
    expect(runHook({
      ...captured(C), prompt_id: 'p', hook_event_name: 'StopFailure',
      error: 'rate_limit', error_details: '429 Too Many Requests', last_assistant_message: 'API Error: Rate limit reached',
    })).toEqual({ type: 'session_error', error: 'rate_limit', detail: '429 Too Many Requests', promptId: 'p', ...forwarded(C) })
    // Without details the rendered error text is the detail; without either, an empty one
    expect(runHook({ ...captured(C), hook_event_name: 'StopFailure', error: 'overloaded', last_assistant_message: 'API Error: Overloaded' }))
      .toMatchObject({ error: 'overloaded', detail: 'API Error: Overloaded' })
    expect(runHook({ ...captured(C), hook_event_name: 'StopFailure' })).toMatchObject({ error: 'unknown', detail: '' })
    expect(runHook({ ...captured(C), hook_event_name: 'StopFailure', error: 'server_error', error_details: 'd'.repeat(500) })?.detail).toHaveLength(200)
  })

  it('PreCompact -> session_compact pre; PostCompact -> post, and the summary text stays behind', () => {
    expect(runHook({
      ...captured(C), prompt_id: 'e40b57ac-50aa-4bae-a043-8852cc9ba9c7', hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null,
    })).toEqual({ type: 'session_compact', phase: 'pre', trigger: 'manual', promptId: 'e40b57ac-50aa-4bae-a043-8852cc9ba9c7', ...forwarded(C) })

    const ev = runHook({
      ...captured(C), prompt_id: 'e40b57ac-50aa-4bae-a043-8852cc9ba9c7', hook_event_name: 'PostCompact', trigger: 'manual',
      compact_summary: '<analysis>\nThe conversation has three parts. The user first asked for two subagents: a background general-purpose agent described as "Count etc" to run `ls /etc | wc -l`, and a foreground Explore agent described as "Find hostname" to read `/etc/hostname`. ...',
    })
    expect(ev).toEqual({ type: 'session_compact', phase: 'post', trigger: 'manual', promptId: 'e40b57ac-50aa-4bae-a043-8852cc9ba9c7', ...forwarded(C) })
    expect(JSON.stringify(ev)).not.toContain('Count etc')
    expect(runHook({ ...captured(C), hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null })).toMatchObject({ phase: 'pre', trigger: 'auto' })
  })

  it('PostToolBatch on the main thread -> session_tool_done {batch, count}; inside a worker -> the same with its agentId (it answers only that worker\'s dialog)', () => {
    // Captured: the batch that launched the background and the foreground agent (session c25c5511)
    expect(runHook({
      ...captured(C), prompt_id: '60d87662-ef42-4452-a6bd-cd9718825c5b', permission_mode: 'bypassPermissions', effort: { level: 'medium' },
      hook_event_name: 'PostToolBatch',
      tool_calls: [
        { tool_name: 'Agent', tool_input: { description: 'Count etc', prompt: 'Run ls /etc | wc -l with Bash and report it.', subagent_type: 'general-purpose', run_in_background: true }, tool_use_id: 'toolu_01BqtWPXox4wWP2tR2CS8jVE', tool_response: [{ type: 'text', text: 'Async agent launched successfully. ...' }] },
        { tool_name: 'Agent', tool_input: { description: 'Find hostname', prompt: 'Read /etc/hostname and report it.', subagent_type: 'Explore', run_in_background: false }, tool_use_id: 'toolu_01GxFiqPkJRKxd5Qkyus2tLN', tool_response: [{ type: 'text', text: '[Subagent hand-back] ...' }] },
      ],
    })).toEqual({ type: 'session_tool_done', batch: true, count: 2, promptId: '60d87662-ef42-4452-a6bd-cd9718825c5b', ...forwarded(C) })
    // The denied Write's batch in a headless session (captured, session 4a9dd43b): one call, answered "you haven't granted it yet"
    expect(runHook({
      ...captured('4a9dd43b-f941-406a-809a-01149a62b597'), prompt_id: '273fe3a9-5b8d-4724-bb83-0c5e06bca880', permission_mode: 'default', effort: { level: 'medium' },
      hook_event_name: 'PostToolBatch',
      tool_calls: [{ tool_name: 'Write', tool_input: { file_path: `${HOOKCAP}/probe.txt`, content: 'hello' }, tool_use_id: 'toolu_01W', tool_response: `Claude requested permissions to write to ${HOOKCAP}/probe.txt, but you haven't granted it yet.` }],
    })).toMatchObject({ type: 'session_tool_done', batch: true, count: 1 })
    // Inside a subagent (captured shape: agent_id + agent_type on the batch)
    expect(runHook({
      ...captured(C), prompt_id: 'p', permission_mode: 'bypassPermissions', agent_id: 'a027f376ae8cdcbd0', agent_type: 'Explore', effort: { level: 'medium' },
      hook_event_name: 'PostToolBatch',
      tool_calls: [{ tool_name: 'Read', tool_input: { file_path: '/etc/hostname' }, tool_use_id: 'toolu_01XaBQyUGgXLSCM8GdEpBHFk', tool_response: '1\tvm\n2\t' }],
    })).toEqual({ type: 'session_tool_done', batch: true, count: 1, agentId: 'a027f376ae8cdcbd0', promptId: 'p', ...forwarded(C) })
    expect(runHook({ ...captured(C), hook_event_name: 'PostToolBatch' })).toMatchObject({ type: 'session_tool_done', batch: true, count: 0 })
  })

  it('CwdChanged -> session_cwd with the new cwd and project (the payload\'s own cwd is still the old one)', () => {
    expect(runHook({
      ...captured('7d77f597-b547-42f9-823a-50fc2ecdbf3b'), prompt_id: 'd66959d4-65e0-4b8b-8b59-3e2796c5fb1a', hook_event_name: 'CwdChanged',
      old_cwd: HOOKCAP, new_cwd: '/tmp',
    })).toEqual({
      type: 'session_cwd', cwd: '/tmp', project: 'tmp', oldCwd: HOOKCAP, promptId: 'd66959d4-65e0-4b8b-8b59-3e2796c5fb1a',
      sessionId: '7d77f597-b547-42f9-823a-50fc2ecdbf3b', transcriptPath: `${PROJECTS}/7d77f597-b547-42f9-823a-50fc2ecdbf3b.jsonl`,
    })
    expect(runHook({ ...captured(C), hook_event_name: 'CwdChanged', old_cwd: HOOKCAP, new_cwd: '/' })).toMatchObject({ cwd: '/', project: '/' })
    expect(runHook({ ...captured(C), hook_event_name: 'CwdChanged', old_cwd: HOOKCAP })).toBeNull()
  })

  it('PostModelSwitch -> session_model {model, fromModel, switchSource} (shape from the schema; never fired locally)', () => {
    expect(runHook({
      ...captured(C), prompt_id: 'p', hook_event_name: 'PostModelSwitch',
      from_model: 'claude-haiku-5-5', to_model: 'claude-opus-4-1', requested_model: 'opus', source: 'command', context_tokens: 44052, prompt_cache_warm: true, cache_ttl: '5m',
    })).toEqual({ type: 'session_model', model: 'claude-opus-4-1', fromModel: 'claude-haiku-5-5', switchSource: 'command', promptId: 'p', ...forwarded(C) })
    expect(runHook({ ...captured(C), hook_event_name: 'PostModelSwitch', to_model: 'claude-sonnet-4-5', source: 'auto' })).toMatchObject({ model: 'claude-sonnet-4-5', switchSource: 'auto' })
    expect(runHook({ ...captured(C), hook_event_name: 'PostModelSwitch', from_model: 'x' })).toBeNull()
  })

  it('Setup and InstructionsLoaded -> nothing, like every other event the office does not listen to', () => {
    expect(runHook({ ...captured('149f6824-9a0a-4031-beff-0864614b9005'), hook_event_name: 'Setup', trigger: 'init' })).toBeNull()
    expect(runHook({ ...captured('10690f0a-fe94-4e15-9a2d-b59573025579'), hook_event_name: 'Setup', trigger: 'maintenance' })).toBeNull()
    expect(runHook({
      ...captured('7d77f597-b547-42f9-823a-50fc2ecdbf3b'), hook_event_name: 'InstructionsLoaded',
      file_path: `${HOOKCAP}/CLAUDE.md`, memory_type: 'Project', load_reason: 'session_start',
    })).toBeNull()
    for (const hook_event_name of ['MessageDisplay', 'ConfigChange', 'UserPromptExpansion', 'PreModelSwitch', 'PermissionDenied', 'TeammateIdle', 'Elicitation', 'ElicitationResult', 'WorktreeCreate', 'WorktreeRemove', 'FileChanged', 'DirectoryAdded']) {
      expect(runHook({ ...captured(C), prompt_id: 'p', hook_event_name }), hook_event_name).toBeNull()
    }
  })

  it('TaskCreated / TaskCompleted -> task_created / task_completed {taskId, subject} (the docs\' shape; never fired locally), the description left behind', () => {
    // The hooks reference's own example payloads, team fields and all
    const example = { task_id: 'task-001', task_subject: 'Implement user authentication', task_description: 'Add login and signup endpoints', teammate_name: 'implementer', team_name: 'session-a1b2c3d4' }
    expect(runHook({ ...captured(C), hook_event_name: 'TaskCreated', ...example }))
      .toEqual({ type: 'task_created', taskId: 'task-001', subject: 'Implement user authentication', ...forwarded(C) })
    expect(runHook({ ...captured(C), permission_mode: 'default', hook_event_name: 'TaskCompleted', ...example }))
      .toEqual({ type: 'task_completed', taskId: 'task-001', subject: 'Implement user authentication', ...forwarded(C) })
    // The ids Claude Code writes on disk are small integers as strings; a prompt id rides along like on every turn event
    expect(runHook({ ...captured(C), prompt_id: 'p', hook_event_name: 'TaskCreated', task_id: '3', task_subject: 'Fix the parser' }))
      .toEqual({ type: 'task_created', taskId: '3', subject: 'Fix the parser', promptId: 'p', ...forwarded(C) })
  })

  it('TaskCreated / TaskCompleted clamp the subject to one 120-char line, take a numeric id, and need a task id and a session', () => {
    const long = runHook({ ...captured(C), hook_event_name: 'TaskCreated', task_id: 7, task_subject: `Fix\n  the   parser ${'x'.repeat(300)}` })
    expect(long).toMatchObject({ type: 'task_created', taskId: '7' })
    expect(long!.subject).toHaveLength(120)
    expect(long!.subject.startsWith('Fix the parser x')).toBe(true)
    expect(runHook({ ...captured(C), hook_event_name: 'TaskCompleted', task_id: '1' })).toEqual({ type: 'task_completed', taskId: '1', subject: '', ...forwarded(C) })
    expect(runHook({ ...captured(C), hook_event_name: 'TaskCreated', task_subject: 'no id' })).toBeNull()
    expect(runHook({ ...captured(C), hook_event_name: 'TaskCompleted', task_id: '', task_subject: 'empty id' })).toBeNull()
    expect(runHook({ hook_event_name: 'TaskCreated', task_id: '1', task_subject: 'no session' })).toBeNull()
  })

  it('every main-thread event without a session id prints nothing', () => {
    for (const payload of [
      { hook_event_name: 'UserPromptSubmit', prompt: 'hello', prompt_id: 'p' },
      { hook_event_name: 'Stop', last_assistant_message: 'x', background_tasks: [], session_crons: [] },
      { hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: '/x' } },
      { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'm' },
      { hook_event_name: 'StopFailure', error: 'rate_limit' },
      { hook_event_name: 'PreCompact', trigger: 'manual' },
      { hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 's' },
      { hook_event_name: 'PostToolBatch', tool_calls: [] },
      { hook_event_name: 'CwdChanged', old_cwd: '/a', new_cwd: '/b' },
      { hook_event_name: 'PostModelSwitch', from_model: 'a', to_model: 'b', source: 'command' },
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: 'ok' },
    ]) {
      expect(runHook(payload), payload.hook_event_name).toBeNull()
    }
  })
})

/** A request the fake office received. */
type Hit = { method: string; url: string; auth?: string; ts?: string; sig?: string; body: string; headers: IncomingHttpHeaders }

/** A fake office: `plan` answers each request in order of arrival (POST /event first, then the polls). */
async function fakeOffice(plan: Array<(hit: Hit, res: ServerResponse, hits: Hit[]) => void>) {
  const hits: Hit[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const hit = {
        method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization,
        ts: req.headers['x-office-timestamp'] as string | undefined,
        sig: req.headers['x-office-signature'] as string | undefined,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: req.headers,
      }
      hits.push(hit)
      const step = plan[hits.length - 1] ?? plan[plan.length - 1]
      step(hit, res, hits)
    })
  })
  await new Promise<void>(res => server.listen(0, '127.0.0.1', () => res()))
  const port = (server.address() as AddressInfo).port
  return { port, hits, close: () => new Promise<void>(res => { server.closeAllConnections(); server.close(() => res()) }) }
}
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * The hook as Claude Code starts it: `node agent-tracker.mjs`, the payload on
 * stdin. Spawned asynchronously: the fake office lives on this event loop, so
 * a synchronous spawn would starve it and every request would time out.
 */
function spawnHook(payload: unknown, env: Record<string, string | undefined>) {
  const started = Date.now()
  return new Promise<{ stdout: string; stderr: string; status: number | null; ms: number }>((resolve, reject) => {
    const child = spawn(process.execPath, [TRACKER], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', c => { stdout += c })
    child.stderr.setEncoding('utf8').on('data', c => { stderr += c })
    child.on('error', reject)
    child.on('close', status => resolve({ stdout, stderr, status, ms: Date.now() - started }))
    child.stdin.on('error', () => { /* the hook may exit before it has read everything */ })
    child.stdin.end(payload instanceof Uint8Array || typeof payload === 'string' ? payload : JSON.stringify(payload))
  })
}

/**
 * The whole hook, against a fake office. The payload reaches the hook on
 * stdin, stdout stays empty (on UserPromptSubmit it would be injected into
 * Claude's context), the exit code is 0, and the event leaves as one JSON body
 * in a POST that is signed with the token (the token itself never travels).
 */
describe('agent-tracker.mjs: the hook process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-office-tracker-'))
  const officeHome = join(dir, 'office')
  mkdirSync(officeHome)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  /** Run the hook on a payload against a fake office that says {ok}; resolve with its stdout/status and what the office was sent. */
  async function runScript(payload: unknown, extraEnv: Record<string, string> | ((port: number) => Record<string, string>) = {}) {
    const office = await fakeOffice([(hit, res) => json(res, 200, { ok: true })])
    try {
      const env: Record<string, string | undefined> = { ...process.env, AGENT_OFFICE_HOME: officeHome, AGENT_OFFICE_PORT: String(office.port) }
      // The caller's own office settings must not leak into the hook under test
      delete env.AGENT_OFFICE_EVENT_URL
      Object.assign(env, typeof extraEnv === 'function' ? extraEnv(office.port) : extraEnv)
      const res = await spawnHook(payload, env)
      const calls = office.hits
      const hit = calls[0]
      return { ...res, calls, hit, body: hit ? JSON.parse(hit.body) : null }
    } finally {
      await office.close()
    }
  }

  const session = { session_id: 's-wrap', cwd: '/home/me/proj', transcript_path: '/t/s-wrap.jsonl' }

  it('UserPromptSubmit: nothing on stdout, exit 0, the session_prompt goes to the office as one JSON body in a POST to /event', async () => {
    const run = await runScript({ ...session, prompt_id: 'p1', hook_event_name: 'UserPromptSubmit', prompt: 'fix the bug' })
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe('')
    expect(run.calls).toHaveLength(1)
    expect(run.hit).toMatchObject({ method: 'POST', url: '/event' })
    expect(run.hit.headers['content-type']).toBe('application/json')
    expect(run.body).toEqual({ type: 'session_prompt', text: 'fix the bug', isWakeup: false, promptId: 'p1', sessionId: 's-wrap', project: 'proj', cwd: '/home/me/proj', transcriptPath: '/t/s-wrap.jsonl' })
    // No token file: nothing to sign with, and never an Authorization header
    expect(run.hit.auth).toBeUndefined()
    expect(run.hit.sig).toBeUndefined()
    expect(run.hit.ts).toBeUndefined()
  })

  it('a 300 KB tool_response reaches the hook (stdin) and leaves as a 120-char result', async () => {
    const run = await runScript({
      ...session, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_BIG',
      tool_input: { description: 'Read everything', subagent_type: 'general-purpose' },
      tool_response: { status: 'completed', content: [{ type: 'text', text: 'x'.repeat(300_000) }] },
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe('')
    expect(run.body).toMatchObject({ type: 'agent_completed', agentId: 'agent-toolu_BIG', sessionId: 's-wrap' })
    expect(run.body.result).toHaveLength(120)
  })

  it('TaskCreated: nothing on stdout (which could veto the task), exit 0, the task_created goes to the office', async () => {
    const run = await runScript({ ...session, hook_event_name: 'TaskCreated', task_id: '4', task_subject: 'Write the board', task_description: 'Post-its on the whiteboard' })
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe('')
    expect(run.calls).toHaveLength(1)
    expect(run.body).toEqual({ type: 'task_created', taskId: '4', subject: 'Write the board', sessionId: 's-wrap', project: 'proj', cwd: '/home/me/proj', transcriptPath: '/t/s-wrap.jsonl' })
    expect(JSON.stringify(run.body)).not.toContain('Post-its on the whiteboard')
  })

  it('with a token file it SIGNS the request (X-Office-Timestamp/Signature over the raw body) and the token is nowhere in the request; an ignored event sends nothing', async () => {
    const token = 'a'.repeat(64)
    writeFileSync(join(officeHome, 'auth-token'), token + '\n')
    try {
      const run = await runScript({ ...session, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x/y.js' } })
      expect(run.status).toBe(0)
      const { hit } = run
      // The token is nowhere on the wire, and no Authorization header
      expect(hit.auth).toBeUndefined()
      expect(JSON.stringify(hit.headers) + hit.body).not.toContain(token)
      // It is signed instead: a timestamp and the HMAC over METHOD, path, timestamp and the raw body
      expect(hit.ts).toMatch(/^\d+$/)
      expect(Math.abs(Date.now() - Number(hit.ts))).toBeLessThan(60_000)
      expect(hit.sig).toMatch(/^[0-9a-f]{64}$/)
      expect(hit.sig).toBe(createHmac('sha256', token).update(`POST\n/event\n${hit.ts}\n${hit.body}`).digest('hex'))
      expect(run.body).toMatchObject({ type: 'agent_working', status: 'reading y.js' })

      const quiet = await runScript({ ...session, hook_event_name: 'Setup', trigger: 'init' })
      expect(quiet.status).toBe(0)
      expect(quiet.stdout).toBe('')
      expect(quiet.calls).toEqual([])
    } finally {
      rmSync(join(officeHome, 'auth-token'), { force: true })
    }
  })

  it('posts to AGENT_OFFICE_EVENT_URL when set, else to 127.0.0.1:$AGENT_OFFICE_PORT/event, else to port 3334', async () => {
    const read = { ...session, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x/y.js' } }
    expect((await runScript(read)).hit.url).toBe('/event')
    // The override wins over the port
    expect((await runScript(read, port => ({ AGENT_OFFICE_PORT: '1', AGENT_OFFICE_EVENT_URL: `http://127.0.0.1:${port}/custom/event` }))).hit.url).toBe('/custom/event')
    // The default host is pinned to 127.0.0.1, not 'localhost' (no IPv6 ::1 squatter)
    expect(officeUrl('/event', undefined, {})).toBe('http://127.0.0.1:3334/event')
    expect(officeUrl('/event', undefined, { AGENT_OFFICE_PORT: '3998' })).toBe('http://127.0.0.1:3998/event')
  })

  it('a deploy: the signals ride on the one JSON body the call sends, stdout stays empty, exit 0', async () => {
    const run = await runScript({ ...session, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'vercel deploy --prod' } })
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe('')
    expect(run.calls).toHaveLength(1)
    expect(run.body).toMatchObject({
      type: 'agent_working', status: 'running: vercel deploy --prod', sessionId: 's-wrap',
      signals: [{ kind: 'deploy_start', target: 'proj', command: 'vercel deploy --prod' }],
    })
  })

  it('never prints and never fails: no office, a payload that is not UTF-8 or not JSON, an office that answers garbage', async () => {
    const probe = await fakeOffice([])
    const deadPort = probe.port
    await probe.close()
    const env = { ...process.env, AGENT_OFFICE_HOME: officeHome, AGENT_OFFICE_PORT: String(deadPort) }
    delete env.AGENT_OFFICE_EVENT_URL
    const prompt = { ...session, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }
    for (const input of [prompt, '{"prompt": "é"', Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), '', 'not json']) {
      const run = await spawnHook(input, env)
      expect(run.status).toBe(0)
      expect(run.stdout).toBe('')
      expect(run.stderr).toBe('')
    }
    const odd = await fakeOffice([(hit, res) => { res.writeHead(500); res.end('<html>boom</html>') }])
    try {
      const run = await spawnHook(prompt, { ...env, AGENT_OFFICE_PORT: String(odd.port) })
      expect(run.status).toBe(0)
      expect(run.stdout).toBe('')
      expect(odd.hits).toHaveLength(1)
    } finally {
      await odd.close()
    }
  })
})

/**
 * Answering a permission dialog from the office (server/permissions.js). With
 * the marker file present the hook adds answerable / permissionMode /
 * suggestions / detail / nonce and a second `wait` line; the hook then POSTs
 * in the foreground and long-polls GET /permission/<id>
 * against a tiny Node server. It builds the hook output ITSELF from the
 * server's decision word, but only after verifying the proof
 * HMAC(token, nonce + permissionId + decision) — so a wrong, missing or
 * replayed proof, or any server-supplied JSON, prints nothing. Without the
 * marker nothing changes.
 */
describe('agent-tracker.mjs: answering a permission from the office', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-office-answer-'))
  const TOKEN = 'office-token'
  writeFileSync(join(home, 'answer-permissions'), 'on\n')
  writeFileSync(join(home, 'auth-token'), TOKEN + '\n')
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  /** The proof the office returns to prove it holds the token (as server/index.js computes it). */
  const proofFor = (nonce: string, id: string, decision: string) =>
    createHmac('sha256', TOKEN).update(`${nonce}${id}${decision}`).digest('hex')

  const session = { session_id: 's-perm', cwd: '/home/me/proj', transcript_path: '/t/s-perm.jsonl', prompt_id: 'p1', permission_mode: 'default' }
  const SUGGESTIONS = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
  const write = { ...session, hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: '/home/me/proj/probe.txt', content: 'hello' }, permission_suggestions: SUGGESTIONS }
  const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
  const ALLOW_REMEMBER = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: SUGGESTIONS } } }
  const DENY = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from Claude Office', interrupt: false } } }

  it('the event: with the marker the event gains answerable, permissionMode, suggestions, detail and a nonce, and a `wait` line follows; without it, the event is as before on one line', () => {
    const lines = runHookLines(write, { AGENT_OFFICE_HOME: home })
    expect(lines).toHaveLength(2)
    const callKey = callKeyOf('Write', write.tool_input)
    expect(JSON.parse(lines[0])).toEqual({
      type: 'session_needs_you', kind: 'permission', toolName: 'Write', summary: 'probe.txt', callKey,
      answerable: true, permissionMode: 'default', suggestions: SUGGESTIONS, detail: '/home/me/proj/probe.txt',
      nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
      promptId: 'p1', sessionId: 's-perm', project: 'proj', cwd: '/home/me/proj', transcriptPath: '/t/s-perm.jsonl',
    })
    expect(lines[1]).toBe('wait')

    const plain = runHookLines(write)
    expect(plain).toHaveLength(1)
    expect(JSON.parse(plain[0])).toEqual({
      type: 'session_needs_you', kind: 'permission', toolName: 'Write', summary: 'probe.txt', callKey,
      promptId: 'p1', sessionId: 's-perm', project: 'proj', cwd: '/home/me/proj', transcriptPath: '/t/s-perm.jsonl',
    })
    // No session id: nothing at all, marker or not
    expect(runHookLines({ ...write, session_id: undefined }, { AGENT_OFFICE_HOME: home })).toEqual([])
    // Only PermissionRequest ever gets the second line
    expect(runHookLines({ ...session, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'm' }, { AGENT_OFFICE_HOME: home })).toHaveLength(1)
    expect(runHookLines({ ...session, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/x' } }, { AGENT_OFFICE_HOME: home })).toHaveLength(1)
  })

  it('the event: detail is the Bash command (newlines kept), the file path of a file tool, else the tool input as compact JSON, clamped to 400; suggestions keep their shape, at most 4', () => {
    const ev = (payload: unknown) => JSON.parse(runHookLines(payload, { AGENT_OFFICE_HOME: home })[0])
    const base = { ...session, hook_event_name: 'PermissionRequest' }
    expect(ev({ ...base, tool_name: 'Bash', tool_input: { command: 'rm -rf\n  node_modules', description: 'd' } })).toMatchObject({ summary: 'rm -rf node_modules', detail: 'rm -rf\n  node_modules' })
    expect(ev({ ...base, tool_name: 'Bash', tool_input: { command: 'x'.repeat(1000) } }).detail).toHaveLength(400)
    expect(ev({ ...base, tool_name: 'Edit', tool_input: { file_path: '/repo/src/App.tsx', old_string: 'a', new_string: 'b' } }).detail).toBe('/repo/src/App.tsx')
    expect(ev({ ...base, tool_name: 'NotebookEdit', tool_input: { notebook_path: '/n.ipynb' } }).detail).toBe('/n.ipynb')
    expect(ev({ ...base, tool_name: 'WebFetch', tool_input: { url: 'https://x.test', prompt: 'read it' } }).detail).toBe('{"url":"https://x.test","prompt":"read it"}')
    expect(ev({ ...base, tool_name: 'WebFetch', tool_input: null })).toMatchObject({ detail: '{}', suggestions: [], permissionMode: 'default' })
    const addRules = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }
    expect(ev({ ...base, tool_name: 'Bash', tool_input: { command: 'npm test' }, permission_suggestions: [addRules, 'junk', ...new Array(6).fill(SUGGESTIONS[0])] }).suggestions)
      .toEqual([addRules, SUGGESTIONS[0], SUGGESTIONS[0], SUGGESTIONS[0]])
    expect(ev({ ...base, tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [{ mode: 'm'.repeat(500) }] }).suggestions[0].mode).toHaveLength(200)
    expect(ev({ ...base, tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'acceptEdits' }).permissionMode).toBe('acceptEdits')
  })

  /** The nonce the hook put in the POST /event body (for building a valid proof in the poll reply). */
  const nonceOf = (hits: Hit[]) => JSON.parse(hits[0].body).nonce as string

  /** The hook as Claude Code starts it, pointed at the fake office. */
  function runLive(payload: unknown, port: number, extraEnv: Record<string, string> = {}) {
    const env: Record<string, string | undefined> = { ...process.env, AGENT_OFFICE_HOME: home, AGENT_OFFICE_PORT: String(port) }
    delete env.AGENT_OFFICE_EVENT_URL
    Object.assign(env, extraEnv)
    return spawnHook(payload, env)
  }

  it('allowed: the POST and the poll are signed (no Authorization, no token on the wire), the office proves the token, and the hook builds the allow output itself', async () => {
    const office = await fakeOffice([
      (hit, res) => json(res, 200, { ok: true, permissionId: 'abc123', wait: { pollMs: 2000, deadline: Date.now() + 60_000 } }),
      (hit, res, hits) => json(res, 200, { status: 'allowed', decision: 'allow', proof: proofFor(nonceOf(hits), 'abc123', 'allow'), deadline: Date.now() + 60_000 }),
    ])
    try {
      const run = await runLive(write, office.port)
      expect(run.status).toBe(0)
      expect(run.stderr).toBe('')
      expect(JSON.parse(run.stdout)).toEqual(ALLOW)
      expect(run.stdout.trim().split('\n')).toHaveLength(1)
      expect(office.hits.map(h => [h.method, h.url])).toEqual([['POST', '/event'], ['GET', '/permission/abc123?wait=2']])
      // The token never travels: no Authorization header, both requests signed
      expect(office.hits.every(h => h.auth === undefined)).toBe(true)
      expect(office.hits.every(h => /^\d+$/.test(h.ts ?? '') && /^[0-9a-f]{64}$/.test(h.sig ?? ''))).toBe(true)
      expect(JSON.parse(office.hits[0].body)).toMatchObject({ type: 'session_needs_you', answerable: true, suggestions: SUGGESTIONS, nonce: expect.stringMatching(/^[0-9a-f]{32}$/) })
    } finally {
      await office.close()
    }
  })

  it('allow-remember: the hook echoes only the dialog’s own permission_suggestions as updatedPermissions', async () => {
    const office = await fakeOffice([
      (hit, res) => json(res, 200, { ok: true, permissionId: 'ar1', wait: { pollMs: 1000, deadline: Date.now() + 60_000 } }),
      (hit, res, hits) => json(res, 200, { status: 'allowed', decision: 'allow-remember', proof: proofFor(nonceOf(hits), 'ar1', 'allow-remember'), deadline: Date.now() + 60_000 }),
    ])
    try {
      const run = await runLive(write, office.port)
      expect(run.status).toBe(0)
      expect(JSON.parse(run.stdout)).toEqual(ALLOW_REMEMBER)
      // Never an updatedInput, whatever the server says
      expect(run.stdout).not.toContain('updatedInput')
    } finally {
      await office.close()
    }
  })

  it('keeps polling while the server says pending (the deadline may move) and builds a deny once the office proves the token', async () => {
    const office = await fakeOffice([
      (hit, res) => json(res, 200, { ok: true, permissionId: 'p2', wait: { pollMs: 1000, deadline: Date.now() + 60_000 } }),
      (hit, res) => json(res, 200, { status: 'pending', deadline: Date.now() + 60_000 }),
      (hit, res) => json(res, 200, { status: 'pending', deadline: Date.now() + 600_000 }),
      (hit, res, hits) => json(res, 200, { status: 'denied', decision: 'deny', proof: proofFor(nonceOf(hits), 'p2', 'deny'), deadline: Date.now() + 600_000 }),
    ])
    try {
      const run = await runLive(write, office.port)
      expect(run.status).toBe(0)
      expect(JSON.parse(run.stdout)).toEqual(DENY)
      expect(office.hits).toHaveLength(4)
      expect(office.hits.slice(1).every(h => h.url === '/permission/p2?wait=1')).toBe(true)
    } finally {
      await office.close()
    }
  })

  it('a decided answer with a bad, missing or replayed proof, or server-supplied JSON, prints nothing', async () => {
    const attacks: Array<(hits: Hit[]) => object> = [
      // Arbitrary hookOutput the server has no business supplying — ignored
      () => ({ status: 'allowed', decision: 'allow', proof: 'f'.repeat(64), hookOutput: ALLOW, deadline: Date.now() + 60_000 }),
      // An updatedInput smuggled alongside a wrong proof — never printed
      () => ({ status: 'allowed', decision: 'allow', proof: '0'.repeat(64), hookOutput: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { command: 'rm -rf /' } } } }, deadline: Date.now() + 60_000 }),
      // No proof at all
      () => ({ status: 'allowed', decision: 'allow', deadline: Date.now() + 60_000 }),
      // A proof over a DIFFERENT decision (replay of an allow trying to pass as allow-remember)
      hits => ({ status: 'allowed', decision: 'allow-remember', proof: proofFor(nonceOf(hits), 'pX', 'allow'), deadline: Date.now() + 60_000 }),
      // A proof computed with the wrong nonce
      () => ({ status: 'allowed', decision: 'allow', proof: proofFor('deadbeef', 'pX', 'allow'), deadline: Date.now() + 60_000 }),
    ]
    for (const attack of attacks) {
      const office = await fakeOffice([
        (hit, res) => json(res, 200, { ok: true, permissionId: 'pX', wait: { pollMs: 1000, deadline: Date.now() + 60_000 } }),
        (hit, res, hits) => json(res, 200, attack(hits)),
      ])
      try {
        const run = await runLive(write, office.port)
        expect(run.status).toBe(0)
        expect(run.stdout).toBe('')
        expect(run.stderr).toBe('')
      } finally {
        await office.close()
      }
    }
  })

  it('prints nothing on resolved_elsewhere, expired, a 404, a pending answer past the deadline, or a reply without a permissionId', async () => {
    for (const second of [
      (hit: Hit, res: import('node:http').ServerResponse) => json(res, 200, { status: 'resolved_elsewhere', deadline: Date.now() + 60_000 }),
      (hit: Hit, res: import('node:http').ServerResponse) => json(res, 200, { status: 'expired', deadline: Date.now() - 1 }),
      (hit: Hit, res: import('node:http').ServerResponse) => json(res, 404, { error: 'Unknown permission' }),
      (hit: Hit, res: import('node:http').ServerResponse) => json(res, 200, { status: 'pending', deadline: Date.now() - 5_000 }),
    ]) {
      const office = await fakeOffice([
        (hit, res) => json(res, 200, { ok: true, permissionId: 'p3', wait: { pollMs: 1000, deadline: Date.now() + 60_000 } }),
        second,
      ])
      try {
        const run = await runLive(write, office.port)
        expect(run.status).toBe(0)
        expect(run.stdout).toBe('')
        expect(run.stderr).toBe('')
        expect(office.hits).toHaveLength(2)
      } finally {
        await office.close()
      }
    }
    // An older server (or the setting off): a plain {ok} means no wait at all
    const plain = await fakeOffice([(hit, res) => json(res, 200, { ok: true })])
    try {
      const run = await runLive(write, plain.port)
      expect(run.stdout).toBe('')
      expect(plain.hits).toHaveLength(1)
    } finally {
      await plain.close()
    }
  })

  it('server down: exits 0 at once with nothing printed; without the marker a PermissionRequest never waits even with the server up', async () => {
    // Nothing listens on this port
    const probe = await fakeOffice([])
    const deadPort = probe.port
    await probe.close()
    const down = await runLive(write, deadPort)
    expect(down.status).toBe(0)
    expect(down.stdout).toBe('')
    expect(down.ms).toBeLessThan(5_000)

    // A server that never answers: with the marker gone the POST is the usual
    // one, bounded at 1 s, and the hook returns without waiting for a decision
    const noMarker = mkdtempSync(join(tmpdir(), 'agent-office-nomarker-'))
    const hanging = await fakeOffice([() => { /* never responds */ }])
    try {
      const run = await runLive(write, hanging.port, { AGENT_OFFICE_HOME: noMarker })
      expect(run.status).toBe(0)
      expect(run.stdout).toBe('')
      expect(run.ms).toBeLessThan(3_000)
    } finally {
      await hanging.close()
      rmSync(noMarker, { recursive: true, force: true })
    }
  })

  it('never blocks any other event: a PostToolUse with the marker present is bounded at 1 s even when the server hangs', async () => {
    const hanging = await fakeOffice([() => { /* never responds */ }])
    try {
      const run = await runLive({ ...session, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/x' }, tool_response: 'ok' }, hanging.port)
      expect(run.status).toBe(0)
      expect(run.stdout).toBe('')
      expect(run.ms).toBeLessThan(3_000)
      const prompt = await runLive({ ...session, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, hanging.port)
      expect(prompt.stdout).toBe('')
      expect(prompt.ms).toBeLessThan(3_000)
    } finally {
      await hanging.close()
    }
  })

  // ── The conversation, hardened: what the old Python int() and the shell wrapper did ──
  /** A fake office whose POST names permission `id` with the given `wait`, and whose polls all answer `poll`. */
  const office = (id: string, wait: unknown, ...poll: Array<(hit: Hit, res: ServerResponse, hits: Hit[]) => void>) =>
    fakeOffice([(hit, res) => json(res, 200, { ok: true, permissionId: id, wait }), ...poll])
  const expired = (hit: Hit, res: ServerResponse) => json(res, 200, { status: 'expired', deadline: Date.now() - 1 })

  it('pollMs goes through int() (floats, numeric strings, True), 0 and [] fall back to 20 s, and the wait is clamped to 1..30 s', async () => {
    const cases: Array<[unknown, number]> = [[1500.9, 1], ['2500', 2], [' 7000 ', 7], ['1_000', 1], [0, 20], [[], 20], [{}, 20], [true, 1], [-5000, 1], [29999, 29], [31000, 30], [99999999, 30]]
    for (const [pollMs, wait] of cases) {
      const o = await office('pm', { pollMs, deadline: Date.now() + 60_000 }, expired)
      try {
        const run = await runLive(write, o.port)
        expect(run.status).toBe(0)
        expect(run.stdout).toBe('')
        expect(o.hits.map(h => h.url), JSON.stringify(pollMs)).toEqual(['/event', `/permission/pm?wait=${wait}`])
      } finally {
        await o.close()
      }
    }
  })

  it('an unreadable pollMs or deadline ends the wait before the first poll (int() raised in the Python)', async () => {
    for (const wait of [{ pollMs: 'abc' }, { pollMs: [1] }, { pollMs: 1000, deadline: 'x' }, { pollMs: 1000, deadline: [1] }, { pollMs: 'Infinity' }]) {
      const o = await office('pm', wait, expired)
      try {
        const run = await runLive(write, o.port)
        expect(run.status).toBe(0)
        expect(run.stdout).toBe('')
        expect(o.hits, JSON.stringify(wait)).toHaveLength(1)
      } finally {
        await o.close()
      }
    }
  })

  it('polls at most 40 times, then gives up silently', async () => {
    const o = await office('pm', { pollMs: 1000, deadline: Date.now() + 60_000 }, (hit, res) => json(res, 200, { status: 'pending', deadline: Date.now() + 60_000 }))
    try {
      const run = await runLive(write, o.port)
      expect(run.status).toBe(0)
      expect(run.stdout).toBe('')
      expect(o.hits).toHaveLength(41)
    } finally {
      await o.close()
    }
  })

  it('a pending answer only a moment past its deadline keeps polling (2 s grace); an HTTP error ends the wait', async () => {
    const grace = await office('pm', { pollMs: 1000 },
      (hit, res) => json(res, 200, { status: 'pending', deadline: Date.now() - 1000 }),
      (hit, res) => json(res, 200, { status: 'pending', deadline: true }),
      expired)
    try {
      const run = await runLive(write, grace.port)
      expect(run.stdout).toBe('')
      // deadline `true` is the number 1 in Python (a bool is an int), so the third reply is long past due: stop there
      expect(grace.hits).toHaveLength(3)
    } finally {
      await grace.close()
    }
    for (const [post, polls] of [[500, 0], [200, 1]] as const) {
      const o = await fakeOffice([(hit, res) => (post === 200 ? json(res, 200, { ok: true, permissionId: 'pm', wait: { pollMs: 1000 } }) : json(res, post, { error: 'x' })),
        (hit, res) => json(res, 503, { status: 'allowed', decision: 'allow', proof: proofFor('x', 'pm', 'allow') })])
      try {
        const run = await runLive(write, o.port)
        expect(run.stdout).toBe('')
        expect(o.hits).toHaveLength(1 + polls)
      } finally {
        await o.close()
      }
    }
  })

  it('the permission id is percent-encoded in the poll path, the proof is over the raw id', async () => {
    const id = 'a/b?c#d e'
    const o = await office(id, { pollMs: 1000 }, (hit, res, hits) => json(res, 200, { status: 'allowed', decision: 'allow', proof: proofFor(nonceOf(hits), id, 'allow'), deadline: Date.now() + 60_000 }))
    try {
      const run = await runLive(write, o.port)
      expect(JSON.parse(run.stdout)).toEqual(ALLOW)
      expect(o.hits[1].url).toBe('/permission/a%2Fb%3Fc%23d%20e?wait=1')
    } finally {
      await o.close()
    }
  })

  it('only allow, allow-remember and deny are ever acted on, and only with the exact lowercase proof', async () => {
    const attacks: Array<(hits: Hit[]) => object> = [
      // A valid proof over a decision word the hook has no output for
      hits => ({ status: 'allowed', decision: 'allow-forever', proof: proofFor(nonceOf(hits), 'pm', 'allow-forever') }),
      hits => ({ status: 'allowed', decision: 'ALLOW', proof: proofFor(nonceOf(hits), 'pm', 'ALLOW') }),
      hits => ({ status: 'allowed', decision: ['allow'], proof: proofFor(nonceOf(hits), 'pm', 'allow') }),
      // The right proof, shouted, padded, truncated, doubled or not a string
      hits => ({ status: 'allowed', decision: 'allow', proof: proofFor(nonceOf(hits), 'pm', 'allow').toUpperCase() }),
      hits => ({ status: 'allowed', decision: 'allow', proof: ` ${proofFor(nonceOf(hits), 'pm', 'allow')}` }),
      hits => ({ status: 'allowed', decision: 'allow', proof: proofFor(nonceOf(hits), 'pm', 'allow').slice(1) }),
      hits => ({ status: 'allowed', decision: 'allow', proof: proofFor(nonceOf(hits), 'pm', 'allow').repeat(2) }),
      hits => ({ status: 'allowed', decision: 'allow', proof: [proofFor(nonceOf(hits), 'pm', 'allow')] }),
      hits => ({ status: 'allowed', decision: 'allow', proof: 'é'.repeat(32) }),
      // A proof for another permission id
      hits => ({ status: 'allowed', decision: 'allow', proof: proofFor(nonceOf(hits), 'other', 'allow') }),
      // A status that is not a string
      hits => ({ status: ['allowed'], decision: 'allow', proof: proofFor(nonceOf(hits), 'pm', 'allow') }),
    ]
    for (const attack of attacks) {
      const o = await office('pm', { pollMs: 1000 }, (hit, res, hits) => json(res, 200, attack(hits)))
      try {
        const run = await runLive(write, o.port)
        expect(run.status).toBe(0)
        expect(run.stdout).toBe('')
        expect(run.stderr).toBe('')
      } finally {
        await o.close()
      }
    }
  })

  it('without a token file nothing can be proven: the POST goes out unsigned and the answer prints nothing', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'agent-office-notoken-'))
    writeFileSync(join(bare, 'answer-permissions'), 'on\n')
    const o = await office('pm', { pollMs: 1000 }, (hit, res, hits) => json(res, 200, { status: 'allowed', decision: 'allow', proof: proofFor(nonceOf(hits), 'pm', 'allow') }))
    try {
      const run = await runLive(write, o.port, { AGENT_OFFICE_HOME: bare })
      expect(run.status).toBe(0)
      expect(run.stdout).toBe('')
      expect(o.hits[0].sig).toBeUndefined()
    } finally {
      await o.close()
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('every request is signed over its own method, path and body, and the token is on the wire in none of them', async () => {
    const o = await office('pm', { pollMs: 2000 },
      (hit, res) => json(res, 200, { status: 'pending', deadline: Date.now() + 60_000 }),
      (hit, res, hits) => json(res, 200, { status: 'denied', decision: 'deny', proof: proofFor(nonceOf(hits), 'pm', 'deny') }))
    try {
      const run = await runLive(write, o.port)
      expect(JSON.parse(run.stdout)).toEqual(DENY)
      expect(o.hits.map(h => h.method + ' ' + h.url)).toEqual(['POST /event', 'GET /permission/pm?wait=2', 'GET /permission/pm?wait=2'])
      for (const h of o.hits) {
        expect(JSON.stringify(h.headers) + h.body).not.toContain(TOKEN)
        expect(h.auth).toBeUndefined()
        expect(h.sig).toBe(createHmac('sha256', TOKEN).update(`${h.method}\n${h.url}\n${h.ts}\n${h.body}`).digest('hex'))
      }
      expect(o.hits[1].body).toBe('')
    } finally {
      await o.close()
    }
  })
})

/**
 * Signals: what a Bash command means (the "Signals" section of the hook).
 * classifyCommand is pure, so its table is driven directly: a tool-less
 * payload goes through the hook first (it must leave the classifier unloaded),
 * then the classifier is loaded the way the hook loads it (loadSignals) and
 * called. The rest drives whole payloads through the hook like every test above.
 */
describe('agent-tracker.mjs: signals', () => {
  function drive(job: Record<string, unknown>) {
    resetSignals() // the hook runs once per process; here many hooks share one
    buildEvent(JSON.stringify(job.payload ?? { tool_name: 'x' }), { ...process.env, AGENT_OFFICE_HOME: NO_MARKER_HOME })
    const loaded = signalsLoaded()
    const commands = job.commands as string[] | undefined
    if (commands !== undefined) loadSignals()
    const cwd = job.cwd as string | undefined
    return {
      classified: (commands ?? []).map(c => classifyCommand(c, cwd)) as Array<Array<Record<string, unknown>>>,
      prefilter: (commands ?? []).map(c => mightSignal(c)),
      loaded,
    }
  }

  /** command -> what classify_command returns for it (cwd /home/me/api) */
  const TABLE: Array<[string, Array<Record<string, unknown>>]> = [
    // deploy
    ['vercel deploy --prod', [{ kind: 'deploy' }]],
    ['vercel --prod', [{ kind: 'deploy' }]],
    ['netlify deploy --prod', [{ kind: 'deploy' }]],
    ['fly deploy -a shop-api', [{ kind: 'deploy', target: 'shop-api' }]],
    ['flyctl deploy', [{ kind: 'deploy' }]],
    ['railway up', [{ kind: 'deploy' }]],
    ['heroku container:push web -a shop', [{ kind: 'deploy', target: 'shop' }]],
    ['gcloud run deploy api --region europe-west1', [{ kind: 'deploy', target: 'api' }]],
    ['gcloud app deploy app.yaml', [{ kind: 'deploy' }]],
    ['aws cloudformation deploy --stack-name billing', [{ kind: 'deploy', target: 'billing' }]],
    ['sam deploy', [{ kind: 'deploy' }]],
    ['serverless deploy --stage prod', [{ kind: 'deploy' }]],
    ['sls deploy', [{ kind: 'deploy' }]],
    ['kubectl apply -f k8s/', [{ kind: 'deploy' }]],
    ['kubectl -n prod rollout restart deployment/api', [{ kind: 'deploy', target: 'api' }]],
    ['helm upgrade --install web ./chart', [{ kind: 'deploy', target: 'web' }]],
    ['terraform -chdir=infra apply -auto-approve', [{ kind: 'deploy', target: 'infra' }]],
    ['pulumi up -s prod --yes', [{ kind: 'deploy', target: 'prod' }]],
    ['npx cdk deploy', [{ kind: 'deploy' }]],
    ['wrangler deploy', [{ kind: 'deploy' }]],
    ['npx wrangler publish', [{ kind: 'deploy' }]],
    ['firebase deploy --only hosting', [{ kind: 'deploy' }]],
    ['npm publish', [{ kind: 'deploy' }]],
    ['gh release create v1.4.0 --generate-notes', [{ kind: 'deploy' }]],
    ['docker push ghcr.io/me/api:1.4', [{ kind: 'deploy', target: 'api' }]],
    ['git push origin v1.4.0', [{ kind: 'deploy' }]],
    ['git push --tags', [{ kind: 'deploy' }]],
    // build
    ['npm run build', [{ kind: 'build' }]],
    ['npm run build:electron', [{ kind: 'build' }]],
    ['pnpm build', [{ kind: 'build' }]],
    ['pnpm --filter web build', [{ kind: 'build', target: 'web' }]],
    ['yarn build', [{ kind: 'build' }]],
    ['vite build', [{ kind: 'build' }]],
    ['tsc', [{ kind: 'build' }]],
    ['tsc --noEmit', [{ kind: 'build' }]],
    ['tsc -p packages/api/tsconfig.json', [{ kind: 'build', target: 'api' }]],
    ['next build', [{ kind: 'build' }]],
    ['cargo build --release', [{ kind: 'build' }]],
    ['go build ./...', [{ kind: 'build' }]],
    ['make', [{ kind: 'build' }]],
    ['make -j 8 -C services/api', [{ kind: 'build', target: 'api' }]],
    ['./gradlew assemble', [{ kind: 'build' }]],
    ['mvn package -DskipTests', [{ kind: 'build' }]],
    ['docker build -t api .', [{ kind: 'build', target: 'api' }]],
    ['webpack --mode production', [{ kind: 'build' }]],
    ['esbuild src/main.ts --bundle --outdir=dist', [{ kind: 'build' }]],
    // test
    ['npm test', [{ kind: 'test' }]],
    ['npm run test:unit', [{ kind: 'test' }]],
    ['npm t', [{ kind: 'test' }]],
    ['npx vitest run', [{ kind: 'test' }]],
    ['jest --ci', [{ kind: 'test' }]],
    ['pytest -q tests/', [{ kind: 'test' }]],
    ['python3 -m pytest', [{ kind: 'test' }]],
    ['uv run pytest', [{ kind: 'test' }]],
    ['cargo test -p core', [{ kind: 'test', target: 'core' }]],
    ['go test ./...', [{ kind: 'test' }]],
    ['mvn test', [{ kind: 'test' }]],
    ['gradle test', [{ kind: 'test' }]],
    ['bundle exec rspec', [{ kind: 'test' }]],
    ['vendor/bin/phpunit', [{ kind: 'test' }]],
    ['npx playwright test', [{ kind: 'test' }]],
    ['make test', [{ kind: 'test' }]],
    // push
    ['git push origin main', [{ kind: 'push', branch: 'main', toDefault: true }]],
    ['git push origin HEAD:master', [{ kind: 'push', branch: 'master', toDefault: true }]],
    ['git push -u origin feature/x', [{ kind: 'push', branch: 'feature/x', toDefault: false }]],
    ['git push', [{ kind: 'push' }]],
    ['git push origin main --follow-tags', [{ kind: 'deploy' }, { kind: 'push', branch: 'main', toDefault: true }]],
    // stripped prefixes, chains, directories
    ['FOO=1 sudo -E npx --yes vitest run', [{ kind: 'test' }]],
    ['timeout 120 npm test', [{ kind: 'test' }]],
    ['cd packages/web && npm run build', [{ kind: 'build', target: 'web' }]],
    ['(cd ../billing && npm test)', [{ kind: 'test', target: 'billing' }]],
    ['npm test --prefix /tmp/nonexistent-project', [{ kind: 'test', target: 'nonexistent-project' }]],
    ['npm run build && git push origin main', [{ kind: 'build' }, { kind: 'push', branch: 'main', toDefault: true }]],
    ['npm run lint; npm test 2>&1 | tail -20', [{ kind: 'test' }]],
    ['npm run build && npm run build:electron', [{ kind: 'build' }]],
    // false-positive guards
    ['echo deploy && false', []],
    ['git commit -m "deploy; npm test && git push origin main"', []],
    ["cat <<'EOF' > notes.md\nnpm test\nvercel deploy --prod\nEOF", []],
    ['echo $(npm test)', []],
    ['make clean', []],
    ['npm run lint', []],
    ['npm run builder', []],
    ['npm install', []],
    ['vercel env pull', []],
    ['terraform plan', []],
    ['kubectl get pods', []],
    ['aws s3 sync deploy s3://bucket', []],
    ['npm publish --dry-run', []],
    ['git push --dry-run origin main', []],
    ['git push --delete origin old-branch', []],
    ['tsc --version', []],
    ['grep -rn "npm test" docs/', []],
    ['git status && git log --oneline -5', []],
    ['ls /etc | wc -l', []],
  ]

  it('classify_command: the pattern table, chains, stripped prefixes and the false-positive guards', () => {
    const { classified } = drive({ commands: TABLE.map(([c]) => c), cwd: '/home/me/api' })
    const got = TABLE.map(([command], i) => [command, classified[i]])
    expect(got).toEqual(TABLE)
  })

  it('the prefilter lets every command the table classifies through, and keeps the classifier unloaded for the rest', () => {
    const { prefilter } = drive({ commands: TABLE.map(([c]) => c) })
    TABLE.forEach(([command, expected], i) => {
      if (expected.length) expect(prefilter[i], command).toBe(true)
    })
    expect(drive({ commands: ['git status', 'ls -la', 'cat README.md', 'sed -n 1,20p x'] }).prefilter).toEqual([false, false, false, false])
    // An ordinary Bash call never compiles the classifier at all; a test run does
    const plain = { session_id: 's', cwd: '/home/me/api', hook_event_name: 'PreToolUse', tool_name: 'Bash' }
    expect(drive({ payload: { ...plain, tool_input: { command: 'git status' } } }).loaded).toBe(false)
    expect(drive({ payload: { ...plain, tool_input: { command: 'npm test' } } }).loaded).toBe(true)
  })

  // The capture session these payloads borrow their shape from (2.1.300:
  // Bash PreToolUse / PostToolUse / PostToolUseFailure keys, the error as
  // "Exit code N\n<output>", the tool_response object)
  const base = {
    session_id: '17f46010-d2b1-4d95-bdde-34994b4b1d00',
    transcript_path: '/root/.claude/projects/-home-me-api/17f46010-d2b1-4d95-bdde-34994b4b1d00.jsonl',
    cwd: '/home/me/api',
    prompt_id: '47795df5-e84a-4a57-8884-078b1e761a82',
    permission_mode: 'bypassPermissions',
    effort: { level: 'medium' },
  }
  const session = { sessionId: base.session_id, project: 'api', cwd: base.cwd, transcriptPath: base.transcript_path }
  const bash = (command: string, extra: Record<string, unknown> = {}) => ({ ...base, tool_name: 'Bash', tool_input: { command, description: 'x' }, tool_use_id: 'toolu_01SIG', ...extra })

  it('a deploy: PreToolUse -> deploy_start on agent_working, PostToolUse -> deploy_success on session_tool_done, PostToolUseFailure -> deploy_fail with the error', () => {
    expect(runHook(bash('vercel deploy --prod', { hook_event_name: 'PreToolUse' }))).toEqual({
      type: 'agent_working', status: 'running: vercel deploy --prod', tool: 'Bash',
      signals: [{ kind: 'deploy_start', target: 'api', command: 'vercel deploy --prod' }],
      ...session,
    })
    expect(runHook(bash('vercel deploy --prod', {
      hook_event_name: 'PostToolUse',
      tool_response: { stdout: 'Production: https://api-7f3k.vercel.app [42s]', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
      duration_ms: 42_113,
    }))).toEqual({
      type: 'session_tool_done', toolName: 'Bash', callKey: callKeyOf('Bash', { command: 'vercel deploy --prod', description: 'x' }), promptId: base.prompt_id,
      signals: [{ kind: 'deploy_success', target: 'api', command: 'vercel deploy --prod' }],
      ...session,
    })
    expect(runHook(bash('vercel deploy --prod', {
      hook_event_name: 'PostToolUseFailure',
      error: 'Exit code 1\nVercel CLI 39.1.0\n\nError: Deployment failed: the build step exited with 1\n',
      is_interrupt: false,
      duration_ms: 31_870,
    }))).toEqual({
      type: 'agent_working', status: 'failed: Bash — Exit code 1 Vercel CLI 39.1.0 Error: Deployment failed: the ', failed: true, tool: 'Bash',
      signals: [{
        kind: 'deploy_fail', target: 'api', command: 'vercel deploy --prod',
        error: 'Error: Deployment failed: the build step exited with 1', exitCode: 1,
      }],
      ...session,
    })
  })

  it('a failing `vitest run`: test_failed with the first meaningful line, the exit code and "3 failing"', () => {
    const ev = runHook(bash('npx vitest run', {
      hook_event_name: 'PostToolUseFailure',
      error: [
        'Exit code 1', '', ' RUN  v3.2.4 /home/me/api', '',
        ' ❯ tests/parser.test.ts (12 tests | 3 failed) 41ms',
        '   × parses dates 9ms',
        ' FAIL  tests/parser.test.ts > parses dates',
        'AssertionError: expected 2 to be 3',
        '',
        ' Test Files  1 failed | 30 passed (31)',
        '      Tests  3 failed | 593 passed (596)',
      ].join('\n'),
      is_interrupt: false,
    }))
    expect(ev?.signals).toEqual([{
      kind: 'test_failed', target: 'api', command: 'npx vitest run',
      error: '❯ tests/parser.test.ts (12 tests | 3 failed) 41ms', exitCode: 1, detail: '3 failing',
    }])
  })

  it('a chained `npm run build && git push origin main`: both start; both land; a failure is blamed on the segment the output points at', () => {
    const cmd = 'npm run build && git push origin main'
    expect(runHook(bash(cmd, { hook_event_name: 'PreToolUse' }))?.signals).toEqual([
      { kind: 'build_start', target: 'api', command: cmd },
      { kind: 'push', target: 'api', branch: 'main', toDefault: true, command: cmd },
    ])
    expect(runHook(bash(cmd, { hook_event_name: 'PostToolUse', tool_response: { stdout: '✓ built in 2.1s', stderr: '' } }))?.signals).toEqual([
      { kind: 'build_ok', target: 'api', command: cmd },
      { kind: 'push_done', target: 'api', branch: 'main', toDefault: true, command: cmd },
    ])
    // tsc failed: the push never ran, so it says nothing
    expect(runHook(bash(cmd, {
      hook_event_name: 'PostToolUseFailure',
      error: "Exit code 2\nsrc/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/db.ts(9,1): error TS2304: Cannot find name 'pool'.\n\nFound 2 errors in 2 files.",
      is_interrupt: false,
    }))?.signals).toEqual([{
      kind: 'build_failed', target: 'api', command: cmd,
      error: "src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", exitCode: 2, detail: '2 errors',
    }])
    // The push was rejected: the build had passed
    expect(runHook(bash(cmd, {
      hook_event_name: 'PostToolUseFailure',
      error: 'Exit code 1\nTo github.com:me/api.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to \'github.com:me/api.git\'',
      is_interrupt: false,
    }))?.signals).toEqual([{
      kind: 'push_failed', target: 'api', branch: 'main', toDefault: true, command: cmd,
      error: '! [rejected]        main -> main (fetch first)', exitCode: 1,
    }])
  })

  it('a failed chain is never pinned on a classified segment when an unclassified one could have failed it', () => {
    const fail = (cmd: string, error: string) => runHook(bash(cmd, { hook_event_name: 'PostToolUseFailure', error, is_interrupt: false }))?.signals ?? []
    // The deploy never ran: npm ci failed first
    expect(fail('npm ci && vercel deploy --prod', 'Exit code 1\nnpm ERR! network request to https://registry.npmjs.org/react failed')).toEqual([])
    // The deploy succeeded: the PR comment after it failed
    expect(fail('vercel deploy --prod && gh pr comment 12 --body deployed', 'Exit code 1\nGraphQL: Could not resolve to a PullRequest')).toEqual([])
    // The rebase conflicted before the push
    expect(fail('git pull --rebase && git push origin main', 'Exit code 1\nCONFLICT (content): Merge conflict in a.ts')).toEqual([])
    // The tests passed: the commit had nothing to commit
    expect(fail('npm test && git commit -am x', 'Exit code 1\nnothing to commit, working tree clean')).toEqual([])
    // Still blamed: output that points at the segment, a lone segment behind a cd, a chain of classified segments only
    expect(fail('npm ci && npm test', 'Exit code 1\nTests: 3 failed, 10 passed').map(s => s.kind)).toEqual(['test_failed'])
    expect(fail('cd web && npm test', 'Exit code 1\nsome output').map(s => s.kind)).toEqual(['test_failed'])
    expect(fail('npm run build && vercel deploy --prod', 'Exit code 1\nanything').map(s => s.kind)).toEqual(['build_failed'])
  })

  it('a masked exit status (`npm test | tail`) is judged by the output: a failure count, a pass line, or nothing', () => {
    const cmd = 'npm test 2>&1 | tail -5'
    const post = (stdout: string) => runHook(bash(cmd, { hook_event_name: 'PostToolUse', tool_response: { stdout, stderr: '' } }))?.signals
    expect(post('      Tests  2 failed | 10 passed (12)')).toEqual([{ kind: 'test_failed', target: 'api', command: cmd, detail: '2 failing' }])
    expect(post('      Tests  12 passed (12)')).toEqual([{ kind: 'test_ok', target: 'api', command: cmd }])
    expect(post('done')).toBeUndefined()
    // `|| true` hides the status the same way
    expect(runHook(bash('npm test || true', { hook_event_name: 'PostToolUse', tool_response: { stdout: 'nothing to see', stderr: '' } }))?.signals).toBeUndefined()
  })

  it('a worker\'s PostToolUse carries them on its session_tool_done (with its agentId); where the call sends nothing of its own (no session id) they go out alone as a `signal` event', () => {
    expect(runHook(bash('npm test', {
      hook_event_name: 'PostToolUse', agent_id: 'a29964dc791f62039', agent_type: 'general-purpose',
      tool_response: { stdout: 'Tests  4 passed (4)', stderr: '' },
    }))).toEqual({
      type: 'session_tool_done', toolName: 'Bash', callKey: callKeyOf('Bash', { command: 'npm test', description: 'x' }),
      signals: [{ kind: 'test_ok', target: 'api', command: 'npm test' }],
      agentId: 'a29964dc791f62039', promptId: base.prompt_id,
      ...session,
    })
    expect(runHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: '/home/me/api', tool_input: { command: 'npm test' }, tool_response: { stdout: '', stderr: '' } }))
      .toEqual({ type: 'signal', signals: [{ kind: 'test_ok', target: 'api', command: 'npm test' }], project: 'api', cwd: '/home/me/api' })
    expect(runHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', agent_id: 'a29964dc791f62039', agent_type: 'general-purpose', cwd: '/home/me/api', tool_input: { command: 'npm test' }, tool_response: { stdout: '', stderr: '' } }))
      .toEqual({
        type: 'signal', signals: [{ kind: 'test_ok', target: 'api', command: 'npm test' }],
        agentId: 'a29964dc791f62039', agentType: 'general-purpose', role: 'general-purpose', name: 'Agent', project: 'api', cwd: '/home/me/api',
      })
    // An ordinary Bash call in a worker carries no signals
    expect(runHook(bash('ls', { hook_event_name: 'PostToolUse', agent_id: 'a29964dc791f62039', agent_type: 'general-purpose', tool_response: { stdout: '', stderr: '' } })))
      .not.toHaveProperty('signals')
  })

  it('a backgrounded run has no outcome on PostToolUse; an Esc is a failure marked interrupted', () => {
    expect(runHook(bash('vercel deploy --prod', {
      hook_event_name: 'PostToolUse', tool_input: { command: 'vercel deploy --prod', run_in_background: true },
      tool_response: { stdout: 'Command running in background with ID: bash_1', stderr: '' },
    }))).toEqual({ type: 'session_tool_done', toolName: 'Bash', callKey: callKeyOf('Bash', { command: 'vercel deploy --prod', run_in_background: true }), promptId: base.prompt_id, ...session })
    expect(runHook(bash('npm test', { hook_event_name: 'PostToolUseFailure', error: 'Interrupted by user', is_interrupt: true }))?.signals)
      .toEqual([{ kind: 'test_failed', target: 'api', command: 'npm test', interrupted: true, error: 'Interrupted by user' }])
  })

  it('a bare `git push` reads the branch from .git/HEAD (a worktree\'s .git file too); unknown, it has no toDefault', () => {
    const repo = mkdtempSync(join(tmpdir(), 'agent-office-signal-repo-'))
    try {
      mkdirSync(join(repo, '.git'))
      writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      mkdirSync(join(repo, 'web'))
      const pre = (cwd: string, command = 'git push') => runHook({ ...base, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })?.signals
      expect(pre(join(repo, 'web'))).toEqual([{ kind: 'push', target: 'web', branch: 'main', toDefault: true, command: 'git push' }])
      // A worktree: .git is a file naming its own git dir
      const wt = join(repo, 'wt')
      mkdirSync(join(repo, '.git', 'worktrees', 'wt'), { recursive: true })
      writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/feature/signals\n')
      mkdirSync(wt)
      writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`)
      expect(pre(wt)).toEqual([{ kind: 'push', target: 'wt', branch: 'feature/signals', toDefault: false, command: 'git push' }])
      // Detached HEAD: a push, nothing said about the branch
      writeFileSync(join(repo, '.git', 'HEAD'), '4f449fe0c1a1d1d6c3d13d5b9e1c0e7a7c1ab0f2\n')
      expect(pre(repo)).toEqual([{ kind: 'push', target: repo.split(/[\\/]/).pop(), command: 'git push' }])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('false positives stay out of the events: `echo deploy && false` fails without signals, and the old shapes are unchanged', () => {
    expect(runHook(bash('echo deploy && false', { hook_event_name: 'PostToolUseFailure', error: 'Exit code 1', is_interrupt: false })))
      .toEqual({ type: 'agent_working', status: 'failed: Bash — Exit code 1', failed: true, tool: 'Bash', ...session })
    expect(runHook(bash('git commit -m "deploy; npm test"', { hook_event_name: 'PreToolUse' })))
      .toEqual({ type: 'agent_working', status: 'running: git commit -m "deploy; npm test"', tool: 'Bash', ...session })
    // A tool other than Bash never carries signals, whatever its input says
    expect(runHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'npm test', command: 'npm test' } }))
      .toEqual({ type: 'agent_working', status: "searching for 'npm test'", tool: 'Grep', ...session })
  })

  it('at most 8 signals per call, each string clamped; a command shlex cannot split still classifies', () => {
    const many = Array.from({ length: 12 }, (_, i) => `cd pkg${i} && npm test`).join(' && ')
    const ev = runHook(bash(many, { hook_event_name: 'PreToolUse' }))
    expect(ev?.signals).toHaveLength(8)
    expect(ev?.signals[0].command).toHaveLength(160)
    expect(runHook(bash(`fly deploy -a ${'x'.repeat(300)}`, { hook_event_name: 'PreToolUse' }))?.signals[0].target).toHaveLength(80)
    // An unbalanced quote: shlex gives up, the plain split still finds the test run
    expect(runHook(bash('npm test -- -t "unterminated', { hook_event_name: 'PreToolUse' }))?.signals?.[0]).toMatchObject({ kind: 'test_start' })
  })
})

/**
 * Python behaviours the port keeps on purpose. Every expectation here (apart
 * from the Windows-path group) is what the Python this hook replaced produced
 * for the same payload: they were compared one by one in a differential run
 * before it was deleted. Each one is a place where the obvious JS spelling
 * (`||`, String(), .slice, \b, JSON.stringify) gives another answer.
 */
describe('agent-tracker.mjs: Python semantics the port keeps', () => {
  const S = { session_id: 's1', cwd: '/home/me/proj', transcript_path: '/t/s1.jsonl' }
  const tailOf = { sessionId: 's1', project: 'proj', cwd: '/home/me/proj', transcriptPath: '/t/s1.jsonl' }
  const ev = (o: Record<string, unknown>) => runHook({ ...S, ...o })
  const agent = (input: unknown, extra: Record<string, unknown> = {}) =>
    ev({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: input, ...extra })?.agent
  const working = (tool_name: unknown, tool_input: unknown, extra: Record<string, unknown> = {}) =>
    ev({ hook_event_name: 'PreToolUse', tool_name, tool_input, ...extra })

  it('`x or default`: [] {} 0 and "" are unset, as in Python (not as in JS)', () => {
    expect(agent({ description: [], prompt: 'Write tests for the parser', subagent_type: 'general-purpose' })).toMatchObject({ role: 'test-engineer', task: 'Write tests for the parser' })
    expect(agent({ description: {}, prompt: 'Fix the crash in login' })).toMatchObject({ role: 'debugger', task: 'Fix the crash in login' })
    expect(agent({ description: 0, prompt: 'review the diff' })).toMatchObject({ role: 'code-reviewer', task: 'review the diff' })
    expect(agent({ subagent_type: [], agent_type: 'debugger', description: 'x' })).toMatchObject({ role: 'debugger', agentType: 'debugger' })
    expect(agent(0)).toMatchObject({ task: 'Working on task' })
    expect(agent({ description: 'x' }, { tool_use_id: [] })?.id).toMatch(/^agent-general-purpose-\d+$/)
    expect(ev({ hook_event_name: 'SessionStart', source: [], model: 0, session_title: [] })).toEqual({ type: 'session_started', source: 'startup', ...tailOf })
    expect(ev({ hook_event_name: 'SubagentStop', agent_id: 'a', agent_type: 'x', last_assistant_message: 0 })?.result).toBe('done')
    expect(ev({ hook_event_name: 'StopFailure', error: 0, error_details: [], last_assistant_message: {} })).toMatchObject({ error: 'unknown', detail: '' })
    expect(ev({ hook_event_name: 'PostCompact', trigger: 0 })?.trigger).toBe('manual')
    expect(working('Skill', { skill: 0 })?.status).toBe('using /skill')
    // only None is "nothing" for clamp(): False and 0 are text
    expect(ev({ hook_event_name: 'Stop', last_assistant_message: false })?.text).toBe('False')
    expect(ev({ hook_event_name: 'Stop', last_assistant_message: 0, stop_hook_active: [], session_crons: [1] })).toMatchObject({ text: '0', stopHookActive: false, crons: 1 })
    expect(ev({ hook_event_name: 'TaskCreated', task_id: 0, task_subject: 'x' })?.taskId).toBe('0')
    expect(ev({ hook_event_name: 'TaskCreated', task_id: false })?.taskId).toBe('False')
  })

  it('str() of True / None / floats / lists / dicts is Python\'s spelling', () => {
    expect(ev({ hook_event_name: 'SessionStart', model: true, session_title: 1.5 })).toMatchObject({ model: 'True', title: '1.5' })
    expect(ev({ hook_event_name: 'SessionEnd', reason: ['a', null, true, 1.5, "it's", { k: 'v"x' }, [], {}, -0.5, 1e-7, 2e20] }))
      .toMatchObject({ reason: `['a', None, True, 1.5, "it's", {'k': 'v"x'}, [], {}, -0.5, 1e-07, 200000000000000000000]` })
    expect(ev({ hook_event_name: 'SessionEnd', reason: { 'a b': 'q\'"', n: null, 'caf\u00e9': 'x\ny\t\x01' } }))
      .toMatchObject({ reason: String.raw`{'a b': 'q\'"', 'n': None, 'café': 'x\ny\t\x01'}` })
    expect(ev({ hook_event_name: 'SessionEnd', reason: ["a'b", 'a"b', 'a\'"b', 'a\\b', 'x\n', '\x7f', '\u00e9', '\u{2028}', '\u{a0}', '\u{200b}', '\u{1F600}', '\u{10FFFF}'] }))
      .toMatchObject({ reason: String.raw`["a'b", 'a"b', 'a\'"b', 'a\\b', 'x\n', '\x7f', 'é', '\u2028', '\xa0', '\u200b', '😀', '\U0010ffff']` })
    expect(ev({ hook_event_name: 'SubagentStop', agent_id: 5, agent_type: 'x', last_assistant_message: ['a'] })).toMatchObject({ agentId: '5', result: "['a']" })
    expect(ev({ hook_event_name: 'StopFailure', error: 'rate_limit', error_details: { a: 1 } })?.detail).toBe("{'a': 1}")
    expect(ev({ hook_event_name: 'PreCompact', trigger: ['x'] })?.trigger).toBe("['x']")
    expect(ev({ hook_event_name: 'TaskCreated', task_id: 1.5, task_subject: ['a'] })).toMatchObject({ taskId: '1.5', subject: "['a']" })
    expect(ev({ hook_event_name: 'Notification', notification_type: ['idle_prompt'] })).toBeNull()
    expect(working('Skill', { skill: true })?.status).toBe('using /True')
    expect(working('Skill', { skill: ['a', 1] })?.status).toBe("using /['a', 1]")
    expect(working('Grep', { pattern: 5 })?.status).toBe("searching for '5'")
    expect(working('Bash', { command: ['x'] })?.status).toBe("running: ['x']")
    expect(working('Read', { file_path: 5 })?.status).toBe('reading 5')
    const post = (tool_response: unknown) => ev({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: {}, tool_response })?.result
    expect(post({ content: [1, null, true, 2.5, ['x', 1], { text: null }, { text: 'ok' }, 'str', { a: 1 }, 1e-7, 0.1, 1e22] })).toBe('1 None True 2.5 [\'x\', 1] None ok str  1e-07 0.1 1e+22')
    expect(post({ output: { a: "it's", b: [1, 2.5, null] } })).toBe(`{'a': "it's", 'b': [1, 2.5, None]}`)
    expect(post({ result: null })).toBe('None')
    expect(post({ content: 'plain text' })).toBe('plain text')
    expect(post('not json')).toBe('not json')
    expect(post('[1]')).toBe('[1]')
    expect(post(5)).toBe('done')
    expect(post(null)).toBe('done')
  })

  it('[:n] counts code points, not UTF-16 units', () => {
    const smile = '\u{1F600}'
    expect(ev({ hook_event_name: 'SubagentStop', agent_id: 'a', agent_type: 'x', last_assistant_message: smile.repeat(200), agent_transcript_path: smile.repeat(500) }))
      .toMatchObject({ result: smile.repeat(120), agentTranscriptPath: smile.repeat(400) })
    expect(ev({ hook_event_name: 'SessionStart', session_title: smile.repeat(200) })?.title).toBe(smile.repeat(120))
    expect(agent({ description: smile.repeat(100), subagent_type: 'debugger' })?.task).toBe(smile.repeat(80))
    expect(working('Grep', { pattern: smile.repeat(50) })?.status).toBe(`searching for '${smile.repeat(30)}'`)
    expect(working('Bash', { command: smile.repeat(100) })?.status).toBe(`running: ${smile.repeat(60)}`)
    expect(ev({ hook_event_name: 'PostModelSwitch', to_model: 'b'.repeat(100), from_model: 5, source: 's'.repeat(40) })).toMatchObject({ model: 'b'.repeat(80), switchSource: 's'.repeat(20) })
    expect(ev({ hook_event_name: 'PostModelSwitch', to_model: 'b', from_model: 5 })).not.toHaveProperty('fromModel')
  })

  it('int(): floats truncate, negatives and bools drop out, strings do not count', () => {
    const resp = (tool_response: unknown) => ev({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: {}, tool_response })
    expect(resp({ status: 'completed', totalTokens: 12.9, totalDurationMs: '5', totalToolUseCount: true, resolvedModel: 'm'.repeat(100) }))
      .toMatchObject({ tokens: 12, model: 'm'.repeat(80) })
    expect(resp({ status: 'completed', totalTokens: 12.9, totalDurationMs: '5', totalToolUseCount: true })).not.toHaveProperty('durationMs')
    expect(resp({ status: 'completed', totalTokens: 12.9, totalDurationMs: '5', totalToolUseCount: true })).not.toHaveProperty('toolUses')
    const zero = resp({ status: 'completed', totalTokens: 0, totalDurationMs: -1, totalToolUseCount: 3.0, resolvedModel: '' })
    expect(zero).toMatchObject({ tokens: 0, toolUses: 3 })
    expect(zero).not.toHaveProperty('durationMs')
    expect(zero).not.toHaveProperty('model')
    expect(resp({ status: 'completed', totalTokens: 1e15, totalDurationMs: 123456789012 })).toMatchObject({ tokens: 1000000000000000, durationMs: 123456789012 })
    // an exit code that is "digits" to str.isdigit() but not to int() loses the signals, never the event
    const fail = (error: string) => ev({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, error })
    expect(fail('Exit code \u{b2}\nboom')).not.toHaveProperty('signals')
    expect(fail('Exit code \u{b2}\nboom')?.status).toBe('failed: Bash — Exit code ² boom')
    expect(fail('Exit code \u{663}\nFAIL x')?.signals).toEqual([{ kind: 'test_failed', target: 'proj', command: 'npm test', error: 'FAIL x', exitCode: 3, detail: 'FAIL x' }])
    expect(fail('Exit code  7 \nfoo')?.signals?.[0]).toMatchObject({ exitCode: 7 })
    for (const odd of ['Exit code 12abc\nfoo', 'Exit code 1_0\nx', 'Exit code +3\nx']) expect(fail(odd)?.signals?.[0]).not.toHaveProperty('exitCode')
  })

  it('which payloads Python would have crashed on give nothing, not a half event', () => {
    expect(agent({ subagent_type: ['x'], description: 'x' })).toBeUndefined() // unhashable dict key
    expect(agent({ description: 5 })).toBeUndefined() // 5.lower() / 5[:80]
    expect(agent({ description: 5, subagent_type: 'debugger' })).toBeUndefined()
    expect(agent({ description: ['a', 'b'] })).toBeUndefined() // a list has no .lower()
    expect(agent({ description: true, subagent_type: 'debugger' })).toBeUndefined()
    expect(agent([1])).toBeUndefined() // a list has no .get()
    expect(agent('abc')).toBeUndefined()
    // …but a list is sliceable, so with a role that needs no .lower() it is the task
    expect(agent({ description: ['a', 'b'], subagent_type: 'debugger' })).toMatchObject({ role: 'debugger', task: ['a', 'b'] })
    expect(agent({ description: 'x', subagent_type: 5 })).toMatchObject({ role: 'general-purpose', agentType: 5 })
    expect(working(5, {})).toBeNull() // 5.startswith
    expect(working(['Bash'], {})).toBeNull()
    expect(working(true, {})).toBeNull()
    expect(working('Read', { file_path: 'x' }, { agent_id: 'a', agent_type: ['t'] })).toBeNull()
    expect(working('Read', { file_path: 'x' }, { agent_id: 'a', agent_type: 5 })).toMatchObject({ agentType: 5, role: 'general-purpose', name: 'Agent' })
    expect(working('Read', { file_path: 'x' }, { agent_id: 'a', agent_type: [] })).toMatchObject({ agentType: 'general-purpose' })
    // a name that is a property of every JS object is just a name
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(working(name, {})).toMatchObject({ status: `using ${name}`, tool: name })
    expect(working('Read', 'abc')).toMatchObject({ status: 'reading ' })
    expect(working('Read', [1, 2])).toMatchObject({ status: 'reading ' })
    expect(ev({ hook_event_name: 'PostToolUse', tool_name: 'SubagentHandback', tool_input: 'abc', tool_response: 'text' })).toBeNull()
    expect(ev({ hook_event_name: 'PostToolUse', tool_name: 'SubagentHandback', agent_id: 'q', tool_input: 5, tool_response: 'text' })).toMatchObject({ agentId: 'q', result: 'text' })
  })

  it('Python whitespace: str.split() breaks on \\x1c-\\x1f and \\x85 but not on U+FEFF', () => {
    const note = (message: string) => ev({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message })?.message
    expect(note('a\x85b\u{feff}c\x1cd  e\u{a0}f\u{2003}g')).toBe('a b\u{feff}c d e f g')
    expect(ev({ hook_event_name: 'Stop', background_tasks: [{ id: 1, type: null, status: true, description: ' a \n b\x85c\u{feff}d\x1ce ' }, 'x', 5, { id: 1.5 }, {}, []] })?.backgroundTasks)
      .toEqual([{ id: '1', type: '', status: 'True', description: 'a b c\u{feff}d e' }, { id: '1.5', type: '', status: '', description: '' }, { id: '', type: '', status: '', description: '' }])
  })

  it('the \\b of the role hints is Unicode-aware: a word glued to a letter, digit or underscore is not the hint word', () => {
    const role = (description: string) => agent({ description })?.role
    expect(role('spec')).toBe('test-engineer')
    expect(role('SPEC')).toBe('test-engineer')
    expect(role('a\u{a0}bug')).toBe('debugger')
    expect(role('caf\u{e9} review')).toBe('code-reviewer')
    for (const glued of ['\u{e9}spec', '_spec', 'inspect', 'test\u{e9}', 'review\u{661}', 'sec\u{fc}rity']) expect(role(glued), glued).toBe('general-purpose')
  })

  it('re.M and re.I the Python way: ^ sees only \\n, . takes \\r, \\d takes any digit, the match is case-insensitive', () => {
    const out = (stdout: string, command = 'npm test | cat') => ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '' } })
    const sig = (stdout: string, command?: string) => out(stdout, command)?.signals?.[0]
    expect(sig('BUILD FAILED', 'npm run build | cat')).toMatchObject({ kind: 'build_failed' })
    expect(sig('x\nERROR in a', 'npm run build | cat')).toMatchObject({ kind: 'build_failed' })
    expect(out('x\rERROR in a', 'npm run build | cat')).not.toHaveProperty('signals') // \r is not a line start to Python
    expect(out('x\u{2028}ERROR in a', 'npm run build | cat')).not.toHaveProperty('signals')
    expect(out('a\rFAIL b')).not.toHaveProperty('signals')
    expect(sig('a\n  FAIL b: it broke\nc')).toMatchObject({ kind: 'test_failed', detail: 'FAIL b: it broke' })
    expect(sig('FAIL b\r\nc')).toMatchObject({ detail: 'FAIL b' }) // . takes the \r that JS would stop at
    expect(sig('1\u{663} failed')).toMatchObject({ kind: 'test_failed', detail: '1\u{663} failing' })
    expect(out('\u{663} failed')).not.toHaveProperty('signals') // [1-9] stays ASCII
    expect(sig('\u{1b}[31m2 failed\u{1b}[0m')).toMatchObject({ detail: '2 failing' }) // colour codes removed first
    expect(sig('\u{1b}[1;31;m3 failing\u{1b}[K')).toMatchObject({ detail: '3 failing' })
    expect(sig('--- FAIL: A\n--- FAIL: B\n--- FAIL: C', 'go test ./... | cat')).toMatchObject({ detail: '3 failing' })
    expect(sig('--- FAIL: A', 'go test ./... | cat')).toMatchObject({ detail: '1 failing' })
    expect(sig('error TS1\nerror TS2\nerror TS3', 'npm run build | cat')).toMatchObject({ detail: '3 errors' })
    expect(sig('Found 1 error in x', 'npm run build | cat')).toMatchObject({ detail: '1 error' })
    expect(out('Found \u{662} errors', 'npm run build | cat')).not.toHaveProperty('signals')
    expect(sig('ok  \tpkg\t0.1s')).toMatchObject({ kind: 'test_ok' })
    expect(out('\u{662}\u{662} passed')).not.toHaveProperty('signals')
    expect(sig('Deployment to prod FAILED', 'vercel deploy --prod | cat')).toMatchObject({ kind: 'deploy_fail' })
    expect(out(`deploy ${'x'.repeat(41)} failed`, 'vercel deploy --prod | cat')).not.toHaveProperty('signals') // [^\n]{0,40}
    // splitlines() breaks on more than \n when the first meaningful line of an error is picked
    const err = (error: string) => ev({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, error })?.signals?.[0]?.error
    expect(err('Exit code 1\r\n\u{1c}foo failed')).toBe('foo failed')
    expect(err('Exit code 1\n\u{85}meh\u{85}an error here')).toBe('an error here')
    expect(err('Exit code 1\n\n  \n!!!\nreal line failed')).toBe('real line failed')
    expect(err('Exit code 1\n\u{2460}\n\u{e9}')).toBe('\u{2460}')
    expect(err('Exit code 1\nfirst\nsecond is fatal\nthird')).toBe('second is fatal')
    expect(err('Exit code 5\n')).toBe('exit code 5')
  })

  // The classifier on quoting, escapes, redirections, comments and directories. Expected values: the Python's.
  const SHELL: Array<[string, Array<Record<string, unknown>>]> = [
    ["npm 'run' \"build\"", [{ kind: 'build' }]],
    ['npm run "bu"ild', [{ kind: 'build' }]],
    [String.raw`npm run "buil\"d"`, []],
    [String.raw`npm run "bui\ld"`, []],
    ['echo "npm test"', []],
    [String.raw`npm\ test`, []],
    [String.raw`vercel\ deploy`, []],
    ['npm test\\', []],
    ["npm run 'build", []],
    ['FOO="a b" npm test', [{ kind: 'test' }]],
    ['npm test # && vercel deploy --prod', [{ kind: 'test' }]],
    ['npm test#x', []],
    ['npm test &> out.log', [{ kind: 'test' }]],
    ['npm test 2>&1 >out', [{ kind: 'test' }]],
    ['npm test >&2', [{ kind: 'test' }]],
    ['npm test & npm run build', [{ kind: 'test' }, { kind: 'build' }]],
    ["cd 'my app' && npm test", [{ kind: 'test', target: 'my app' }]],
    ['cd .. && cd .. && npm test', [{ kind: 'test', target: 'home' }]],
    ['cd /a/b && cd ../c && vercel deploy --prod', [{ kind: 'deploy', target: 'c' }]],
    ['(npm test)', [{ kind: 'test' }]],
    ['{ npm test; }', [{ kind: 'test' }]],
    ['! npm test', [{ kind: 'test' }]],
    ['echo $(npm test) && npm run build', [{ kind: 'build' }]],
    ['echo "$(npm test)" && npm run build', [{ kind: 'build' }]],
    ['echo `npm test`', []],
    ["cat <<< 'x' && npm test", [{ kind: 'test' }]],
    ['npm test\nnpm run build', [{ kind: 'test' }, { kind: 'build' }]],
    ['git -C web push origin main', [{ kind: 'push', target: 'web', branch: 'main', toDefault: true }]],
    ['git push origin +main', [{ kind: 'push', branch: 'main', toDefault: true }]],
    ['git push origin main:prod', [{ kind: 'push', branch: 'prod', toDefault: false }]],
    ['git push origin :old', [{ kind: 'push', branch: 'old', toDefault: false }]],
    ['git push origin v2.0 main', [{ kind: 'deploy' }, { kind: 'push', branch: 'main', toDefault: true }]],
    ['git push -o ci.skip origin main', [{ kind: 'push', branch: 'main', toDefault: true }]],
    ['git push origin HEAD --tags', [{ kind: 'deploy' }, { kind: 'push' }]],
    ['npm run build.x', [{ kind: 'build' }]],
    ['npm run build-x', [{ kind: 'build' }]],
    ['npm run buildx', []],
    ['npm run test_x', [{ kind: 'test' }]],
    ['pnpm workspace web build', [{ kind: 'build', target: 'web' }]],
    ['pnpm --filter ./pkg build', [{ kind: 'build', target: 'pkg' }]],
    ['make -j4 deploy', [{ kind: 'deploy' }]],
    ['make CC=gcc', [{ kind: 'build' }]],
    ['docker push a:5000/b:1', [{ kind: 'deploy', target: 'b' }]],
    ['docker push dir/x.yaml', [{ kind: 'deploy', target: 'dir' }]],
    ['terraform -chdir=a/b apply', [{ kind: 'deploy', target: 'b' }]],
    ['vercel pull --prod', []],
    ['vercel --scope team deploy --prod', [{ kind: 'deploy' }]],
    ['tsc --watch', []],
    ['webpack serve', []],
    ['vitest list', []],
    ['python3.12 -m pytest', [{ kind: 'test' }]],
    ['python -m http.server', []],
    ['sudo env FOO=1 timeout 5 npm test', [{ kind: 'test' }]],
    ['timeout -k 3 5 npm test', [{ kind: 'test' }]],
    ['FOO=1', []],
    ['\u{e9}x=1 npm test', [{ kind: 'test' }]], // a Unicode identifier is an assignment (str.isidentifier)
    ['1x=1 npm test', []],
    ['npm\u{a0}test', []], // shlex splits on ASCII blanks only
    ['npm\u{3000}test', []],
    ['npm\ttest', [{ kind: 'test' }]],
  ]
  it('classify_command: shlex quoting and escapes, redirections, comments, subshells, cd and git push refspecs', () => {
    resetSignals()
    loadSignals()
    expect(SHELL.map(([command]) => [command, classifyCommand(command, '/home/me/api')])).toEqual(SHELL)
  })

  it('call_key: sha256 of the tool name, NUL and the input as Python\'s json.dumps(sort_keys, compact, ensure_ascii=False) wrote it', () => {
    const key = (tool_name: unknown, tool_input: unknown) => ev({ hook_event_name: 'PermissionRequest', tool_name, tool_input })?.callKey
    // golden values, produced by the Python
    expect(key('Bash', { command: 'ls', description: 'd' })).toBe('cb05f9de67d5c4a3')
    expect(key('Bash', { command: 'echo caf\u{e9} \u{1F600}', 'z\u{e9}': 1 })).toBe('f1d01d77ad29e220')
    // keys sort by code point (U+FFFF before U+1F600, where UTF-16 order says the reverse), "10" before "9", "" first
    expect(key('X', { b: 1, a: { d: 1, c: [3, 2, 1] }, '\u{1F600}': 1, '\u{ffff}': 2, '\u{e9}': 3, '': 4, A: 5, '10': 6, '9': 7 })).toBe('6298ff64f551c17c')
    expect(key('X', { v: '\x00\x01\x08\x09\x0a\x0c\x0d\x1f\x7f"\\/', k: 1 })).toBe('99f9d4a92aa0dc22')
    expect(key('X', { a: 2.5, b: -0.5, c: 1e-7, d: 123456789, e: 0.1, f: 1e21, g: 1.5e300, h: -3, i: 5e-324, j: 0.00001, k: 123456789012345680000 })).toBe('3a2ab5995806ec57')
    expect(key('X', null)).toBe('bf89b999b52e2fe6')
    expect(key('X', undefined)).toBe('bf89b999b52e2fe6')
    expect(key('X', 'abc')).toBe('cd9c2884ae94272d')
    expect(key('X', [1, 'a', null, true])).toBe('39b9897736899a87')
    expect(key('X', {})).toBe('b2e25f07caa3b6be')
    expect(key('T\u{e9}\u{1F600}', { a: 1 })).toBe('d86c2eee0dee1272')
    expect(key(0, { a: 1 })).toBe('f30a8adb0ecc8695') // str(0 or 'tool') is "tool"
    expect(key(null, {})).toBe('cea28cfd1128c5c2') // str(None or 'tool')
    expect(key(['a'], { a: 1 })).toBe('c51b1385a603f6c6') // "['a']"
    expect(key(true, {})).toBe('ab5b810c0c257189') // "True"
    // lone surrogates are encoded as "?" (errors='replace'), not as U+FFFD
    const lone = '{"session_id":"s1","hook_event_name":"PermissionRequest","tool_name":"X","tool_input":{"a":"\\ud800","b":"\\udc00x","c":"\\ud83d\\ude00"}}'
    expect(runHook(lone)?.callKey).toBe('9016b5f9e2124c88')
    // the same hash on the PostToolUse of an MCP call, nested keys sorted
    expect(ev({ hook_event_name: 'PostToolUse', tool_name: 'mcp__srv__tool', tool_input: { a: 1 }, agent_id: 'w1' })).toMatchObject({ type: 'mcp_done', server: 'srv', tool: 'tool', callKey: '6361da2219db6c78', agentId: 'w1' })
    expect(ev({ hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__srv__tool', tool_input: { b: [1, { z: 1, a: 2 }] } })?.callKey).toBe('a1803ab5b06e776a')
  })

  it('the event keeps Python\'s key order (the JSON the server sees is canonical in it)', () => {
    const keys = (o: Record<string, unknown> | null) => Object.keys(o ?? {})
    expect(keys(working('Read', { file_path: '/x/y.ts' }, { agent_id: 'sub1', agent_type: 'Explore', prompt_id: 'p9' })))
      .toEqual(['type', 'status', 'tool', 'agentId', 'agentType', 'role', 'name', 'sessionId', 'project', 'cwd', 'transcriptPath'])
    expect(keys(ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, agent_id: 'w', prompt_id: 'p9', tool_response: { stdout: '' } })))
      .toEqual(['type', 'toolName', 'callKey', 'signals', 'agentId', 'promptId', 'sessionId', 'project', 'cwd', 'transcriptPath'])
    expect(keys(agent({ description: 'x' }, { agent_id: 'sub1' }))).toEqual(['id', 'name', 'role', 'task', 'agentType', 'background', 'parentSubagentId'])
    expect(keys(ev({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification><task-id>t1</task-id><status>done</status><summary> a  b </summary></task-notification>', prompt_id: 'p' })))
      .toEqual(['type', 'text', 'isWakeup', 'wakeupAgentId', 'wakeupStatus', 'promptId', 'sessionId', 'project', 'cwd', 'transcriptPath'])
    // a cwd event brings its own cwd and project, ahead of the session defaults
    expect(keys(ev({ hook_event_name: 'CwdChanged', new_cwd: '/a/b/', old_cwd: '/o' }))).toEqual(['type', 'cwd', 'project', 'oldCwd', 'sessionId', 'transcriptPath'])
    const home = mkdtempSync(join(tmpdir(), 'agent-office-keys-'))
    writeFileSync(join(home, 'answer-permissions'), 'on\n')
    try {
      const line = runHookLines({ ...S, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, prompt_id: 'p' }, { AGENT_OFFICE_HOME: home })[0]
      expect(keys(JSON.parse(line))).toEqual(['type', 'kind', 'toolName', 'summary', 'callKey', 'answerable', 'permissionMode', 'suggestions', 'detail', 'nonce', 'promptId', 'sessionId', 'project', 'cwd', 'transcriptPath'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
    // without a tool_use_id the agent id carries a number, new on every run (Python used id(d))
    const ids = [agent({ description: 'x' }, { tool_use_id: undefined })?.id, agent({ description: 'x' }, { tool_use_id: undefined })?.id]
    expect(ids[0]).toMatch(/^agent-general-purpose-\d{10,}$/)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('suggestions are bounded but keep their shape: 8 items, 12 keys, 40-char keys, 200-char strings, 3 levels deep', () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-office-sugg-'))
    writeFileSync(join(home, 'answer-permissions'), 'on\n')
    try {
      const suggestions = (permission_suggestions: unknown) => JSON.parse(runHookLines({ ...S, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions }, { AGENT_OFFICE_HOME: home })[0]).suggestions
      const [one] = suggestions([{ a: 'x'.repeat(300), b: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], c: { d: { e: { f: 1 } } }, g: 1.5, h: null, i: true, j: Object.fromEntries(Array.from({ length: 15 }, (_, i) => ['k' + i, i])) }, 5, 'x', null, [1]])
      expect(Object.keys(one)).toEqual(['a', 'b', 'c', 'g', 'h', 'i', 'j'])
      expect(one.a).toBe('x'.repeat(200))
      expect(one.b).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(one.c).toEqual({ d: { e: null } }) // depth 3 and below is None
      expect(one).toMatchObject({ g: 1.5, h: null, i: true })
      expect(Object.keys(one.j)).toHaveLength(12)
      expect(suggestions([{ a: [[[1]], [{ x: 1 }], { y: [1] }, [[]], 'ok'] }])).toEqual([{ a: [[null], [null], { y: null }, [null], 'ok'] }])
      expect(suggestions('abc')).toEqual([])
      const long = suggestions([{ ['k'.repeat(60)]: 1, ['\u{1F600}'.repeat(50)]: 2 }])[0]
      expect(Object.keys(long)).toEqual(['k'.repeat(40), '\u{1F600}'.repeat(40)])
      // '__proto__' is a key like any other
      expect(suggestions(JSON.parse('[{"__proto__": {"x": 1}, "a": 2}]'))[0]).toEqual(JSON.parse('{"__proto__": {"x": 1}, "a": 2}'))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('background / SubagentHandback / failure edge payloads', () => {
    const post = (tool_response: unknown, extra: Record<string, unknown> = {}) =>
      ev({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { description: 'x' }, tool_response, ...extra })
    expect(post('{"status": "async_launched", "agentId": "abc"}')).toMatchObject({ type: 'agent_linked', subagentId: 'abc' })
    expect(post({ status: 'async_launched', agent_id: 'abc' })).toMatchObject({ type: 'agent_linked', subagentId: 'abc' })
    expect(post({ status: 'async_launched', agentId: 5 })).toMatchObject({ type: 'agent_linked', subagentId: '5' })
    expect(post({ status: 'async_launched' })).toBeNull()
    expect(post({ status: 'running' }, { tool_input: { run_in_background: true } })).toBeNull()
    expect(post({ status: 'running' }, { tool_input: { run_in_background: [0] } })).toBeNull()
    expect(post({ status: 'completed', content: 'x' }, { tool_input: { run_in_background: true } })).toMatchObject({ type: 'agent_completed', result: 'x' })
    expect(post(undefined, { hook_event_name: 'PostToolUseFailure', error: ' a \n\n b ' })?.result).toBe('failed: a b')
    expect(post(undefined, { hook_event_name: 'PostToolUseFailure', error: 0 })?.result).toBe('failed: unknown error')
    expect(post(undefined, { hook_event_name: 'PostToolUseFailure', error: ['a', 1] })?.result).toBe("failed: ['a', 1]")
    expect(post(undefined, { hook_event_name: 'PostToolUseFailure', error: 'x', tool_use_id: '' })).toBeNull()
    const handback = (extra: Record<string, unknown>) => ev({ hook_event_name: 'PostToolUse', tool_name: 'SubagentHandback', ...extra })
    expect(handback({ tool_input: { agentId: 'h1' }, tool_response: { result: 'r' } })).toMatchObject({ agentId: 'h1', result: 'r' })
    expect(handback({ tool_input: [], tool_response: '{"agent_id": 7}' })).toMatchObject({ agentId: '7', result: '{"agent_id": 7}' })
    expect(handback({ tool_input: {}, tool_response: {} })).toBeNull()
  })

  it('signals on odd shapes: tool_response of any type, interrupted only when exactly true, cwd of any type', () => {
    const bash = (extra: Record<string, unknown>, command: unknown = 'npm test | cat') =>
      ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_1', ...extra })
    expect(bash({ tool_response: 'FAIL x\nfoo' })?.signals).toEqual([{ kind: 'test_failed', target: 'proj', command: 'npm test | cat', detail: 'FAIL x' }])
    expect(bash({ tool_response: ['3 failed'] })?.signals?.[0]).toMatchObject({ detail: '3 failing' })
    for (const odd of [12, null, { stdout: null, stderr: 5 }]) expect(bash({ tool_response: odd })).not.toHaveProperty('signals')
    expect(bash({ tool_response: { stdout: '', interrupted: true } }, 'npm test')?.signals).toEqual([{ kind: 'test_failed', target: 'proj', command: 'npm test', interrupted: true }])
    expect(bash({ tool_response: { stdout: '', interrupted: 1 } }, 'npm test')?.signals).toEqual([{ kind: 'test_ok', target: 'proj', command: 'npm test' }])
    for (const command of [5, null, '', ['npm test']]) expect(bash({ tool_response: { stdout: 'x' } }, command)).not.toHaveProperty('signals')
    // no session id: the signals go out alone, tagged with the worker
    expect(bash({ session_id: undefined, agent_id: 'w', agent_type: 'Explore', tool_response: { stdout: '' } }, 'npm test'))
      .toEqual({ type: 'signal', signals: [{ kind: 'test_ok', target: 'proj', command: 'npm test' }], agentId: 'w', agentType: 'Explore', role: 'Explore', name: 'Explorer', cwd: '/home/me/proj', project: 'proj', transcriptPath: '/t/s1.jsonl' })
    // cwd: the target comes from it, or from the session's project when it is not a path
    const pre = (cwd: unknown, command = 'npm test') => ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd })?.signals
    expect(pre('/')).toEqual([{ kind: 'test_start', target: '/', command: 'npm test' }])
    expect(pre(5)).toEqual([{ kind: 'test_start', command: 'npm test' }])
    expect(pre('')).toEqual([{ kind: 'test_start', command: 'npm test' }])
    expect(pre('/home/me/api', 'cd /srv/app && vercel deploy --prod')).toEqual([{ kind: 'deploy_start', target: 'app', command: 'cd /srv/app && vercel deploy --prod' }])
  })
})

/**
 * Windows. Claude Code reports cwd and file paths with backslashes there, and
 * the Python only ever split on "/" (it ran under bash): a project came out as
 * the whole path and a Bash target as "C". This is new behaviour, not parity.
 */
describe('agent-tracker.mjs: Windows paths', () => {
  const CWD = 'C:\\Users\\me\\proj'
  const win = { session_id: 's1', cwd: CWD, transcript_path: 'C:\\Users\\me\\.claude\\s1.jsonl' }
  const ev = (o: Record<string, unknown>) => runHook({ ...win, ...o })

  it('project is the last segment of a Windows cwd (either slash, trailing slash or not)', () => {
    expect(ev({ hook_event_name: 'Stop' })).toMatchObject({ project: 'proj', cwd: CWD, transcriptPath: 'C:\\Users\\me\\.claude\\s1.jsonl' })
    expect(ev({ hook_event_name: 'Stop', cwd: 'C:\\Users\\me\\proj\\' })?.project).toBe('proj')
    expect(ev({ hook_event_name: 'Stop', cwd: 'C:/Users/me/proj' })?.project).toBe('proj')
    expect(ev({ hook_event_name: 'Stop', cwd: 'C:\\Users\\me/proj\\\\' })?.project).toBe('proj')
    expect(ev({ hook_event_name: 'Stop', cwd: '\\\\server\\share\\proj' })?.project).toBe('proj')
    // a drive root is named by its drive; nothing left of "/" gives the cwd itself
    expect(ev({ hook_event_name: 'Stop', cwd: 'C:\\' })?.project).toBe('C:')
    expect(ev({ hook_event_name: 'Stop', cwd: '/' })?.project).toBe('/')
    expect(ev({ hook_event_name: 'CwdChanged', new_cwd: 'D:\\work\\api', old_cwd: CWD })).toMatchObject({ cwd: 'D:\\work\\api', project: 'api', oldCwd: CWD })
  })

  it('a file tool shows the file name, whichever slash the path uses', () => {
    const read = (file_path: string) => ev({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path } })?.status
    expect(read('C:\\Users\\me\\proj\\src\\App.tsx')).toBe('reading App.tsx')
    expect(read('C:/Users/me/proj/src/App.tsx')).toBe('reading App.tsx')
    expect(read('src\\a.ts')).toBe('reading a.ts')
    expect(ev({ hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: 'C:\\a\\probe.txt' } })?.summary).toBe('probe.txt')
    expect(ev({ hook_event_name: 'PermissionRequest', tool_name: 'NotebookEdit', tool_input: { notebook_path: 'C:\\a\\n.ipynb\\' } })?.summary).toBe('n.ipynb')
  })

  it('signals: the target is the project folder, and a cd moves it with Windows rules', () => {
    const target = (command: string, cwd = CWD) => ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd })?.signals?.[0]?.target
    expect(target('vercel deploy --prod')).toBe('proj')
    expect(target('cd api && npm test')).toBe('api')
    expect(target('cd .. && npm test')).toBe('me')
    expect(target('cd C:/work/svc && npm test')).toBe('svc')
    expect(target('cd api && npm test', 'C:/Users/me/proj')).toBe('api')
    expect(target('cd .. && npm test', 'C:/Users/me/proj')).toBe('me')
    expect(target('fly deploy -a shop-api')).toBe('shop-api')
  })

  it('a bare git push finds the branch from a Windows cwd', () => {
    const repo = mkdtempSync(join(tmpdir(), 'agent-office-win-repo-'))
    try {
      mkdirSync(join(repo, '.git'))
      writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/release\n')
      const sig = ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: repo })?.signals?.[0]
      expect(sig).toMatchObject({ kind: 'push', branch: 'release', toDefault: false })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
