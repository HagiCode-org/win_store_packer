import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { publishRelease } from '../scripts/publish-release.mjs';
import { writeJson } from '../scripts/lib/fs-utils.mjs';

test('publishRelease creates or updates a GitHub release and uploads the store package and metadata assets', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-publish-'));
  const artifactsDir = path.join(tempRoot, 'artifacts');
  const outputDir = path.join(tempRoot, 'output');
  const planPath = path.join(tempRoot, 'build-plan.json');
  const signedArtifactsDir = path.join(artifactsDir, 'signed');
  const unsignedArtifactsDir = path.join(artifactsDir, 'unsigned');
  const unsignedMsixPath = path.join(artifactsDir, 'hagicode-store-store-desktop-v0.3.0-server-v0.1.0-beta.34-win-x64-unsigned.appx');
  const signedMsixPath = path.join(artifactsDir, 'hagicode-store-store-desktop-v0.3.0-server-v0.1.0-beta.34-win-x64-signed.appx');
  await mkdir(signedArtifactsDir, { recursive: true });
  await mkdir(unsignedArtifactsDir, { recursive: true });
  await writeFile(unsignedMsixPath, 'fixture-unsigned');
  await writeFile(signedMsixPath, 'fixture-signed');
  await writeJson(path.join(unsignedArtifactsDir, 'artifact-inventory-win-x64-unsigned.json'), {
    platform: 'win-x64',
    artifactVariant: 'unsigned',
    storePackageVersion: '0.3.0.0',
    artifacts: [
      {
        platform: 'win-x64',
        fileName: path.basename(unsignedMsixPath),
        outputPath: unsignedMsixPath,
        sizeBytes: 16,
        sha256: 'abc',
        variant: 'unsigned',
        signed: false,
        primaryForStoreSubmission: true
      },
    ]
  });
  await writeJson(path.join(signedArtifactsDir, 'artifact-inventory-win-x64-signed.json'), {
    platform: 'win-x64',
    artifactVariant: 'signed',
    storePackageVersion: '0.3.0.0',
    artifacts: [
      {
        platform: 'win-x64',
        fileName: path.basename(signedMsixPath),
        outputPath: signedMsixPath,
        sizeBytes: 14,
        sha256: 'def',
        variant: 'signed',
        signed: true,
        primaryForStoreSubmission: false
      }
    ]
  });
  await writeJson(path.join(unsignedArtifactsDir, 'store-desktop-v0.3.0-server-v0.1.0-beta.34.asset-upload-result.json'), {
    uploadedAssets: [
      {
        name: path.basename(unsignedMsixPath),
        url: `https://example.test/${path.basename(unsignedMsixPath)}`
      }
    ]
  });
  await writeJson(path.join(signedArtifactsDir, 'store-desktop-v0.3.0-server-v0.1.0-beta.34.asset-upload-result.json'), {
    uploadedAssets: [
      {
        name: path.basename(signedMsixPath),
        url: `https://example.test/${path.basename(signedMsixPath)}`
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
  assert.equal(result.uploadedAssets.length, 3);
  assert.ok(requests.some((request) => request.url.includes('/releases') && request.method === 'POST'));
  assert.ok(requests.some((request) => request.url.includes('uploads.github.com') && request.method === 'POST'));

  const metadataPath = path.join(outputDir, 'store-desktop-v0.3.0-server-v0.1.0-beta.34.release-metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  assert.equal(metadata.distributionMode, 'steam');
  assert.equal(metadata.runtimeSource, 'portable-fixed');
  assert.equal(metadata.storePackageVersion, '0.3.0.0');
  assert.equal(metadata.artifacts.filter((artifact) => /\.(appx|msix)$/i.test(artifact.fileName)).length, 2);
  assert.equal(metadata.artifacts.find((artifact) => artifact.primaryForStoreSubmission)?.variant, 'unsigned');
});


test('publishRelease resolves AppX artifacts from merged workflow artifact directories', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'win-store-publish-merged-'));
  const artifactsDir = path.join(tempRoot, 'artifacts');
  const outputDir = path.join(tempRoot, 'output');
  const planPath = path.join(tempRoot, 'build-plan.json');
  const signedArtifactDir = path.join(artifactsDir, 'store-package-win-x64-signed', 'release-assets');
  const unsignedArtifactDir = path.join(artifactsDir, 'store-package-win-x64-unsigned', 'release-assets');
  const signedInventoryDir = path.join(artifactsDir, 'store-package-win-x64-signed');
  const unsignedInventoryDir = path.join(artifactsDir, 'store-package-win-x64-unsigned');
  const signedFileName = 'hagicode-store-store-desktop-v0.3.0-server-v0.1.0-beta.34-win-x64-signed.appx';
  const unsignedFileName = 'hagicode-store-store-desktop-v0.3.0-server-v0.1.0-beta.34-win-x64-unsigned.appx';
  const signedMsixPath = path.join(signedArtifactDir, signedFileName);
  const unsignedMsixPath = path.join(unsignedArtifactDir, unsignedFileName);

  await mkdir(signedArtifactDir, { recursive: true });
  await mkdir(unsignedArtifactDir, { recursive: true });
  await writeFile(unsignedMsixPath, 'fixture-unsigned');
  await writeFile(signedMsixPath, 'fixture-signed');
  await writeJson(path.join(unsignedInventoryDir, 'artifact-inventory-win-x64-unsigned.json'), {
    platform: 'win-x64',
    artifactVariant: 'unsigned',
    storePackageVersion: '0.3.0.0',
    artifacts: [
      {
        platform: 'win-x64',
        fileName: unsignedFileName,
        outputPath: 'D:\\a\\_temp\\store-release-win-x64-unsigned\\release-assets\\' + unsignedFileName,
        sizeBytes: 16,
        sha256: 'abc',
        variant: 'unsigned',
        signed: false,
        primaryForStoreSubmission: true
      }
    ]
  });
  await writeJson(path.join(signedInventoryDir, 'artifact-inventory-win-x64-signed.json'), {
    platform: 'win-x64',
    artifactVariant: 'signed',
    storePackageVersion: '0.3.0.0',
    artifacts: [
      {
        platform: 'win-x64',
        fileName: signedFileName,
        outputPath: 'D:\\a\\_temp\\store-release-win-x64-signed\\release-assets\\' + signedFileName,
        sizeBytes: 14,
        sha256: 'def',
        variant: 'signed',
        signed: true,
        primaryForStoreSubmission: false
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
      dryRun: true
    },
    handoff: {
      schema: 'win-store-packer-handoff/v1',
      producer: { repository: 'HagiCode-org/win_store_packer', workflow: 'package-release' },
      consumer: { repository: 'HagiCode-org/win_store_packer', workflow: 'package-release' }
    }
  });

  const result = await publishRelease({
    planPath,
    artifactsDir,
    outputDir
  });

  assert.equal(result.dryRun, true);
  const dryRunReportPath = path.join(outputDir, 'store-desktop-v0.3.0-server-v0.1.0-beta.34.publish-dry-run.json');
  const dryRunReport = JSON.parse(await readFile(dryRunReportPath, 'utf8'));
  assert.equal(dryRunReport.uploads.find((upload) => upload.fileName === signedFileName)?.filePath, signedMsixPath);
  assert.equal(dryRunReport.uploads.find((upload) => upload.fileName === unsignedFileName)?.filePath, unsignedMsixPath);

  const metadataPath = path.join(outputDir, 'store-desktop-v0.3.0-server-v0.1.0-beta.34.release-metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  assert.equal(metadata.artifacts.find((artifact) => artifact.fileName === signedFileName)?.uploadPath, signedMsixPath);
  assert.equal(metadata.artifacts.find((artifact) => artifact.fileName === unsignedFileName)?.uploadPath, unsignedMsixPath);
});
