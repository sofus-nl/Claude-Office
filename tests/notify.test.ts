/**
 * server/notify.js - hostile text reaches the notifier only as argv items
 * (macOS/Linux) or environment values (Windows), never inside script source.
 * A fake execFile records the call, so no real notification is shown.
 */

import { describe, expect, it } from 'vitest'
import { notify, WIN_SCRIPT } from '../server/notify.js'

const NASTY = [
  'Antony: tell claude "hi"',
  'Antony: claude" & (do shell script "open -a Calculator")&"',
  "it's C:\path\n with a 'quote' and a \ backslash",
  'line one\nline two',
  '$(touch pwned) `id` <b>&</b>',
  '</text><action activationType="protocol" arguments="calc:"/>',
]

type Call = { cmd: string; args: string[]; opts: { timeout: number; env?: Record<string, string>; windowsHide?: boolean } }

function run(platform: string, title?: string, msg?: string) {
  const calls: Call[] = []
  const exec = (cmd: string, args: string[], opts: Call['opts'], cb: () => void) => {
    calls.push({ cmd, args, opts })
    cb()
    return { unref() {} }
  }
  notify(title as string, msg as string, { platform, execFile: exec })
  return calls
}

describe('notify', () => {
  it('darwin: title and message are the last two argv items, the AppleScript source is constant', () => {
    for (const msg of NASTY) {
      const [c] = run('darwin', 'Office Chat', msg)
      expect(c.cmd).toBe('osascript')
      expect(c.args.slice(-2)).toEqual(['Office Chat', msg])
      expect(c.args.slice(0, -2).filter(a => a !== '-e')).toEqual(['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv)', 'end run'])
      expect(c.opts.timeout).toBe(3000)
    }
  })

  it('linux: notify-send gets argv items, and a leading dash cannot become an option', () => {
    const [c] = run('linux', 'Agent Failed', '-u critical Debugger failed')
    expect(c.cmd).toBe('notify-send')
    expect(c.args).toEqual(['Agent Failed', ' -u critical Debugger failed'])
    expect(c.opts.timeout).toBe(3000)
  })

  it('win32: text travels in env values, the script and argv stay constant', () => {
    for (const msg of NASTY) {
      const [c] = run('win32', '<Office> "Chat"', msg)
      expect(c.cmd).toBe('powershell.exe')
      expect(c.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT])
      expect(c.opts.env).toMatchObject({ AO_TITLE: '<Office> "Chat"', AO_MSG: msg })
      expect(c.opts.timeout).toBe(10000)
      expect(c.opts.windowsHide).toBe(true)
      expect(c.args.join('\n')).not.toContain(msg)
    }
  })

  it('win32: the script constant reads the env vars and holds none of the hostile text', () => {
    expect(WIN_SCRIPT).toContain('$env:AO_TITLE')
    expect(WIN_SCRIPT).toContain('$env:AO_MSG')
    for (const msg of NASTY) expect(WIN_SCRIPT).not.toContain(msg)
  })

  it('win32: the notifier is Windows PowerShell\'s registered AppUserModelId, backslashes intact', () => {
    // An unregistered id (a lost backslash, a \v turned into a vertical tab) makes Windows drop the toast silently
    expect(WIN_SCRIPT).toContain(String.raw`CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe')`)
  })

  it('applies the notify.sh defaults and the leading-dash guard on every platform', () => {
    expect(run('darwin')[0].args.slice(-2)).toEqual(['Agent Office', 'Something happened'])
    expect(run('linux', '', '')[0].args).toEqual(['Agent Office', 'Something happened'])
    const env = run('win32', '-t', '-m')[0].opts.env!
    expect([env.AO_TITLE, env.AO_MSG]).toEqual([' -t', ' -m'])
  })

  it('never throws or rejects when the exec throws or errors', () => {
    const boom = () => { throw new Error('ENOENT') }
    expect(() => notify('t', 'm', { platform: 'linux', execFile: boom })).not.toThrow()
    const failing = (_c: string, _a: string[], _o: unknown, cb: (e: Error) => void) => { cb(new Error('exit 1')); return { unref() {} } }
    expect(() => notify('t', 'm', { platform: 'win32', execFile: failing })).not.toThrow()
  })
})
