import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { buildStoreSubmissionUpdate } from '../scripts/build-store-submission-update.mjs';
import { writeJson } from '../scripts/lib/fs-utils.mjs';

test('buildStoreSubmissionUpdate maps published store package assets into a Store submission payload', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-submission-'));
  const planPath = path.join(tempRoot, 'build-plan.json');
  const releaseMetadataDir = path.join(tempRoot, 'release-metadata');
  const outputPath = path.join(tempRoot, 'store-submission-update.json');

  await writeJson(planPath, {
    platforms: ['win-x64'],
    downloads: {
      desktop: {},
      server: {}
    },
    upstream: {
      desktop: {
        version: 'v0.3.0',
        tag: 'v0.3.0',
        manifestUrl: 'https://index.hagicode.com/desktop/index.json',
        assetsByPlatform: {
          'win-x64': {
            name: 'hagicode.desktop.0.3.0-unpacked.zip',
            path: 'v0.3.0/hagicode.desktop.0.3.0-unpacked.zip'
          }
        }
      },
      server: {
        version: '0.1.0-beta.34',
        manifestUrl: 'https://index.hagicode.com/server/index.json',
        assetsByPlatform: {
          'win-x64': {
            name: 'hagicode-0.1.0-beta.34-win-x64-nort.zip',
            path: '0.1.0-beta.34/hagicode-0.1.0-beta.34-win-x64-nort.zip'
          }
        }
      }
    },
    store: {
      packageIdentity: {
        displayName: 'Hagicode',
        publisherDisplayName: 'newbe36524',
        publisher: 'CN=8B6C8A94-AAE5-4C8B-9202-A29EA42B042F',
        identityName: 'newbe36524.Hagicode',
        backgroundColor: 'transparent',
        languages: ['en-US', 'zh-CN'],
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

  await writeJson(path.join(releaseMetadataDir, 'store-desktop-v0.3.0-server-v0.1.0-beta.34.release-metadata.json'), {
    releaseTag: 'store-desktop-v0.3.0-server-v0.1.0-beta.34',
    storePackageVersion: '0.3.0.0',
    artifacts: [
      {
        platform: 'win-x64',
        fileName: 'hagicode-store-store-desktop-v0.3.0-server-v0.1.0-beta.34-win-x64-unsigned.appx',
        variant: 'unsigned',
        signed: false,
        primaryForStoreSubmission: false
      },
      {
        platform: 'win-x64',
        fileName: 'hagicode-store-store-desktop-v0.3.0-server-v0.1.0-beta.34-win-x64-signed.appx',
        variant: 'signed',
        signed: true,
        primaryForStoreSubmission: true
      },
      {
        platform: 'win-x64',
        fileName: 'store-desktop-v0.3.0-server-v0.1.0-beta.34.release-metadata.json'
      }
    ]
  });

  await writeJson(path.join(releaseMetadataDir, 'store-desktop-v0.3.0-server-v0.1.0-beta.34.publication-result.json'), {
    dryRun: false,
    releaseTag: 'store-desktop-v0.3.0-server-v0.1.0-beta.34',
    uploadedAssets: [
      {
        name: 'hagicode-store-store-desktop-v0.3.0-server-v0.1.0-beta.34-win-x64-unsigned.appx',
        url: 'https://github.com/HagiCode-org/win_store_packer/releases/download/store-desktop-v0.3.0-server-v0.1.0-beta.34/hagicode-store-store-desktop-v0.3.0-server-v0.1.0-beta.34-win-x64-unsigned.appx'
      },
      {
        name: 'hagicode-store-store-desktop-v0.3.0-server-v0.1.0-beta.34-win-x64-signed.appx',
        url: 'https://github.com/HagiCode-org/win_store_packer/releases/download/store-desktop-v0.3.0-server-v0.1.0-beta.34/hagicode-store-store-desktop-v0.3.0-server-v0.1.0-beta.34-win-x64-signed.appx'
      },
      {
        name: 'store-desktop-v0.3.0-server-v0.1.0-beta.34.release-metadata.json',
        url: 'https://example.test/metadata.json'
      }
    ]
  });

  const result = await buildStoreSubmissionUpdate({
    planPath,
    releaseMetadataDir,
    outputPath
  });

  assert.deepEqual(result.payload, {
    packages: [
      {
        packageUrl: 'https://github.com/HagiCode-org/win_store_packer/releases/download/store-desktop-v0.3.0-server-v0.1.0-beta.34/hagicode-store-store-desktop-v0.3.0-server-v0.1.0-beta.34-win-x64-signed.appx',
        languages: ['en-US', 'zh-CN'],
        architectures: ['X64']
      }
    ]
  });
});
