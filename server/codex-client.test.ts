import test from 'node:test'
import assert from 'node:assert/strict'
import { codexLaunchSpec } from './codex-client.js'

test('launches Windows cmd shims through cmd.exe to avoid spawn EINVAL', () => {
  assert.deepEqual(codexLaunchSpec('codex', 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }), {
    command: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', 'codex app-server --stdio'],
  })
  assert.deepEqual(codexLaunchSpec('C:\\Program Files\\Codex\\codex.cmd', 'win32', { ComSpec: 'cmd.exe' }), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', '"C:\\Program Files\\Codex\\codex.cmd" app-server --stdio'],
  })
})

test('launches native executables directly', () => {
  assert.deepEqual(codexLaunchSpec('codex', 'linux', {}), { command: 'codex', args: ['app-server', '--stdio'] })
  assert.deepEqual(codexLaunchSpec('C:\\Codex\\codex.exe', 'win32', {}), { command: 'C:\\Codex\\codex.exe', args: ['app-server', '--stdio'] })
})
