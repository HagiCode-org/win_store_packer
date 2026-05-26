import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseWindowsShell } from '../scripts/lib/command.mjs';

test('shouldUseWindowsShell only respects explicit shell opt-in on Windows', async () => {
  assert.equal(shouldUseWindowsShell('npx.cmd', false, 'win32'), false);
  assert.equal(shouldUseWindowsShell('npm.cmd', false, 'win32'), false);
  assert.equal(shouldUseWindowsShell('cmd.exe', true, 'win32'), true);
  assert.equal(shouldUseWindowsShell('node', false, 'linux'), false);
});
