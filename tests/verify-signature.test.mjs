import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { findSignToolCandidates } from '../scripts/verify-signature.mjs';

test('findSignToolCandidates finds versioned Windows Kits signtool paths', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'signtool-candidates-'));
  const kitsRoot = path.join(tempRoot, 'Program Files (x86)', 'Windows Kits', '10', 'bin', '10.0.26100.0', 'x64');
  await mkdir(kitsRoot, { recursive: true });
  const signToolPath = path.join(kitsRoot, 'signtool.exe');
  await writeFile(signToolPath, '');

  const candidates = findSignToolCandidates({
    env: {
      ProgramFiles: path.join(tempRoot, 'Program Files'),
      'ProgramFiles(x86)': path.join(tempRoot, 'Program Files (x86)')
    }
  });

  assert.deepEqual(candidates, [signToolPath]);
});

test('findSignToolCandidates prefers SIGNTOOL_PATH when provided', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'signtool-path-'));
  const explicitPath = path.join(tempRoot, 'signtool.exe');
  await writeFile(explicitPath, '');

  const candidates = findSignToolCandidates({
    env: {
      SIGNTOOL_PATH: explicitPath
    }
  });

  assert.equal(candidates[0], explicitPath);
});
