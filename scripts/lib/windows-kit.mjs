import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { pathExists } from './fs-utils.mjs';

const WINDOWS_SDK_VERSION_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;

export function isWindowsKitVersion(value) {
  return WINDOWS_SDK_VERSION_PATTERN.test(String(value ?? '').trim());
}

function parseWindowsKitVersion(value) {
  if (!isWindowsKitVersion(value)) {
    throw new Error(`Invalid Windows SDK version ${JSON.stringify(value)}.`);
  }

  return String(value).trim().split('.').map((segment) => Number(segment));
}

export function compareWindowsKitVersions(left, right) {
  const leftParts = parseWindowsKitVersion(left);
  const rightParts = parseWindowsKitVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

export function getDefaultWindowsKitsBinRoot(env = process.env) {
  const programFilesX86 = String(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)').trim();
  return path.join(programFilesX86, 'Windows Kits', '10', 'bin');
}

export async function listInstalledWindowsKitVersions(windowsKitsBinRoot = getDefaultWindowsKitsBinRoot()) {
  if (!(await pathExists(windowsKitsBinRoot))) {
    return [];
  }

  const entries = await readdir(windowsKitsBinRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && isWindowsKitVersion(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => compareWindowsKitVersions(right, left));
}

export function resolvePreferredWindowsKitVersion({ availableVersions, preferredVersions = [] }) {
  const normalizedAvailableVersions = Array.isArray(availableVersions)
    ? availableVersions.filter(isWindowsKitVersion)
    : [];
  const normalizedPreferredVersions = Array.isArray(preferredVersions)
    ? preferredVersions.filter(isWindowsKitVersion)
    : [];

  for (const preferredVersion of normalizedPreferredVersions) {
    if (normalizedAvailableVersions.includes(preferredVersion)) {
      return preferredVersion;
    }
  }

  if (normalizedAvailableVersions.length === 0) {
    return null;
  }

  return [...normalizedAvailableVersions].sort((left, right) => compareWindowsKitVersions(right, left))[0];
}

export async function resolveWindowsKitOverride({
  env = process.env,
  platform = process.platform,
  windowsKitsBinRoot = getDefaultWindowsKitsBinRoot(env),
  preferredVersions = [],
} = {}) {
  if (platform !== 'win32') {
    return null;
  }

  if (String(env.WINDOWS_KIT_PATH || '').trim() || String(env.WINDOWS_KIT_VERSION || '').trim()) {
    return null;
  }

  const availableVersions = await listInstalledWindowsKitVersions(windowsKitsBinRoot);
  const version = resolvePreferredWindowsKitVersion({ availableVersions, preferredVersions });
  if (!version) {
    return null;
  }

  return {
    version,
    windowsKitPath: path.join(windowsKitsBinRoot, version),
    availableVersions,
  };
}
