import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import {
  compareWindowsKitVersions,
  listInstalledWindowsKitVersions,
  resolvePreferredWindowsKitVersion,
  resolveWindowsKitOverride,
} from '../scripts/lib/windows-kit.mjs';

test('compareWindowsKitVersions orders Windows SDK versions numerically', () => {
  assert(compareWindowsKitVersions('10.0.22621.0', '10.0.19041.0') > 0);
  assert(compareWindowsKitVersions('10.0.19041.0', '10.0.19041.0') === 0);
  assert(compareWindowsKitVersions('10.0.17763.0', '10.0.19041.0') < 0);
});

test('listInstalledWindowsKitVersions returns only valid SDK directories in descending order', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'windows-kits-'));
  await mkdir(path.join(tempRoot, '10.0.17763.0'), { recursive: true });
  await mkdir(path.join(tempRoot, '10.0.22621.0'), { recursive: true });
  await mkdir(path.join(tempRoot, 'not-a-version'), { recursive: true });

  const versions = await listInstalledWindowsKitVersions(tempRoot);
  assert.deepEqual(versions, ['10.0.22621.0', '10.0.17763.0']);
});

test('resolvePreferredWindowsKitVersion prefers the desktop-tested SDK when it is installed', () => {
  const version = resolvePreferredWindowsKitVersion({
    availableVersions: ['10.0.22621.0', '10.0.19041.0'],
    preferredVersions: ['10.0.19041.0', '10.0.17763.0'],
  });

  assert.equal(version, '10.0.19041.0');
});

test('resolvePreferredWindowsKitVersion falls back to the newest installed SDK when preferred ones are unavailable', () => {
  const version = resolvePreferredWindowsKitVersion({
    availableVersions: ['10.0.22621.0', '10.0.19041.0'],
    preferredVersions: ['10.0.17763.0'],
  });

  assert.equal(version, '10.0.22621.0');
});

test('resolveWindowsKitOverride returns an explicit Forge override on Windows runners', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'windows-kits-'));
  await mkdir(path.join(tempRoot, '10.0.19041.0'), { recursive: true });
  await mkdir(path.join(tempRoot, '10.0.22621.0'), { recursive: true });

  const override = await resolveWindowsKitOverride({
    platform: 'win32',
    env: {},
    windowsKitsBinRoot: tempRoot,
    preferredVersions: ['10.0.19041.0', '10.0.17763.0'],
  });

  assert.deepEqual(override, {
    version: '10.0.19041.0',
    windowsKitPath: path.join(tempRoot, '10.0.19041.0'),
    availableVersions: ['10.0.22621.0', '10.0.19041.0'],
  });
});

test('resolveWindowsKitOverride respects explicit caller-provided SDK settings', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'windows-kits-'));
  await mkdir(path.join(tempRoot, '10.0.22621.0'), { recursive: true });

  const override = await resolveWindowsKitOverride({
    platform: 'win32',
    env: {
      WINDOWS_KIT_VERSION: '10.0.22621.0',
    },
    windowsKitsBinRoot: tempRoot,
    preferredVersions: ['10.0.19041.0'],
  });

  assert.equal(override, null);
});
