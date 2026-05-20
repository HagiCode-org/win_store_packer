import path from 'node:path';
import { findFirstMatchingDirectory, pathExists } from './fs-utils.mjs';

export const REQUIRED_SERVER_PAYLOAD_PATHS = [
  'manifest.json',
  path.join('config'),
  path.join('lib', 'PCode.Web.dll'),
  path.join('lib', 'PCode.Web.runtimeconfig.json'),
  path.join('lib', 'PCode.Web.deps.json')
];

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
      missing.push(relativePath.replaceAll(path.sep, '/'));
    }
  }

  if (missing.length > 0) {
    throw new Error(`Server payload for ${platformId} is incomplete under ${runtimeRoot}. Missing: ${missing.join(', ')}`);
  }

  return {
    runtimeRoot,
    requiredPaths: REQUIRED_SERVER_PAYLOAD_PATHS.map((entry) => entry.replaceAll(path.sep, '/'))
  };
}
