import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildInstalledAppLaunchCommand,
  buildInstallPackageCommand,
  buildLaunchArguments,
  buildMsixContentRequirements,
  buildMsixContentValidationCommand,
  buildRemovePackageCommand,
  parseArgs,
  resolveArtifactInventoryPath,
  resolveBuildMetadataPath,
  resolvePrimaryMsixPath,
  runLocalWinStoreTest
} from '../scripts/run-local-win-store-test.mjs';

test('parseArgs applies defaults and environment fallbacks', () => {
  const defaults = parseArgs([], {});
  assert.equal(defaults.plan.endsWith(path.join('build', 'release-plan.json')), true);
  assert.equal(defaults.platform, 'win-x64');
  assert.equal(defaults.workspace.endsWith(path.join('build', 'store-win-x64')), true);
  assert.equal(defaults.skipBuild, false);

  const options = parseArgs([
    '--plan', 'plans/local.json',
    '--packer-release-tag', 'v1.2.3',
    '--desktop-source', 'desktop',
    '--platform', 'win-arm64',
    '--workspace', 'workspace',
    '--server-asset-source', 'server.zip',
    '--dlc-asset-source', 'dlc.zip',
    '--purchase-smoke-test',
    '--force-renderer-accessibility',
    '--skip-build'
  ], {});
  assert.equal(options.plan.endsWith(path.join('plans', 'local.json')), true);
  assert.equal(options.packerReleaseTag, 'v1.2.3');
  assert.equal(options.platform, 'win-arm64');
  assert.equal(options.workspace.endsWith('workspace'), true);
  assert.equal(options.serverAssetSource, 'server.zip');
  assert.equal(options.dlcAssetSource, 'dlc.zip');
  assert.equal(options.purchaseSmokeTest, true);
  assert.equal(options.forceRendererAccessibility, true);
  assert.equal(options.skipBuild, true);

  const envOptions = parseArgs([], {
    WIN_STORE_PACKER_RELEASE_TAG: 'v2.0.0',
    WIN_STORE_PACKER_PLATFORM: 'win-x64',
    WIN_STORE_PACKER_PUBLIC_BASE_URL: 'https://artifacts.example.test'
  });
  assert.equal(envOptions.packerReleaseTag, 'v2.0.0');
  assert.equal(envOptions.serverPublicBaseUrl, 'https://artifacts.example.test');
  assert.equal(envOptions.dlcPublicBaseUrl, 'https://artifacts.example.test');
});

test('parseArgs rejects unknown and incomplete options', () => {
  assert.throws(() => parseArgs(['--not-supported'], {}), /Invalid local Win Store option/);
  assert.throws(() => parseArgs(['--workspace'], {}), /Invalid local Win Store option/);
});

test('launch flag translation remains compatible with Desktop local testing', () => {
  assert.deepEqual(buildLaunchArguments({
    purchaseSmokeTest: false,
    forceRendererAccessibility: false
  }), []);
  assert.deepEqual(buildLaunchArguments({
    purchaseSmokeTest: true,
    forceRendererAccessibility: true
  }), [
    '--desktop-subscription-purchase-smoke-test=1',
    '--force-renderer-accessibility'
  ]);
});

test('derives workspace metadata and primary MSIX paths', () => {
  const workspace = path.resolve('build/store-win-x64');
  assert.equal(
    resolveArtifactInventoryPath(workspace, 'win-x64'),
    path.join(workspace, 'artifact-inventory-win-x64-unsigned.json')
  );
  assert.equal(
    resolveBuildMetadataPath(workspace, 'win-x64'),
    path.join(workspace, 'build-metadata-win-x64-unsigned.json')
  );
  assert.equal(
    resolvePrimaryMsixPath({
      workspacePath: workspace,
      artifactInventory: {
        artifacts: [{ outputPath: 'release-assets/local.msix' }]
      },
      buildMetadata: null
    }),
    path.join(workspace, 'release-assets', 'local.msix')
  );
  assert.throws(
    () => resolvePrimaryMsixPath({
      workspacePath: workspace,
      artifactInventory: { artifacts: [{ outputPath: 'release-assets/local.zip' }] },
      buildMetadata: null
    }),
    /\.msix/
  );
});

test('constructs quoted PowerShell package and launch commands', () => {
  const packagePath = 'C:\\work dir\\Hagicode\'s.msix';
  const removeCommand = buildRemovePackageCommand("newbe36524.Hagicode'o");
  const installCommand = buildInstallPackageCommand(packagePath);
  const launchCommand = buildInstalledAppLaunchCommand('newbe36524.Hagicode', [
    '--force-renderer-accessibility'
  ]);

  assert.match(removeCommand, /Hagicode''o/);
  assert.match(installCommand, /C:\\work dir\\Hagicode''s\.msix/);
  assert.match(installCommand, /Add-AppxPackage -Path/);
  assert.match(launchCommand, /Get-AppxPackage -Name 'newbe36524\.Hagicode'/);
  assert.match(launchCommand, /Get-AppxPackageManifest/);
  assert.match(launchCommand, /force-renderer-accessibility/);
  assert.match(launchCommand, /Start-Process/);
});

