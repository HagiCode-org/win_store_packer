import path from 'node:path';
import { rm } from 'node:fs/promises';
import { copyDir, findFirstMatchingDirectory, pathExists, readJson, writeJson } from './fs-utils.mjs';
import { getPlatformConfig } from './platforms.mjs';

export const REQUIRED_SERVER_PAYLOAD_PATHS = [
  'manifest.json',
  path.join('config'),
  path.join('lib', 'PCode.Web.dll'),
  path.join('lib', 'PCode.Web.runtimeconfig.json'),
  path.join('lib', 'PCode.Web.deps.json')
];

function normalizePathForReport(value) {
  return String(value).replaceAll(path.sep, '/');
}

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return normalized;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function normalizeManifestEntryPath(entry) {
  return String(entry?.path ?? entry?.relativePath ?? entry?.filePath ?? '').trim().replaceAll('\\', '/');
}

export async function resolveRuntimeRoot(extractedRoot) {
  const directManifest = path.join(extractedRoot, 'manifest.json');
  const directDll = path.join(extractedRoot, 'lib', 'PCode.Web.dll');
  if ((await pathExists(directManifest)) || (await pathExists(directDll))) {
    return extractedRoot;
  }

  return findFirstMatchingDirectory(extractedRoot, async (candidate) => {
    const manifestPath = path.join(candidate, 'manifest.json');
    const dllPath = path.join(candidate, 'lib', 'PCode.Web.dll');
    return (await pathExists(manifestPath)) || (await pathExists(dllPath));
  });
}

export async function validateServerPayloadRoot(runtimeRoot, platformId) {
  const missing = [];
  for (const relativePath of REQUIRED_SERVER_PAYLOAD_PATHS) {
    if (!(await pathExists(path.join(runtimeRoot, relativePath)))) {
      missing.push(normalizePathForReport(relativePath));
    }
  }

  if (missing.length > 0) {
    throw new Error(`Server payload for ${platformId} is incomplete under ${runtimeRoot}. Missing: ${missing.join(', ')}`);
  }

  return {
    runtimeRoot,
    requiredPaths: REQUIRED_SERVER_PAYLOAD_PATHS.map((entry) => normalizePathForReport(entry))
  };
}

export async function resolveStructuredDlcPayloadRoot(
  extractedRoot,
  {
    directoryId,
    manifestFileName = 'dlc.json',
    filesManifestFileName = 'manifest.files.json'
  } = {}
) {
  const normalizedDirectoryId = requireNonEmptyString(directoryId, 'directoryId');
  const candidates = [
    path.join(extractedRoot, 'resources', 'extra', 'portable-fixed', 'current', 'lib', 'dlcs', normalizedDirectoryId),
    path.join(extractedRoot, 'lib', 'dlcs', normalizedDirectoryId),
    path.join(extractedRoot, normalizedDirectoryId),
    extractedRoot,
  ];

  for (const candidate of candidates) {
    if (
      (await pathExists(path.join(candidate, manifestFileName))) ||
      (await pathExists(path.join(candidate, filesManifestFileName)))
    ) {
      return candidate;
    }
  }

  return findFirstMatchingDirectory(extractedRoot, async (candidate) => {
    const manifestPath = path.join(candidate, manifestFileName);
    const filesManifestPath = path.join(candidate, filesManifestFileName);
    return (await pathExists(manifestPath)) || (await pathExists(filesManifestPath));
  });
}

export async function validateStructuredDlcPayloadRoot(
  dlcRoot,
  {
    platformId,
    directoryId,
    dlcId,
    packageFileName,
    manifestFileName = 'dlc.json',
    filesManifestFileName = 'manifest.files.json'
  }
) {
  const normalizedDirectoryId = requireNonEmptyString(directoryId, 'directoryId');
  const normalizedDlcId = requireNonEmptyString(dlcId, 'dlcId');
  const runtimeKey = getPlatformConfig(platformId).runtimeKey;
  const manifestPath = path.join(dlcRoot, manifestFileName);
  const filesManifestPath = path.join(dlcRoot, filesManifestFileName);

  if (!(await pathExists(manifestPath))) {
    throw new Error(`Turbo Engine DLC package is missing ${manifestFileName} under ${dlcRoot}.`);
  }
  if (!(await pathExists(filesManifestPath))) {
    throw new Error(`Turbo Engine DLC package is missing ${filesManifestFileName} under ${dlcRoot}.`);
  }

  const manifest = requireObject(await readJson(manifestPath), 'dlc manifest');
  const filesManifest = requireObject(await readJson(filesManifestPath), 'dlc files manifest');
  const manifestDlcId = requireNonEmptyString(manifest.dlcId, `${manifestFileName}.dlcId`);
  if (manifestDlcId !== normalizedDlcId) {
    throw new Error(`Turbo Engine DLC package expected dlcId ${JSON.stringify(normalizedDlcId)} but found ${JSON.stringify(manifestDlcId)}.`);
  }

  const version = requireNonEmptyString(manifest.version, `${manifestFileName}.version`);
  const entryAssembly = requireNonEmptyString(manifest.entryAssembly, `${manifestFileName}.entryAssembly`);
  const supportedRuntimes = Array.isArray(manifest.supportedRuntimes)
    ? manifest.supportedRuntimes.map((entry, index) => requireNonEmptyString(entry, `${manifestFileName}.supportedRuntimes[${index}]`))
    : [];

  if (!supportedRuntimes.includes(runtimeKey)) {
    throw new Error(`Turbo Engine DLC package ${packageFileName ?? normalizedDirectoryId} does not support runtime ${runtimeKey}.`);
  }

  const entryAssemblyPath = path.join(dlcRoot, entryAssembly);
  if (!(await pathExists(entryAssemblyPath))) {
    throw new Error(`Turbo Engine DLC package is missing entry assembly ${entryAssembly} under ${dlcRoot}.`);
  }

  const fileEntries = Array.isArray(filesManifest.files) ? filesManifest.files : [];
  if (fileEntries.length === 0) {
    throw new Error(`Turbo Engine DLC package ${filesManifestFileName} must contain a non-empty files array.`);
  }

  const normalizedEntryAssembly = normalizePathForReport(entryAssembly);
  const includesEntryAssembly = fileEntries.some((entry) => normalizeManifestEntryPath(entry) === normalizedEntryAssembly);
  if (!includesEntryAssembly) {
    throw new Error(`Turbo Engine DLC package ${filesManifestFileName} does not include entry assembly ${entryAssembly}.`);
  }

  return {
    directoryId: normalizedDirectoryId,
    dlcId: manifestDlcId,
    displayName: typeof manifest.displayName === 'string' && manifest.displayName.trim() ? manifest.displayName.trim() : null,
    version,
    entryAssembly,
    targetFramework: typeof manifest.targetFramework === 'string' && manifest.targetFramework.trim() ? manifest.targetFramework.trim() : null,
    grantType: typeof manifest.grantType === 'string' && manifest.grantType.trim() ? manifest.grantType.trim() : null,
    enabledByDefault: manifest.enabledByDefault !== false,
    hostCompatibility: manifest.hostCompatibility && typeof manifest.hostCompatibility === 'object'
      ? manifest.hostCompatibility
      : null,
    packageFileName: packageFileName ? String(packageFileName) : null,
    supportedRuntime: runtimeKey,
    supportedRuntimes,
    validatedPayloadRoot: dlcRoot,
    manifestPath: `${normalizedDirectoryId}/${manifestFileName}`,
    filesManifestPath: `${normalizedDirectoryId}/${filesManifestFileName}`,
    filesManifestEntryCount: fileEntries.length,
  };
}

