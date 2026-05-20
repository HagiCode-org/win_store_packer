import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './fs-utils.mjs';
import { DEFAULT_PLATFORMS } from './platforms.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

export const STORE_PACKAGE_CONFIG_PATH = path.join(repoRoot, 'config', 'store-package.json');
export const WORKFLOW_DEFAULTS_PATH = path.join(repoRoot, 'config', 'workflow-defaults.json');

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
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

function requireArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array.`);
  }
  return value;
}

export function validateStorePackageConfig(config) {
  requireObject(config, 'storePackageConfig');
  const packageIdentity = requireObject(config.packageIdentity, 'storePackageConfig.packageIdentity');
  requireNonEmptyString(packageIdentity.displayName, 'storePackageConfig.packageIdentity.displayName');
  requireNonEmptyString(packageIdentity.publisherDisplayName, 'storePackageConfig.packageIdentity.publisherDisplayName');
  requireNonEmptyString(packageIdentity.publisher, 'storePackageConfig.packageIdentity.publisher');
  requireNonEmptyString(packageIdentity.identityName, 'storePackageConfig.packageIdentity.identityName');
  requireNonEmptyString(packageIdentity.backgroundColor, 'storePackageConfig.packageIdentity.backgroundColor');
  requireArray(packageIdentity.languages, 'storePackageConfig.packageIdentity.languages');
  const desktop = requireObject(config.desktop, 'storePackageConfig.desktop');
  requireNonEmptyString(desktop.submodulePath, 'storePackageConfig.desktop.submodulePath');
  requireNonEmptyString(desktop.electronBuilderConfigPath, 'storePackageConfig.desktop.electronBuilderConfigPath');
  requireNonEmptyString(desktop.buildScript, 'storePackageConfig.desktop.buildScript');
  requireNonEmptyString(desktop.runtimeInjectionPath, 'storePackageConfig.desktop.runtimeInjectionPath');
  requireArray(config.supportedWindowsTargets, 'storePackageConfig.supportedWindowsTargets');
  return config;
}

export function validateWorkflowDefaults(config) {
  requireObject(config, 'workflowDefaults');
  const defaultPlatforms = Array.isArray(config.defaultPlatforms) && config.defaultPlatforms.length > 0
    ? config.defaultPlatforms
    : DEFAULT_PLATFORMS;
  return {
    ...config,
    defaultPlatforms,
    buildPlanArtifactName: requireNonEmptyString(config.buildPlanArtifactName, 'workflowDefaults.buildPlanArtifactName'),
    packageArtifactNamePrefix: requireNonEmptyString(config.packageArtifactNamePrefix, 'workflowDefaults.packageArtifactNamePrefix'),
    releaseMetadataArtifactPrefix: requireNonEmptyString(config.releaseMetadataArtifactPrefix, 'workflowDefaults.releaseMetadataArtifactPrefix'),
    desktopSourcePath: requireNonEmptyString(config.desktopSourcePath, 'workflowDefaults.desktopSourcePath'),
    schedule: requireNonEmptyString(config.schedule, 'workflowDefaults.schedule')
  };
}

export async function loadStorePackageConfig() {
  return validateStorePackageConfig(await readJson(STORE_PACKAGE_CONFIG_PATH));
}

export async function loadWorkflowDefaults() {
  return validateWorkflowDefaults(await readJson(WORKFLOW_DEFAULTS_PATH));
}
