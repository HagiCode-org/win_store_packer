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
import {
  buildDesktopStoreCommand,
  resolveDesktopStoreBuildStrategy,
  shouldUseSyntheticDryRunBuild
} from './lib/desktop-build.mjs';
import {
  loadStorePackageConfig,
  normalizeStorePackageVersion,
  normalizeStoreSigningMode,
  resolveStoreSigningConfig
} from './lib/store-config.mjs';
import { writeStoreElectronBuilderConfig } from './lib/appx-config.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const STORE_PACKAGE_EXTENSIONS = new Set(['.appx', '.msix']);

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

async function createSyntheticStorePackage({
  artifactPath,
  runtimeInjectionRoot,
  packageIdentity,
  packageVersion
}) {
  const stagingRoot = path.join(path.dirname(artifactPath), '.synthetic-msix');
  await cleanDir(stagingRoot);
  await ensureDir(path.join(stagingRoot, 'extra', 'portable-fixed'));
  await copyDir(runtimeInjectionRoot, path.join(stagingRoot, 'extra', 'portable-fixed', 'current'));
  await writeJson(path.join(stagingRoot, 'store-package-identity.json'), {
    ...packageIdentity,
    packageVersion
  });
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
      return STORE_PACKAGE_EXTENSIONS.has(path.extname(lowerPath));
    })
    .sort((left, right) => {
      const leftLower = left.toLowerCase();
      const rightLower = right.toLowerCase();
      const leftExtension = path.extname(leftLower);
      const rightExtension = path.extname(rightLower);
      if (leftExtension !== rightExtension) {
        if (leftExtension === '.appx') {
          return -1;
        }
        if (rightExtension === '.appx') {
          return 1;
        }
      }
      return leftLower.localeCompare(rightLower);
    });
}

