#!/usr/bin/env node
import path from 'node:path';
import { rename, rm } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createArtifactRecord } from './lib/artifacts.mjs';
import { runCommand } from './lib/command.mjs';
import { ensureDir, pathExists, readJson, writeJson } from './lib/fs-utils.mjs';
import { buildStoreArtifactName } from './lib/platforms.mjs';
import { loadReleasePlan } from './lib/release-plan.mjs';
import { buildDesktopStoreSteps, resolveDesktopStoreBuildStrategy } from './lib/desktop-build.mjs';
import {
  loadDesktopStoreConfig,
  loadStorePackageConfig,
  normalizeStoreSigningMode,
  normalizeStorePackageVersion,
  resolveDesktopOverlayFileName,
  resolveStoreSigningConfig,
} from './lib/store-config.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';
import { resolveWindowsKitOverride } from './lib/windows-kit.mjs';

const STORE_PACKAGE_EXTENSIONS = new Set(['.msix']);

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array.`);
  }
  return value;
}

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return normalized;
}

function normalizeArtifactVariant(value) {
  const normalized = String(value ?? 'unsigned').trim().toLowerCase();
  if (!['unsigned', 'signed'].includes(normalized)) {
    throw new Error(`Unsupported artifact variant ${JSON.stringify(value)}. Expected unsigned or signed.`);
  }
  return normalized;
}

const UNSIGNED_MSIX_IDENTITY_OVERRIDE_ENV_VARS = [
  'WINDOWS_PACKAGE_PUBLISHER',
  'WINDOWS_PACKAGE_IDENTITY',
  'WINDOWS_PACKAGE_DISPLAY_NAME',
  'WINDOWS_PACKAGE_PUBLISHER_DISPLAY_NAME',
  'WINDOWS_PACKAGE_DESCRIPTION',
  'WINDOWS_PACKAGE_BACKGROUND_COLOR',
  'WINDOWS_PACKAGE_MIN_VERSION',
  'WINDOWS_PACKAGE_MAX_TESTED_VERSION',
];

const DESKTOP_DISTRIBUTION_METADATA_RELATIVE_PATH = path.join('resources', 'distribution-metadata.json');

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function appendSuffixBeforeExtension(fileName, suffix) {
  const extension = path.extname(fileName);
  if (!extension) {
    return `${fileName}${suffix}`;
  }

  return `${fileName.slice(0, -extension.length)}${suffix}${extension}`;
}

async function normalizePublishedArtifacts({ artifacts, outputDirectory, releaseTag, platformId, artifactVariant, primaryArtifactPath }) {
  const usedFileNames = new Set();
  const resolvedPrimaryArtifactPath = path.resolve(primaryArtifactPath);
  let normalizedPrimaryArtifactPath = primaryArtifactPath;
  const normalizedArtifacts = [];

  for (const [index, artifact] of artifacts.entries()) {
    const baseFileName = buildStoreArtifactName(releaseTag, platformId, artifactVariant, artifact.extension);
    let desiredFileName = index === 0 ? baseFileName : appendSuffixBeforeExtension(baseFileName, `-${index + 1}`);
    let duplicateIndex = index + 1;
    while (usedFileNames.has(desiredFileName)) {
      duplicateIndex += 1;
      desiredFileName = appendSuffixBeforeExtension(baseFileName, `-${duplicateIndex}`);
    }

    usedFileNames.add(desiredFileName);

    const currentArtifactPath = path.resolve(artifact.path);
    const desiredArtifactPath = path.join(outputDirectory, desiredFileName);
    if (currentArtifactPath !== path.resolve(desiredArtifactPath)) {
      await rm(desiredArtifactPath, { force: true });
      await rename(currentArtifactPath, desiredArtifactPath);
    }

    if (currentArtifactPath === resolvedPrimaryArtifactPath) {
      normalizedPrimaryArtifactPath = desiredArtifactPath;
    }

    normalizedArtifacts.push({
      ...artifact,
      path: desiredArtifactPath,
      fileName: desiredFileName,
    });
  }

  return {
    artifacts: normalizedArtifacts,
    primaryArtifactPath: normalizedPrimaryArtifactPath,
  };
}

function toDesktopPackageJsonVersion(desktopTag, packageVersionConfig) {
  return normalizeStorePackageVersion(desktopTag, { ...packageVersionConfig, source: 'packer-tag' }).split('.').slice(0, 3).join('.');
}

async function synchronizeDesktopWorkspaceVersion({ desktopWorkspace, desktopTag, packageVersionConfig }) {
  const expectedVersion = toDesktopPackageJsonVersion(desktopTag, packageVersionConfig);
  const packageJsonPath = path.join(desktopWorkspace, 'package.json');
  const packageJson = await readJson(packageJsonPath);
  let changed = false;

  if (String(packageJson.version ?? '').trim() !== expectedVersion) {
    packageJson.version = expectedVersion;
    await writeJson(packageJsonPath, packageJson);
    changed = true;
  }

  const packageLockPath = path.join(desktopWorkspace, 'package-lock.json');
  if (await pathExists(packageLockPath)) {
    const packageLock = await readJson(packageLockPath);
    let lockChanged = false;

    if (String(packageLock.version ?? '').trim() !== expectedVersion) {
      packageLock.version = expectedVersion;
      lockChanged = true;
    }

    if (packageLock.packages?.[''] && String(packageLock.packages[''].version ?? '').trim() !== expectedVersion) {
      packageLock.packages[''].version = expectedVersion;
      lockChanged = true;
    }

    if (lockChanged) {
      await writeJson(packageLockPath, packageLock);
      changed = true;
    }
  }

  return {
    expectedVersion,
    changed,
  };
}

async function synchronizeDesktopWorkspaceWindowsStoreVersion({ desktopWorkspace, windowsStoreVersion }) {
  const packageJsonPath = path.join(desktopWorkspace, 'package.json');
  const packageJson = await readJson(packageJsonPath);
  const hagicodeDesktopMetadata = packageJson.hagicodeDesktop && typeof packageJson.hagicodeDesktop === 'object'
    ? packageJson.hagicodeDesktop
    : {};
  let changed = false;

  if (String(hagicodeDesktopMetadata.windowsStoreVersion ?? '').trim() !== windowsStoreVersion) {
    packageJson.hagicodeDesktop = {
      ...hagicodeDesktopMetadata,
      windowsStoreVersion,
    };
    await writeJson(packageJsonPath, packageJson);
    changed = true;
  }

  return {
    windowsStoreVersion,
    changed,
  };
}

async function synchronizeDesktopWorkspaceDistributionMetadata({ desktopWorkspace, windowsStoreVersion }) {
  const distributionMetadataPath = path.join(desktopWorkspace, DESKTOP_DISTRIBUTION_METADATA_RELATIVE_PATH);
  const existingMetadata = await pathExists(distributionMetadataPath)
    ? await readJson(distributionMetadataPath)
    : null;
  const existingExtensions = isRecord(existingMetadata) && isRecord(existingMetadata.extensions)
    ? existingMetadata.extensions
    : {};
  const nextMetadata = {
    schemaVersion: isRecord(existingMetadata) && Number.isInteger(existingMetadata.schemaVersion)
      ? existingMetadata.schemaVersion
      : 1,
    mode: 'fusion',
    channel: 'win-store',
    extensions: {
      ...existingExtensions,
      windowsStoreVersion,
    },
  };
  const changed = JSON.stringify(existingMetadata) !== JSON.stringify(nextMetadata);

  if (changed) {
    await writeJson(distributionMetadataPath, nextMetadata);
  }

  return {
    distributionMetadataPath,
    metadata: nextMetadata,
    changed,
  };
}

async function executeDesktopBuildSteps(steps, cwd, env = process.env) {
  for (const [index, step] of steps.entries()) {
    const stepLabel = `step ${index + 1}/${steps.length}: ${step.name}`;
    console.log(`[build-msix] ${stepLabel}`);

    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      console.log(`[build-msix] still running ${stepLabel} (${elapsedSeconds}s elapsed)`);
    }, 30_000);

    heartbeat.unref?.();

    try {
      await runCommand(step.command, step.args, { cwd, env });
    } finally {
      clearInterval(heartbeat);
    }

    const completedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    console.log(`[build-msix] completed ${stepLabel} (${completedSeconds}s)`);
  }
}

function resolveDesktopMetadataPath(value, desktopWorkspace) {
  const normalized = requireNonEmptyString(value, 'desktopBuildMetadata path');
  return path.isAbsolute(normalized) ? normalized : path.resolve(desktopWorkspace, normalized);
}

function validateDesktopBuildMetadata(metadata, { desktopWorkspace }) {
  const normalized = requireObject(metadata, 'desktopBuildMetadata');
  const artifacts = requireArray(normalized.artifacts, 'desktopBuildMetadata.artifacts').map((artifact, index) => {
    const entry = requireObject(artifact, `desktopBuildMetadata.artifacts[${index}]`);
    const artifactPath = resolveDesktopMetadataPath(entry.path, desktopWorkspace);
    const extension = path.extname(artifactPath).toLowerCase();
    if (!STORE_PACKAGE_EXTENSIONS.has(extension)) {
      throw new Error(`desktopBuildMetadata.artifacts[${index}] must reference an .msix file. Received ${artifactPath}.`);
    }

    return {
      ...entry,
      path: artifactPath,
      fileName: requireNonEmptyString(entry.fileName, `desktopBuildMetadata.artifacts[${index}].fileName`),
      type: requireNonEmptyString(entry.type, `desktopBuildMetadata.artifacts[${index}].type`),
      extension,
    };
  });

  const primaryArtifactPath = normalized.primaryArtifactPath
    ? resolveDesktopMetadataPath(normalized.primaryArtifactPath, desktopWorkspace)
    : artifacts[0].path;
  const primaryArtifact = artifacts.find((artifact) => artifact.path === primaryArtifactPath) ?? artifacts[0];

  return {
    ...normalized,
    buildMode: requireNonEmptyString(normalized.buildMode, 'desktopBuildMetadata.buildMode'),
    desktopVersion: requireNonEmptyString(normalized.desktopVersion, 'desktopBuildMetadata.desktopVersion'),
    windowsStoreVersion: normalized.windowsStoreVersion
      ? requireNonEmptyString(normalized.windowsStoreVersion, 'desktopBuildMetadata.windowsStoreVersion')
      : null,
    desktopSourceRef: requireNonEmptyString(normalized.desktopSourceRef, 'desktopBuildMetadata.desktopSourceRef'),
    storePackageVersion: requireNonEmptyString(normalized.storePackageVersion, 'desktopBuildMetadata.storePackageVersion'),
    storeConfigPath: requireNonEmptyString(normalized.storeConfigPath, 'desktopBuildMetadata.storeConfigPath'),
    overlayConfigPath: requireNonEmptyString(normalized.overlayConfigPath, 'desktopBuildMetadata.overlayConfigPath'),
    effectiveRuntimeInjectionPath: requireNonEmptyString(
      normalized.effectiveRuntimeInjectionPath,
      'desktopBuildMetadata.effectiveRuntimeInjectionPath'
    ),
    serverPayloadPath: normalized.serverPayloadPath ? String(normalized.serverPayloadPath) : null,
    serverPayloadRoot: normalized.serverPayloadRoot ? String(normalized.serverPayloadRoot) : null,
    primaryArtifactPath,
    primaryArtifact,
    artifacts,
    store: requireObject(normalized.store, 'desktopBuildMetadata.store'),
  };
}

function deriveInitialSigningState({ desktopBuildMetadata, signingConfig, dryRun, artifactVariant }) {
  if (!signingConfig.enabled) {
    return {
      contentSigned: false,
      finalArtifactSigned: false,
      status: 'disabled',
    };
  }

  if (dryRun) {
    return {
      contentSigned: false,
      finalArtifactSigned: false,
      status: 'synthetic',
    };
  }

  if (signingConfig.external) {
    return {
      contentSigned: false,
      finalArtifactSigned: false,
      status: 'pending-external-finalization',
    };
  }

  if (signingConfig.skipFinalAppxSigning) {
    return {
      contentSigned: true,
      finalArtifactSigned: false,
      status: 'pending-finalization',
    };
  }

  const desktopProducedSignedArtifact = artifactVariant === 'signed' && desktopBuildMetadata.buildMode !== 'desktop-store-build-dry-run';
  return {
    contentSigned: desktopProducedSignedArtifact,
    finalArtifactSigned: desktopProducedSignedArtifact,
    status: desktopProducedSignedArtifact ? 'pending-verification' : 'pending-finalization',
  };
}

export async function buildMsix({
  planPath,
  workspacePath,
  platformId,
  forceDryRun = false,
  signingMode = 'disabled',
  artifactVariant = 'unsigned'
}) {
  const { plan } = await loadReleasePlan(planPath);
  const storePackageConfig = await loadStorePackageConfig();
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const workspaceManifest = await readJson(path.join(resolvedWorkspacePath, 'workspace-manifest.json'));
  const { config: desktopStoreConfig } = await loadDesktopStoreConfig(
    workspaceManifest.desktopWorkspace,
    workspaceManifest.desktopStoreConfigRelativePath ?? storePackageConfig.desktop.storeConfigPath
  );
  const payloadValidationPath = path.join(resolvedWorkspacePath, `payload-validation-${platformId}.json`);
  const payloadValidation = await readJson(payloadValidationPath);
  const normalizedArtifactVariant = normalizeArtifactVariant(artifactVariant);
  const normalizedSigningMode = normalizedArtifactVariant === 'signed'
    ? normalizeStoreSigningMode(signingMode === 'disabled' ? 'required' : signingMode)
    : 'disabled';
  const signingConfig = resolveStoreSigningConfig({
    storePackageConfig,
    signingMode: normalizedSigningMode,
  });
  const verificationScriptPath = path.resolve(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', storePackageConfig.signing.verificationScriptRelativePath)
  );
  const shouldDryRun = forceDryRun || plan.build.dryRun;

  if (!storePackageConfig.supportedWindowsTargets.includes(platformId)) {
    throw new Error(`Unsupported Windows target ${platformId}. Supported targets: ${storePackageConfig.supportedWindowsTargets.join(', ')}`);
  }

  if (!payloadValidation.validationPassed) {
    throw new Error(`Payload validation report ${payloadValidationPath} is not marked as successful.`);
  }

  if (signingConfig.enabled && !(await pathExists(verificationScriptPath))) {
    throw new Error(`Missing Store signature verification script at ${verificationScriptPath}.`);
  }

  const desktopBuildStrategy = await resolveDesktopStoreBuildStrategy({
    desktopWorkspace: workspaceManifest.desktopWorkspace,
    buildCommand: workspaceManifest.desktopBuildCommand ?? storePackageConfig.desktop.buildCommand,
  });
  if (!desktopBuildStrategy.canBuild) {
    throw new Error('Desktop workspace is missing the direct Store build contract required by win_store_packer.');
  }

  const desktopVersionSync = await synchronizeDesktopWorkspaceVersion({
    desktopWorkspace: workspaceManifest.desktopWorkspace,
    desktopTag: workspaceManifest.desktopTag,
    packageVersionConfig: storePackageConfig.packageVersion,
  });
  if (desktopVersionSync.changed) {
    console.log(
      `[build-msix] synchronized desktop workspace version to ${desktopVersionSync.expectedVersion} from tag ${workspaceManifest.desktopTag}`
    );
  }

  const desktopWindowsStoreSync = await synchronizeDesktopWorkspaceWindowsStoreVersion({
    desktopWorkspace: workspaceManifest.desktopWorkspace,
    windowsStoreVersion: workspaceManifest.windowsStoreVersion,
  });
  if (desktopWindowsStoreSync.changed) {
    console.log(
      `[build-msix] injected Windows Store version ${desktopWindowsStoreSync.windowsStoreVersion} into the desktop workspace metadata`
    );
  }

  const desktopDistributionMetadataSync = await synchronizeDesktopWorkspaceDistributionMetadata({
    desktopWorkspace: workspaceManifest.desktopWorkspace,
    windowsStoreVersion: workspaceManifest.windowsStoreVersion,
  });
  if (desktopDistributionMetadataSync.changed) {
    console.log(
      `[build-msix] synchronized desktop distribution metadata for win-store at ${desktopDistributionMetadataSync.distributionMetadataPath}`
    );
  }

  const packageLockPath = path.join(workspaceManifest.desktopWorkspace, 'package-lock.json');
  const skipDesktopWorkspaceInstall = process.env.WIN_STORE_PACKER_SKIP_DESKTOP_NPM_CI === '1';
  if (!skipDesktopWorkspaceInstall && await pathExists(packageLockPath)) {
    await runCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci'], { cwd: workspaceManifest.desktopWorkspace });
  }

  await ensureDir(workspaceManifest.outputDirectory);
  await ensureDir(workspaceManifest.reportsDirectory);

  const desktopBuildMetadataPath = path.join(
    workspaceManifest.reportsDirectory,
    `desktop-store-build-${platformId}-${normalizedArtifactVariant}.json`
  );
  const overlayOutputPath = path.join(
    workspaceManifest.desktopWorkspace,
    resolveDesktopOverlayFileName(desktopStoreConfig, normalizedArtifactVariant)
  );
  const desktopForwardArgs = [
    '--store-config-path',
    workspaceManifest.desktopStoreConfigPath,
    '--server-payload-path',
    payloadValidation.payloadRootForDesktopBuild ?? payloadValidation.validatedPayloadRoot,
    '--runtime-injection-path',
    workspaceManifest.runtimeInjectionRoot,
    '--artifact-output-dir',
    workspaceManifest.outputDirectory,
    '--metadata-output-path',
    desktopBuildMetadataPath,
    '--overlay-output-path',
    overlayOutputPath,
    '--platform-id',
    platformId,
  ];

  if (shouldDryRun) {
    desktopForwardArgs.push('--dry-run');
  }

  const desktopBuildSteps = buildDesktopStoreSteps(desktopBuildStrategy, {
    platform: process.platform,
    forwardArgs: desktopForwardArgs,
  });

  const desktopBuildEnv = { ...process.env };
  desktopBuildEnv.HAGICODE_WINDOWS_STORE_VERSION = workspaceManifest.windowsStoreVersion;
  if (normalizedArtifactVariant === 'unsigned') {
    // Unsigned submission packages must keep the desktop-owned Store identity,
    // even when the parent workflow environment carries signing overrides.
    for (const envVarName of UNSIGNED_MSIX_IDENTITY_OVERRIDE_ENV_VARS) {
      delete desktopBuildEnv[envVarName];
    }
  }

  if (signingConfig.enabled && signingConfig.publisher && !desktopBuildEnv.WINDOWS_PACKAGE_PUBLISHER) {
    // Keep the desktop-owned MSIX manifest publisher aligned with the signing certificate subject.
    desktopBuildEnv.WINDOWS_PACKAGE_PUBLISHER = signingConfig.publisher;
  }

  const windowsKitOverride = await resolveWindowsKitOverride({
    env: desktopBuildEnv,
    preferredVersions: [
      desktopStoreConfig.msix.maxVersionTested,
      desktopStoreConfig.msix.minVersion,
    ],
  });
  if (windowsKitOverride) {
    desktopBuildEnv.WINDOWS_KIT_VERSION = windowsKitOverride.version;
    console.log(
      `[build-msix] selected Windows SDK ${windowsKitOverride.version}`
    );
  }

  await executeDesktopBuildSteps(desktopBuildSteps, workspaceManifest.desktopWorkspace, desktopBuildEnv);

  const desktopBuildMetadata = validateDesktopBuildMetadata(
    await readJson(desktopBuildMetadataPath),
    { desktopWorkspace: workspaceManifest.desktopWorkspace }
  );

  if (desktopBuildMetadata.windowsStoreVersion !== workspaceManifest.windowsStoreVersion) {
    throw new Error(
      `Desktop build metadata Windows Store version ${JSON.stringify(desktopBuildMetadata.windowsStoreVersion)} does not match the canonical workspace Windows Store version ${JSON.stringify(workspaceManifest.windowsStoreVersion)}.`
    );
  }

  if (!(await pathExists(desktopBuildMetadata.primaryArtifactPath))) {
    throw new Error(`Desktop build did not produce the expected Store package artifact: ${desktopBuildMetadata.primaryArtifactPath}`);
  }

  const normalizedPublishedArtifacts = await normalizePublishedArtifacts({
    artifacts: desktopBuildMetadata.artifacts,
    outputDirectory: workspaceManifest.outputDirectory,
    releaseTag: workspaceManifest.releaseTag,
    platformId,
    artifactVariant: normalizedArtifactVariant,
    primaryArtifactPath: desktopBuildMetadata.primaryArtifactPath,
  });
  const publishedDesktopBuildMetadata = {
    ...desktopBuildMetadata,
    artifacts: normalizedPublishedArtifacts.artifacts,
    primaryArtifactPath: normalizedPublishedArtifacts.primaryArtifactPath,
    primaryArtifact: normalizedPublishedArtifacts.artifacts.find(
      (artifact) => artifact.path === normalizedPublishedArtifacts.primaryArtifactPath
    ) ?? normalizedPublishedArtifacts.artifacts[0],
  };

  const signingState = deriveInitialSigningState({
    desktopBuildMetadata: publishedDesktopBuildMetadata,
    signingConfig,
    dryRun: shouldDryRun,
    artifactVariant: normalizedArtifactVariant,
  });
  const artifactRecords = await Promise.all(
    publishedDesktopBuildMetadata.artifacts.map(async (artifact) => {
      if (!(await pathExists(artifact.path))) {
        throw new Error(`Desktop build metadata referenced a missing artifact: ${artifact.path}`);
      }

      return createArtifactRecord({
        artifactPath: artifact.path,
        platformId,
        metadata: {
          desktopProduced: true,
          desktopBuildMetadataPath,
          desktopBuildMode: publishedDesktopBuildMetadata.buildMode,
          desktopVersion: workspaceManifest.desktopVersion,
          desktopTag: workspaceManifest.desktopTag,
          canonicalVersionInput: workspaceManifest.canonicalVersionInput,
          windowsStoreVersion: workspaceManifest.windowsStoreVersion,
          desktopRef: workspaceManifest.desktopRef,
          desktopSourceRef: publishedDesktopBuildMetadata.desktopSourceRef,
          serverVersion: workspaceManifest.serverVersion,
          storePackageVersion: publishedDesktopBuildMetadata.storePackageVersion,
          storePackageExtension: artifact.extension,
          storeConfigPath: publishedDesktopBuildMetadata.storeConfigPath,
          overlayConfigPath: publishedDesktopBuildMetadata.overlayConfigPath,
          runtimeInjectionPath: publishedDesktopBuildMetadata.effectiveRuntimeInjectionPath,
          serverPayloadPath: publishedDesktopBuildMetadata.serverPayloadPath,
          serverPayloadRoot: publishedDesktopBuildMetadata.serverPayloadRoot,
          languages: Array.isArray(publishedDesktopBuildMetadata.store.languages)
            ? [...publishedDesktopBuildMetadata.store.languages]
            : [],
          identityName: publishedDesktopBuildMetadata.store.identityName ?? null,
          publisher: publishedDesktopBuildMetadata.store.publisher ?? null,
          variant: normalizedArtifactVariant,
          signed: signingState.finalArtifactSigned,
          contentSigned: signingState.contentSigned,
          finalArtifactSigned: signingState.finalArtifactSigned,
          primaryForStoreSubmission: normalizedArtifactVariant === 'unsigned' && artifact.path === publishedDesktopBuildMetadata.primaryArtifactPath,
        },
      });
    })
  );

  const primaryArtifactRecord = artifactRecords.find(
    (artifact) => artifact.outputPath === publishedDesktopBuildMetadata.primaryArtifactPath
  ) ?? artifactRecords[0];
  const buildMetadata = {
    validationPassed: true,
    platform: platformId,
    artifactVariant: normalizedArtifactVariant,
    desktopBuildMetadataPath,
    desktopBuildMode: publishedDesktopBuildMetadata.buildMode,
    desktopVersion: workspaceManifest.desktopVersion,
    desktopTag: workspaceManifest.desktopTag,
    canonicalVersionInput: workspaceManifest.canonicalVersionInput,
    windowsStoreVersion: workspaceManifest.windowsStoreVersion,
    desktopRef: workspaceManifest.desktopRef,
    serverVersion: workspaceManifest.serverVersion,
    releaseTag: workspaceManifest.releaseTag,
    storePackageVersion: publishedDesktopBuildMetadata.storePackageVersion,
    storePackageExtension: path.extname(publishedDesktopBuildMetadata.primaryArtifactPath).toLowerCase(),
    storeConfigPath: publishedDesktopBuildMetadata.storeConfigPath,
    overlayConfigPath: publishedDesktopBuildMetadata.overlayConfigPath,
    effectiveRuntimeInjectionPath: publishedDesktopBuildMetadata.effectiveRuntimeInjectionPath,
    serverPayloadPath: publishedDesktopBuildMetadata.serverPayloadPath,
    serverPayloadRoot: publishedDesktopBuildMetadata.serverPayloadRoot,
    desktopProducedArtifactPath: publishedDesktopBuildMetadata.primaryArtifactPath,
    desktopProducedArtifactPaths: artifactRecords.map((artifact) => artifact.outputPath),
    publishedArtifactPath: primaryArtifactRecord.outputPath,
    signing: {
      mode: normalizedSigningMode,
      enabled: signingConfig.enabled,
      required: signingConfig.required,
      external: signingConfig.external,
      skipFinalAppxSigning: signingConfig.skipFinalAppxSigning,
      finalArtifactSigningExpected: signingConfig.enabled && !signingConfig.skipFinalAppxSigning,
      status: signingState.status,
      publisher: signingConfig.publisher,
      publisherName: signingConfig.publisherName,
      verificationScriptPath: signingConfig.enabled ? verificationScriptPath : null,
      missingConfiguration: signingConfig.missing,
    },
  };
  const buildMetadataPath = path.join(resolvedWorkspacePath, `build-metadata-${platformId}-${normalizedArtifactVariant}.json`);
  await writeJson(buildMetadataPath, buildMetadata);

  const artifactInventory = {
    platform: platformId,
    artifactVariant: normalizedArtifactVariant,
    releaseTag: workspaceManifest.releaseTag,
    canonicalVersionInput: workspaceManifest.canonicalVersionInput,
    windowsStoreVersion: workspaceManifest.windowsStoreVersion,
    storePackageVersion: desktopBuildMetadata.storePackageVersion,
    storeConfigPath: desktopBuildMetadata.storeConfigPath,
    desktopBuildMetadataPath,
    signing: {
      mode: normalizedSigningMode,
      enabled: signingConfig.enabled,
      required: signingConfig.required,
      external: signingConfig.external,
      finalized: false,
      status: signingState.status,
    },
    artifacts: artifactRecords,
    buildMetadataPath,
    workspaceValidationPath: path.join(resolvedWorkspacePath, `workspace-validation-${platformId}.json`),
    payloadValidationPath,
  };
  const artifactInventoryPath = path.join(resolvedWorkspacePath, `artifact-inventory-${platformId}-${normalizedArtifactVariant}.json`);
  await writeJson(artifactInventoryPath, artifactInventory);

  await appendSummary([
    `### Store package build prepared for ${platformId} (${normalizedArtifactVariant})`,
    `- Release tag: ${workspaceManifest.releaseTag}`,
    `- Desktop tag: ${workspaceManifest.desktopTag}`,
    `- Windows Store version: ${workspaceManifest.windowsStoreVersion}`,
    `- Server version: ${workspaceManifest.serverVersion}`,
    `- Store config path: ${desktopBuildMetadata.storeConfigPath}`,
    `- Store package version: ${desktopBuildMetadata.storePackageVersion}`,
    `- Published artifact: ${path.basename(primaryArtifactRecord.outputPath)}`,
    `- Signing mode: ${normalizedSigningMode}`,
    `- Build mode: ${desktopBuildMetadata.buildMode}`,
  ]);

  return {
    artifactInventoryPath,
    buildMetadataPath,
    artifactPath: primaryArtifactRecord.outputPath,
    artifactVariant: normalizedArtifactVariant,
    desktopBuildMetadataPath,
  };
}

export async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      platform: { type: 'string' },
      workspace: { type: 'string' },
      'force-dry-run': { type: 'boolean' },
      'signing-mode': { type: 'string' },
      'artifact-variant': { type: 'string' }
    }
  });

  if (!values.plan || !values.platform || !values.workspace) {
    throw new Error('build-msix requires --plan, --platform, and --workspace.');
  }

  const result = await buildMsix({
    planPath: values.plan,
    workspacePath: values.workspace,
    platformId: values.platform,
    forceDryRun: values['force-dry-run'] ?? false,
    signingMode: values['signing-mode'] ?? 'disabled',
    artifactVariant: values['artifact-variant'] ?? 'unsigned'
  });

  console.log(JSON.stringify(result, null, 2));
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## MSIX package build failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
