import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { publishRelease } from '../scripts/publish-release.mjs';
import { writeJson } from '../scripts/lib/fs-utils.mjs';

test('publishRelease creates or updates a GitHub release and uploads the appx and metadata assets', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-publish-'));
  const artifactsDir = path.join(tempRoot, 'artifacts');
  const outputDir = path.join(tempRoot, 'output');
  const planPath = path.join(tempRoot, 'build-plan.json');
  const appxPath = path.join(artifactsDir, 'hagicode-store-store-desktop-v0.3.0-server-v0.1.0-beta.34-win-x64.appx');
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(appxPath, 'fixture');
  await writeJson(path.join(artifactsDir, 'artifact-inventory-win-x64.json'), {
    platform: 'win-x64',
    artifacts: [
      {
        platform: 'win-x64',
        fileName: path.basename(appxPath),
        outputPath: appxPath,
        sizeBytes: 7,
        sha256: 'abc'
      }
    ]
  });
  await writeJson(planPath, {
    platforms: ['win-x64'],
    downloads: {
      desktop: {},
      server: {}
    },
    upstream: {
      desktop: { version: 'v0.3.0', tag: 'v0.3.0', manifestUrl: 'https://index.hagicode.com/desktop/index.json', assetsByPlatform: { 'win-x64': { name: 'desktop.zip', path: 'desktop.zip' } } },
      server: { version: '0.1.0-beta.34', manifestUrl: 'https://index.hagicode.com/server/index.json', assetsByPlatform: { 'win-x64': { name: 'server.zip', path: 'server.zip' } } }
    },
    store: {
      packageIdentity: {
        displayName: 'Hagicode',
        publisherDisplayName: 'newbe36524',
        publisher: 'CN=8B6C8A94-AAE5-4C8B-9202-A29EA42B042F',
        identityName: 'newbe36524.Hagicode',
        backgroundColor: 'transparent',
        languages: ['en-US'],
        addAutoLaunchExtension: false
      },
      supportedWindowsTargets: ['win-x64']
    },
    release: {
      repository: 'HagiCode-org/win_store_packer',
      tag: 'store-desktop-v0.3.0-server-v0.1.0-beta.34',
      name: 'Windows Store store-desktop-v0.3.0-server-v0.1.0-beta.34'
    },
    build: {
      shouldBuild: true,
      forceRebuild: false,
      dryRun: false
    },
    handoff: {
      schema: 'win-store-packer-handoff/v1',
      producer: { repository: 'HagiCode-org/win_store_packer', workflow: 'package-release' },
      consumer: { repository: 'HagiCode-org/win_store_packer', workflow: 'package-release' }
    }
  });

  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method ?? 'GET' });

    if (String(url).includes('/releases/tags/')) {
      return new Response('not found', { status: 404 });
    }

    if (String(url).endsWith('/repos/HagiCode-org/win_store_packer/releases')) {
      return Response.json({
        id: 42,
        html_url: 'https://github.com/HagiCode-org/win_store_packer/releases/tag/store-desktop-v0.3.0-server-v0.1.0-beta.34',
        upload_url: 'https://uploads.github.com/repos/HagiCode-org/win_store_packer/releases/42/assets{?name,label}',
        assets: []
      });
    }

    if (String(url).startsWith('https://uploads.github.com/repos/HagiCode-org/win_store_packer/releases/42/assets')) {
      const name = new URL(String(url)).searchParams.get('name');
      return Response.json({
        id: Math.floor(Math.random() * 1000),
        name,
        browser_download_url: `https://example.test/${name}`
      });
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const result = await publishRelease({
    planPath,
    artifactsDir,
    outputDir,
    token: 'test-token',
    fetchImpl
  });

  assert.equal(result.releaseAction, 'created');
  assert.equal(result.uploadedAssets.length, 2);
  assert.ok(requests.some((request) => request.url.includes('/releases') && request.method === 'POST'));
  assert.ok(requests.some((request) => request.url.includes('uploads.github.com') && request.method === 'POST'));

  const metadataPath = path.join(outputDir, 'store-desktop-v0.3.0-server-v0.1.0-beta.34.release-metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  assert.equal(metadata.distributionMode, 'steam');
  assert.equal(metadata.runtimeSource, 'portable-fixed');
});