export function resolveStagedDlcRuntimePaths(runtimeRoot, dlcConfig) {
  const runtimeTargetPath = requireNonEmptyString(dlcConfig.runtimeTargetPath, 'dlcConfig.runtimeTargetPath');
  const runtimeIndexPath = requireNonEmptyString(dlcConfig.runtimeIndexPath, 'dlcConfig.runtimeIndexPath');
  const manifestFileName = requireNonEmptyString(dlcConfig.manifestFileName, 'dlcConfig.manifestFileName');
  const filesManifestFileName = requireNonEmptyString(dlcConfig.filesManifestFileName, 'dlcConfig.filesManifestFileName');
  const stagedRuntimeRoot = path.join(runtimeRoot, runtimeTargetPath);
  return {
    runtimeTargetPath: normalizePathForReport(runtimeTargetPath),
    runtimeIndexPath: normalizePathForReport(runtimeIndexPath),
    stagedRuntimeRoot,
    stagedRuntimeIndexPath: path.join(runtimeRoot, runtimeIndexPath),
    stagedManifestPath: path.join(stagedRuntimeRoot, manifestFileName),
    stagedFilesManifestPath: path.join(stagedRuntimeRoot, filesManifestFileName),
    manifestPath: `${normalizePathForReport(dlcConfig.directoryId)}/${manifestFileName}`,
    filesManifestPath: `${normalizePathForReport(dlcConfig.directoryId)}/${filesManifestFileName}`,
  };
}

function buildDlcRuntimeIndexEntry(validation) {
  return {
    directoryId: validation.directoryId,
    dlcId: validation.dlcId,
    displayName: validation.displayName,
    version: validation.version,
    entryAssembly: validation.entryAssembly,
    packageFileName: validation.packageFileName,
    supportedRuntime: validation.supportedRuntime,
    supportedRuntimes: validation.supportedRuntimes,
    targetFramework: validation.targetFramework,
    grantType: validation.grantType,
    enabledByDefault: validation.enabledByDefault,
    manifestPath: validation.manifestPath,
    filesManifestPath: validation.filesManifestPath,
    hostCompatibility: validation.hostCompatibility,
  };
}

export async function stageStructuredDlcPayload({
  runtimeRoot,
  dlcRoot,
  dlcConfig,
  validation,
  generatedAt = new Date().toISOString(),
}) {
  const runtimeKey = requireNonEmptyString(validation.supportedRuntime, 'validation.supportedRuntime');
  const stagingPaths = resolveStagedDlcRuntimePaths(runtimeRoot, dlcConfig);

  await rm(stagingPaths.stagedRuntimeRoot, { recursive: true, force: true });
  await copyDir(dlcRoot, stagingPaths.stagedRuntimeRoot);

  await writeJson(stagingPaths.stagedRuntimeIndexPath, {
    runtimeKey,
    generatedAt,
    dlcs: [buildDlcRuntimeIndexEntry(validation)]
  });

  return {
    ...validation,
    runtimeTargetPath: stagingPaths.runtimeTargetPath,
    runtimeIndexPath: stagingPaths.runtimeIndexPath,
    stagedRuntimeRoot: stagingPaths.stagedRuntimeRoot,
    stagedRuntimeIndexPath: stagingPaths.stagedRuntimeIndexPath,
    stagedManifestPath: stagingPaths.stagedManifestPath,
    stagedFilesManifestPath: stagingPaths.stagedFilesManifestPath,
  };
}
