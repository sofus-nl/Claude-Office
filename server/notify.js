/**
 * notify.js - desktop notification from the office server.
 *
 * The text comes from chat messages and agent names, i.e. from anyone who can
 * reach the server, so it is never spliced into AppleScript or PowerShell
 * source: macOS/Linux get it as argv items, Windows as environment variables
 * read by a constant script. Never throws - a missing notifier is not an error.
 */

import { execFile } from 'node:child_process'

// Text goes in via $env:AO_TITLE / $env:AO_MSG only; this script never contains it.
// The AppUserModelId is Windows PowerShell's own, so the toast shows without registering an app.
export const WIN_SCRIPT = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
  '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$text = $xml.GetElementsByTagName('text')",
  '$text.Item(0).AppendChild($xml.CreateTextNode($env:AO_TITLE)) > $null',
  '$text.Item(1).AppendChild($xml.CreateTextNode($env:AO_MSG)) > $null',
  String.raw`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`,
].join('\n')

// opts exists so tests can inject the platform and exec without popping real notifications
export function notify(rawTitle, rawMsg, opts = {}) {
  const platform = opts.platform ?? process.platform
  const exec = opts.execFile ?? execFile
  // Neither tool should read a leading '-' in the text as an option
  const guard = s => (s.startsWith('-') ? ' ' + s : s)
  const title = guard(String(rawTitle || 'Agent Office'))
  const msg = guard(String(rawMsg || 'Something happened'))

  let cmd, args, execOpts
  if (platform === 'win32') {
    cmd = 'powershell.exe'
    args = ['-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT]
    execOpts = { timeout: 10000, windowsHide: true, env: { ...process.env, AO_TITLE: title, AO_MSG: msg } }
  } else if (platform === 'darwin') {
    cmd = 'osascript'
    args = ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, msg]
    execOpts = { timeout: 3000 }
  } else {
    cmd = 'notify-send'
    args = [title, msg]
    execOpts = { timeout: 3000 }
  }

  try {
    exec(cmd, args, execOpts, () => {})?.unref?.()
  } catch {}
}
