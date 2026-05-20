#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cleanDir, copyDir, ensureDir, listFilesRecursively, pathExists, readJson, writeJson, copySingleFile } from './lib/fs-utils.mjs';
import { createArchive } from './lib/archive.mjs';
import { createArtifactRecord } from './lib/artifacts.mjs';
import { runCommand } from './lib/command.mjs';
import { loadReleasePlan } from './lib/release-plan.mjs';
import { buildStoreArtifactName } from './lib/platforms.mjs';
import { loadStorePackageConfig } from './lib/store-config.mjs';
import { writeStoreElectronBuilderConfig } from './lib/appx-config.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function runShellCommand(commandText, cwd) {
  if (process.platform === 'win32') {
    await runCommand('cmd.exe', ['/d', '/s', '/c', commandText], { cwd });
    return;
  }

  await runCommand('/bin/bash', ['-lc', commandText], { cwd });
}

function selectAvailableScript(scripts, candidates) {
  return candidates.find((scriptName) => typeof scripts?.[scriptName] === 'string') ?? null;
}

function buildDesktopStoreCommand(overlayConfigPath, scripts) {
  const overlayConfigName = path.basename(overlayConfigPath);
  const commands = [];

  const runtimeScript = selectAvailableScript(scripts, ['prepare:runtime', 'prepare:runtime:optional']);
  const toolchainScript = selectAvailableScript(scripts, ['prepare:bundled-toolchain', 'prepare:bundled-toolchain:optional']);
  const codeServerScript = selectAvailableScript(scripts, ['prepare:code-server-runtime', 'prepare:code-server-runtime:optional']);
  const omnirouteScript = selectAvailableScript(scripts, ['prepare:omniroute-runtime', 'prepare:omniroute-runtime:optional']);
  const buildProdScript = selectAvailableScript(scripts, ['build:prod', 'build:all', 'build']);
  const smokeTestScript = selectAvailableScript(scripts, ['package:smoke-test', 'smoke-test']);

  for (const scriptName of [runtimeScript, toolchainScript, codeServerScript, omnirouteScript, buildProdScript]) {
    if (scriptName) {
      commands.push(`npm run ${scriptName}`);
    }
  }

  commands.push(`node scripts/run-electron-builder.js --win appx --publish never --config ${overlayConfigName}`);

  if (smokeTestScript) {
    commands.push(`npm run ${smokeTestScript}`);
  }

  return commands.join(' && ');
}

async function createSyntheticStorePackage({
  artifactPath,
  desktopWorkspace,
  runtimeInjectionRoot,
  packageIdentity
}) {
  const stagingRoot = path.join(path.dirname(artifactPath), '.synthetic-msix');
  await cleanDir(stagingRoot);
  await ensureDir(path.join(stagingRoot, 'extra', 'portable-fixed'));
  await copyDir(runtimeInjectionRoot, path.join(stagingRoot, 'extra', 'portable-fixed', 'current'));
  await writeJson(path.join(stagingRoot, 'store-package-identity.json'), packageIdentity);
  await createArchive(stagingRoot, artifactPath);
}

async function findStoreOutputs(pkgDirectory) {
  if (!(await pathExists(pkgDirectory))) {
    return [];
  }

  const files = await listFilesRecursively(pkgDirectory);
  return files
    .filter((filePath) => {
      const lowerPath = filePath.toLowerCase();
      return lowerPath.endsWith('.appx') || lowerPath.endsWith('.msix');
    })
    .sort((left, right) => {
      const leftLower = left.toLowerCase();
      const rightLower = right.toLowerCase();
      if (leftLower.endsWith('.msix') !== rightLower.endsWith('.msix')) {
        return leftLower.endsWith('.msix') ? -1 : 1;
      }
      return leftLower.localeCompare(rightLower);
    });
}

async function shouldUseSyntheticDryRunBuild(desktopWorkspace, planDryRun) {
  if (!planDryRun) {
    return false;
  }

  const packageJsonPath = path.join(desktopWorkspace, 'package.json');
  if (!(await pathExists(packageJsonPath))) {
    return true;
  }

  const packageJson = await readJson(packageJsonPath);
  const scripts = packageJson?.scripts ?? {};
  const requiredScripts = [
    'prepare:runtime',
    'prepare:bundled-toolchain',
    'prepare:code-server-runtime',
    'prepare:omniroute-runtime',
    'build:prod',
    'package:smoke-test'
  ];

  if (requiredScripts.some((scriptName) => typeof scripts[scriptName] !== 'string')) {
    return true;
  }

  return !(await pathExists(path.join(desktopWorkspace, 'scripts', 'run-electron-builder.js')));
}