export async function buildAppx({
  planPath,
  workspacePath,
  platformId,
  forceDryRun = false,
  desktopBuildCommand,
  signingMode = 'disabled'
}) {
  const { plan } = await loadReleasePlan(planPath);
  const storePackageConfig = await loadStorePackageConfig();
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const workspaceManifest = await readJson(path.join(resolvedWorkspacePath, 'workspace-manifest.json'));
  const storePackageVersion = normalizeStorePackageVersion(plan.upstream.desktop.tag, storePackageConfig.packageVersion);
  const normalizedSigningMode = normalizeStoreSigningMode(signingMode);
  const signingConfig = resolveStoreSigningConfig({
    storePackageConfig,
    signingMode: normalizedSigningMode
  });

  if (!storePackageConfig.supportedWindowsTargets.includes(platformId)) {
    throw new Error(`Unsupported Windows target ${platformId}. Supported targets: ${storePackageConfig.supportedWindowsTargets.join(', ')}`);
  }

  const pkgDirectory = path.join(workspaceManifest.desktopWorkspace, 'pkg');
  await ensureDir(pkgDirectory);
  const overlayConfig = await writeStoreElectronBuilderConfig({
    desktopWorkspace: workspaceManifest.desktopWorkspace,
    sourceConfigPath: storePackageConfig.desktop.electronBuilderConfigPath,
    outputConfigPath: 'electron-builder.store.yml',
    packageVersion: storePackageVersion,
    publisherOverride: signingConfig.publisher
  });
  const verificationScriptPath = path.join(
    repoRoot,
    storePackageConfig.signing.verificationScriptRelativePath
  );

  if (signingConfig.enabled && !(await pathExists(verificationScriptPath))) {
    throw new Error(`Missing Store signature verification script at ${verificationScriptPath}.`);
  }

  const packageLockPath = path.join(workspaceManifest.desktopWorkspace, 'package-lock.json');
  if (!forceDryRun && await pathExists(packageLockPath)) {
    await runCommand(npmCommand(), ['ci'], { cwd: workspaceManifest.desktopWorkspace });
  }

  const desktopBuildStrategy = await resolveDesktopStoreBuildStrategy({
    desktopWorkspace: workspaceManifest.desktopWorkspace
  });
  const syntheticDryRun = forceDryRun || (await shouldUseSyntheticDryRunBuild({
    desktopWorkspace: workspaceManifest.desktopWorkspace,
    planDryRun: plan.build.dryRun
  }));

  if (syntheticDryRun) {
    await createSyntheticStorePackage({
      artifactPath: path.join(pkgDirectory, buildStoreArtifactName(plan.release.tag, platformId, 'unsigned')),
      runtimeInjectionRoot: workspaceManifest.runtimeInjectionRoot,
      packageIdentity: storePackageConfig.packageIdentity,
      packageVersion: storePackageVersion
    });
  } else if (desktopBuildCommand) {
    await runShellCommand(desktopBuildCommand, workspaceManifest.desktopWorkspace);
  } else {
    await runShellCommand(
      buildDesktopStoreCommand(overlayConfig.outputPath, desktopBuildStrategy),
      workspaceManifest.desktopWorkspace
    );
  }

  const storeOutputs = await findStoreOutputs(pkgDirectory);
  if (storeOutputs.length === 0) {
    throw new Error(`No Store package outputs (.appx/.msix) were produced under ${pkgDirectory}.`);
  }

  const primaryOutput = storeOutputs[0];
  const storePackageExtension = path.extname(primaryOutput).toLowerCase();
  if (!STORE_PACKAGE_EXTENSIONS.has(storePackageExtension)) {
    throw new Error(`Unsupported Store package extension ${storePackageExtension || '[none]'} from ${primaryOutput}.`);
  }

  const unsignedArtifactFileName = buildStoreArtifactName(plan.release.tag, platformId, 'unsigned', storePackageExtension);
  const unsignedArtifactPath = path.join(workspaceManifest.outputDirectory, unsignedArtifactFileName);
  await ensureDir(workspaceManifest.outputDirectory);
  await copySingleFile(primaryOutput, unsignedArtifactPath);

  let signedArtifactPath = null;
  if (signingConfig.enabled) {
    signedArtifactPath = path.join(
      workspaceManifest.outputDirectory,
      buildStoreArtifactName(plan.release.tag, platformId, 'signed', storePackageExtension)
    );
    await copySingleFile(unsignedArtifactPath, signedArtifactPath);
  }

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
    storePackageVersion,
    storePackageExtension,
    buildMode: syntheticDryRun
      ? 'synthetic-dry-run'
      : desktopBuildCommand
        ? 'custom-desktop-build-command'
        : 'desktop-build-pipeline',
    sourceElectronBuilderConfigPath: overlayConfig.sourcePath,
    outputElectronBuilderConfigPath: overlayConfig.outputPath,
    outputElectronBuilderBuildVersion: overlayConfig.packageVersion,
    rawStoreOutputs: storeOutputs,
    publishedArtifactPath: unsignedArtifactPath,
    artifacts: {
      unsigned: unsignedArtifactPath,
      signed: signedArtifactPath
    },
    signing: {
      mode: normalizedSigningMode,
      enabled: signingConfig.enabled,
      required: signingConfig.required,
      status: signingConfig.enabled ? 'pending-external-signing' : 'disabled',
      publisher: signingConfig.publisher,
      verificationScriptPath: signingConfig.enabled ? verificationScriptPath : null,
      stagedSignedArtifactPath: signedArtifactPath,
      missingConfiguration: signingConfig.missing
    }
  };
  const buildMetadataPath = path.join(resolvedWorkspacePath, `build-metadata-${platformId}.json`);
  await writeJson(buildMetadataPath, buildMetadata);

  const unsignedArtifactRecord = await createArtifactRecord({
    artifactPath: unsignedArtifactPath,
    platformId,
    metadata: {
      distributionMode: 'steam',
      runtimeSource: 'portable-fixed',
      desktopVersion: workspaceManifest.desktopVersion,
      desktopTag: workspaceManifest.desktopTag,
      desktopRef: workspaceManifest.desktopRef,
      serverVersion: workspaceManifest.serverVersion,
      storePackageVersion,
      storePackageExtension,
      variant: 'unsigned',
      signed: false,
      primaryForStoreSubmission: false
    }
  });
  const artifactInventory = {
    platform: platformId,
    releaseTag: workspaceManifest.releaseTag,
    storePackageVersion,
    signing: {
      mode: normalizedSigningMode,
      enabled: signingConfig.enabled,
      required: signingConfig.required,
      stagedSignedArtifactPath: signedArtifactPath
    },
    artifacts: [unsignedArtifactRecord],
    buildMetadataPath,
    workspaceValidationPath: path.join(resolvedWorkspacePath, `workspace-validation-${platformId}.json`),
    payloadValidationPath: path.join(resolvedWorkspacePath, `payload-validation-${platformId}.json`)
  };
  const artifactInventoryPath = path.join(resolvedWorkspacePath, `artifact-inventory-${platformId}.json`);
  await writeJson(artifactInventoryPath, artifactInventory);

  await appendSummary([
    `### Store package build prepared for ${platformId}`,
    `- Release tag: ${workspaceManifest.releaseTag}`,
    `- Desktop tag: ${workspaceManifest.desktopTag}`,
    `- Server version: ${workspaceManifest.serverVersion}`,
    `- Store package version: ${storePackageVersion}`,
    `- Store package extension: ${storePackageExtension}`,
    '- Distribution mode: steam',
    `- Unsigned artifact: ${unsignedArtifactFileName}`,
    `- Signing mode: ${normalizedSigningMode}`,
    ...(signedArtifactPath ? [`- Signed artifact staging path: ${path.basename(signedArtifactPath)}`] : []),
    `- Build mode: ${buildMetadata.buildMode}`
  ]);

  return {
    artifactInventoryPath,
    buildMetadataPath,
    artifactPath: unsignedArtifactPath,
    unsignedArtifactPath,
    signedArtifactPath
  };
}

export async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      platform: { type: 'string' },
      workspace: { type: 'string' },
      'force-dry-run': { type: 'boolean' },
      'desktop-build-command': { type: 'string' },
      'signing-mode': { type: 'string' }
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
    desktopBuildCommand: values['desktop-build-command'],
    signingMode: values['signing-mode'] ?? 'disabled'
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