test('builds MSIX content requirements for the runtime and staged DLC', () => {
  const desktopWorkspace = path.join(os.tmpdir(), 'workspace', 'desktop');
  const runtimeInjectionPath = path.join(
    desktopWorkspace,
    'resources',
    'portable-fixed',
    'current'
  );
  const requirements = buildMsixContentRequirements({
    desktopWorkspace,
    runtimeInjectionPath,
    requiredPaths: ['manifest.json', 'lib/PCode.Web.dll'],
    includedDlcs: [{
      runtimeTargetPath: 'lib/dlcs/turbo-engine',
      runtimeIndexPath: 'lib/dlcs/index.json'
    }]
  });
  assert.deepEqual(requirements, [
    'resources/portable-fixed/current/manifest.json',
    'resources/portable-fixed/current/lib/PCode.Web.dll',
    'resources/portable-fixed/current/lib/dlcs/index.json'
  ]);

  const validationCommand = buildMsixContentValidationCommand(
    path.join(os.tmpdir(), 'work dir', 'package.msix'),
    requirements
  );
  assert.match(validationCommand, /ZipFile]::OpenRead/);
  assert.match(validationCommand, /portable-fixed\/current\/manifest\.json/);
  assert.match(validationCommand, /package\.msix/);
});

test('rejects non-Windows hosts before packaging or installation', async () => {
  let commandCalled = false;
  await assert.rejects(
    runLocalWinStoreTest({
      platform: 'linux',
      options: {
        plan: path.resolve('build/release-plan.json'),
        planExplicit: false,
        packerReleaseTag: 'v1.0.0',
        desktopSource: path.resolve('inputs/hagicode-desktop'),
        platform: 'win-x64',
        workspace: path.resolve('build/store-win-x64'),
        skipBuild: false
      },
      runCommandImpl: async () => {
        commandCalled = true;
      }
    }),
    /requires Windows/
  );
  assert.equal(commandCalled, false);
});

test('skip-build installs an existing Packer MSIX without packaging stages', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'win-store-local-test-'));
  const desktopWorkspace = path.join(workspace, 'desktop');
  const runtimePath = path.join(desktopWorkspace, 'resources', 'portable-fixed', 'current');
  await mkdir(runtimePath, { recursive: true });
  const msixPath = path.join(workspace, 'release-assets', 'local.msix');
  await mkdir(path.dirname(msixPath), { recursive: true });
  await writeFile(msixPath, 'test-msix');

  await writeFile(path.join(workspace, 'workspace-manifest.json'), JSON.stringify({
    platform: 'win-x64',
    desktopWorkspace,
    desktopStoreConfigPath: path.join(desktopWorkspace, 'config', 'store-package.json'),
    desktopStoreConfigRelativePath: 'config/store-package.json',
    runtimeInjectionRoot: runtimePath
  }));
  await writeFile(path.join(workspace, 'payload-validation-win-x64.json'), JSON.stringify({
    validationPassed: true,
    requiredPaths: ['manifest.json'],
    includedDlcs: [{ runtimeTargetPath: 'lib/dlcs/turbo-engine', runtimeIndexPath: 'lib/dlcs/index.json' }]
  }));
  await writeFile(path.join(workspace, 'build-metadata-win-x64-unsigned.json'), JSON.stringify({
    effectiveRuntimeInjectionPath: runtimePath,
    includedDlcs: [{ runtimeTargetPath: 'lib/dlcs/turbo-engine', runtimeIndexPath: 'lib/dlcs/index.json' }],
    store: { identityName: 'newbe36524.Hagicode' },
    publishedArtifactPath: msixPath
  }));

  const commands = [];
  const result = await runLocalWinStoreTest({
    platform: 'win32',
    options: {
      plan: path.join(workspace, 'unused-plan.json'),
      planExplicit: false,
      packerReleaseTag: null,
      desktopSource: path.join(workspace, 'desktop-source'),
      platform: 'win-x64',
      workspace,
      skipBuild: true,
      purchaseSmokeTest: true,
      forceRendererAccessibility: false
    },
    runCommandImpl: async (command, args) => {
      commands.push({ command, args });
    }
  });

  assert.equal(result.msixPath, msixPath);
  assert.equal(result.identityName, 'newbe36524.Hagicode');
  assert.equal(commands.length, 4);
  assert.match(commands[0].args.at(-1), /ZipFile/);
  assert.match(commands[1].args.at(-1), /Get-AppxPackage/);
  assert.match(commands[2].args.at(-1), /Add-AppxPackage -Path/);
  assert.match(commands[3].args.at(-1), /desktop-subscription-purchase-smoke-test=1/);
});