export async function buildAppx({
  planPath,
  workspacePath,
  platformId,
  forceDryRun = false,
  desktopBuildCommand
}) {
  const { plan } = await loadReleasePlan(planPath);
  const storePackageConfig = await loadStorePackageConfig();
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const workspaceManifest = await readJson(path.join(resolvedWorkspacePath, 'workspace-manifest.json'));

  if (!storePackageConfig.supportedWindowsTargets.includes(platformId)) {
    throw new Error(`Unsupported Windows target ${platformId}. Supported targets: ${storePackageConfig.supportedWindowsTargets.join(', ')}`);
  }

  const pkgDirectory = path.join(workspaceManifest.desktopWorkspace, 'pkg');
  await ensureDir(pkgDirectory);
  const overlayConfig = await writeStoreElectronBuilderConfig({
    desktopWorkspace: workspaceManifest.desktopWorkspace,
    sourceConfigPath: storePackageConfig.desktop.electronBuilderConfigPath,
    outputConfigPath: 'electron-builder.store.yml'
  });

  const packageLockPath = path.join(workspaceManifest.desktopWorkspace, 'package-lock.json');
  if (!forceDryRun && await pathExists(packageLockPath)) {
    await runCommand(npmCommand(), ['ci'], { cwd: workspaceManifest.desktopWorkspace });
  }

  const desktopPackageJson = await readJson(path.join(workspaceManifest.desktopWorkspace, 'package.json'));
  const desktopScripts = desktopPackageJson?.scripts ?? {};
  const syntheticDryRun = forceDryRun || (await shouldUseSyntheticDryRunBuild(workspaceManifest.desktopWorkspace, plan.build.dryRun));

  if (syntheticDryRun) {
    await createSyntheticStorePackage({
      artifactPath: path.join(pkgDirectory, buildStoreArtifactName(plan.release.tag, platformId)),
      desktopWorkspace: workspaceManifest.desktopWorkspace,
      runtimeInjectionRoot: workspaceManifest.runtimeInjectionRoot,
      packageIdentity: storePackageConfig.packageIdentity
    });
  } else if (desktopBuildCommand) {
    await runShellCommand(desktopBuildCommand, workspaceManifest.desktopWorkspace);
  } else {
    await runShellCommand(
      buildDesktopStoreCommand(overlayConfig.outputPath, desktopScripts),
      workspaceManifest.desktopWorkspace
    );
  }

  const storeOutputs = await findStoreOutputs(pkgDirectory);
  if (storeOutputs.length === 0) {
    throw new Error(`No Store package outputs (.appx or .msix) were produced under ${pkgDirectory}.`);
  }

  const primaryOutput = storeOutputs[0];
  const artifactFileName = buildStoreArtifactName(plan.release.tag, platformId);
  const artifactPath = path.join(workspaceManifest.outputDirectory, artifactFileName);
  await ensureDir(workspaceManifest.outputDirectory);
  await copySingleFile(primaryOutput, artifactPath);

  const buildMetadata = {
    validationPassed: true,
    platform: platformId,
    distributionMode: 'steam',
    runtimeSource: 'portable-fixed',
    desktopVersion: workspaceManifest.desktopVersion,
    desktopTag: workspaceManifest.desktopTag,
    desktopRef: workspaceManifest.desktopRef,
    serverVersion: workspaceManifest.serverVersion,
    releaseTag: workspaceManifest.releaseTag,
    buildMode: syntheticDryRun ? 'synthetic-dry-run' : 'desktop-build-script',
    sourceElectronBuilderConfigPath: overlayConfig.sourcePath,
    outputElectronBuilderConfigPath: overlayConfig.outputPath,
    rawStoreOutputs: storeOutputs,
    publishedArtifactPath: artifactPath
  };
  const buildMetadataPath = path.join(resolvedWorkspacePath, `build-metadata-${platformId}.json`);
  await writeJson(buildMetadataPath, buildMetadata);

  const artifactRecord = await createArtifactRecord({
    artifactPath,
    platformId,
    metadata: {
      distributionMode: 'steam',
      runtimeSource: 'portable-fixed',
      desktopVersion: workspaceManifest.desktopVersion,
      desktopTag: workspaceManifest.desktopTag,
      desktopRef: workspaceManifest.desktopRef,
      serverVersion: workspaceManifest.serverVersion
    }
  });
  const artifactInventory = {
    platform: platformId,
    releaseTag: workspaceManifest.releaseTag,
    artifacts: [artifactRecord],
    buildMetadataPath,
    workspaceValidationPath: path.join(resolvedWorkspacePath, `workspace-validation-${platformId}.json`),
    payloadValidationPath: path.join(resolvedWorkspacePath, `payload-validation-${platformId}.json`)
  };
  const artifactInventoryPath = path.join(resolvedWorkspacePath, `artifact-inventory-${platformId}.json`);
  await writeJson(artifactInventoryPath, artifactInventory);

  await appendSummary([
    `### MSIX build prepared for ${platformId}`,
    `- Release tag: ${workspaceManifest.releaseTag}`,
    `- Desktop tag: ${workspaceManifest.desktopTag}`,
    `- Server version: ${workspaceManifest.serverVersion}`,
    '- Distribution mode: steam',
    `- Artifact: ${artifactFileName}`,
    `- Build mode: ${buildMetadata.buildMode}`
  ]);

  return {
    artifactInventoryPath,
    buildMetadataPath,
    artifactPath
  };
}

export async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      platform: { type: 'string' },
      workspace: { type: 'string' },
      'force-dry-run': { type: 'boolean' },
      'desktop-build-command': { type: 'string' }
    }
  });

  if (!values.plan || !values.platform || !values.workspace) {
    throw new Error('build-appx requires --plan, --platform, and --workspace.');
  }

  const result = await buildAppx({
    planPath: values.plan,
    workspacePath: values.workspace,
    platformId: values.platform,
    forceDryRun: values['force-dry-run'] ?? false,
    desktopBuildCommand: values['desktop-build-command']
  });

  console.log(JSON.stringify(result, null, 2));
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## MSIX build failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
