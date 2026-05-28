import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommand, runCommandResult, shouldUseWindowsShell } from '../scripts/lib/command.mjs';

test('shouldUseWindowsShell only respects explicit shell opt-in on Windows', async () => {
  assert.equal(shouldUseWindowsShell('npx.cmd', false, 'win32'), false);
  assert.equal(shouldUseWindowsShell('npm.cmd', false, 'win32'), false);
  assert.equal(shouldUseWindowsShell('cmd.exe', true, 'win32'), true);
  assert.equal(shouldUseWindowsShell('node', false, 'linux'), false);
});

test('runCommandResult captures stdout and non-zero exits without external dependencies', async () => {
  const success = await runCommandResult(process.execPath, ['-e', 'process.stdout.write("ok")']);
  assert.equal(success.code, 0);
  assert.equal(success.stdout, 'ok');
  assert.equal(success.stderr, '');

  const failure = await runCommandResult(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(7)']);
  assert.equal(failure.code, 7);
  assert.equal(failure.stdout, '');
  assert.equal(failure.stderr, 'bad');
});

test('runCommand rejects on non-zero exit codes', async () => {
  await assert.rejects(
    runCommand(process.execPath, ['-e', 'process.exit(5)']),
    (error) => error.exitCode === 5
  );
});
