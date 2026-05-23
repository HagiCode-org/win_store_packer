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

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function requireInteger(value, label, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array.`);
  }
  return value;
}

function optionalNonEmptyString(value, label) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return requireNonEmptyString(value, label);
}

function optionalStringArray(value, label) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const values = requireArray(value, label).map((entry, index) => requireNonEmptyString(entry, `${label}[${index}]`));
  return values;
}

function stripOptionalWrappingQuotes(value) {
  const normalized = requireNonEmptyString(value, 'publisherSubject');
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith('\'') && normalized.endsWith('\''))
  ) {
    return normalized.slice(1, -1).trim();
  }
  return normalized;
}

function isValidDistinguishedName(value) {
  return /^(?:(?:CN|L|O|OU|E|C|S|STREET|T|G|I|SN|DC|SERIALNUMBER|Description|PostalCode|POBox|Phone|X21Address|dnQualifier|OID\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))+)=((?:[^,+="<>#;])+|".*"))(?:,\s*(?:(?:CN|L|O|OU|E|C|S|STREET|T|G|I|SN|DC|SERIALNUMBER|Description|PostalCode|POBox|Phone|X21Address|dnQualifier|OID\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))+)=((?:[^,+="<>#;])+|".*")))*$/u.test(value);
}

function validatePackageVersionConfig(config) {
  const packageVersion = requireObject(config, 'storePackageConfig.packageVersion');
  const source = requireNonEmptyString(packageVersion.source, 'storePackageConfig.packageVersion.source');
  if (source !== 'desktop-tag') {
    throw new Error(`storePackageConfig.packageVersion.source must be "desktop-tag"; received ${JSON.stringify(source)}.`);
  }
  return {
    source,
    revision: requireInteger(packageVersion.revision, 'storePackageConfig.packageVersion.revision', { min: 0, max: 65535 })
  };
}

function validateSigningConfig(config) {
  const signing = requireObject(config, 'storePackageConfig.signing');
  const azure = requireObject(signing.azure, 'storePackageConfig.signing.azure');
  return {
    publisherSubjectEnvVar: requireNonEmptyString(signing.publisherSubjectEnvVar, 'storePackageConfig.signing.publisherSubjectEnvVar'),
    verificationScriptRelativePath: requireNonEmptyString(
      signing.verificationScriptRelativePath,
      'storePackageConfig.signing.verificationScriptRelativePath'
    ),
    azure: {
      clientIdEnvVar: requireNonEmptyString(azure.clientIdEnvVar, 'storePackageConfig.signing.azure.clientIdEnvVar'),
      tenantIdEnvVar: requireNonEmptyString(azure.tenantIdEnvVar, 'storePackageConfig.signing.azure.tenantIdEnvVar'),
      subscriptionIdEnvVar: requireNonEmptyString(
        azure.subscriptionIdEnvVar,
        'storePackageConfig.signing.azure.subscriptionIdEnvVar'
      ),
      endpointEnvVar: requireNonEmptyString(azure.endpointEnvVar, 'storePackageConfig.signing.azure.endpointEnvVar'),
      accountNameEnvVar: requireNonEmptyString(azure.accountNameEnvVar, 'storePackageConfig.signing.azure.accountNameEnvVar'),
      certificateProfileNameEnvVar: requireNonEmptyString(
        azure.certificateProfileNameEnvVar,
        'storePackageConfig.signing.azure.certificateProfileNameEnvVar'
      )
    }
  };
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
  requireBoolean(packageIdentity.addAutoLaunchExtension, 'storePackageConfig.packageIdentity.addAutoLaunchExtension');
  const desktop = requireObject(config.desktop, 'storePackageConfig.desktop');
  requireNonEmptyString(desktop.submodulePath, 'storePackageConfig.desktop.submodulePath');
  requireNonEmptyString(desktop.electronBuilderConfigPath, 'storePackageConfig.desktop.electronBuilderConfigPath');
  requireNonEmptyString(desktop.buildScript, 'storePackageConfig.desktop.buildScript');
  requireNonEmptyString(desktop.runtimeInjectionPath, 'storePackageConfig.desktop.runtimeInjectionPath');
  requireArray(config.supportedWindowsTargets, 'storePackageConfig.supportedWindowsTargets');
  const appx = config.appx ? requireObject(config.appx, 'storePackageConfig.appx') : undefined;
  return {
    ...config,
    packageVersion: validatePackageVersionConfig(config.packageVersion),
    signing: validateSigningConfig(config.signing),
    appx: appx
      ? {
          ...appx,
          minVersion: optionalNonEmptyString(appx.minVersion, 'storePackageConfig.appx.minVersion'),
          maxVersionTested: optionalNonEmptyString(appx.maxVersionTested, 'storePackageConfig.appx.maxVersionTested'),
          capabilities: optionalStringArray(appx.capabilities, 'storePackageConfig.appx.capabilities')
        }
      : undefined
  };
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

export function normalizeStorePackageVersion(desktopTag, packageVersionConfig = { source: 'desktop-tag', revision: 0 }) {
  const rawTag = requireNonEmptyString(desktopTag, 'desktopTag').replace(/^refs\/tags\//i, '');
  const normalized = rawTag.replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error(
      `Invalid Desktop tag ${JSON.stringify(desktopTag)}. Expected a stable tag like v1.2.3 so a Store-safe numeric package version can be derived.`
    );
  }

  const versionParts = normalized.split('.').map((part) => Number(part));
  if (versionParts.some((part) => !Number.isInteger(part) || part < 0 || part > 65535)) {
    throw new Error(`Invalid Desktop tag ${JSON.stringify(desktopTag)}. Store package version components must be integers between 0 and 65535.`);
  }

  if (versionParts.length === 3) {
    versionParts.push(requireInteger(packageVersionConfig.revision, 'storePackageConfig.packageVersion.revision', { min: 0, max: 65535 }));
  }

  return versionParts.join('.');
}

export function normalizeStoreSigningMode(value) {
  const normalized = String(value ?? 'disabled').trim().toLowerCase();
  if (!['disabled', 'enabled', 'required'].includes(normalized)) {
    throw new Error(`Unsupported signing mode ${JSON.stringify(value)}. Expected disabled, enabled, or required.`);
  }
  return normalized;
}

export function getStoreSigningEnvironmentVariableNames(storePackageConfig) {
  const signing = validateSigningConfig(storePackageConfig.signing);
  return [
    signing.publisherSubjectEnvVar,
    signing.azure.clientIdEnvVar,
    signing.azure.tenantIdEnvVar,
    signing.azure.subscriptionIdEnvVar,
    signing.azure.endpointEnvVar,
    signing.azure.accountNameEnvVar,
    signing.azure.certificateProfileNameEnvVar
  ];
}

export function resolveStoreSigningConfig({
  storePackageConfig,
  env = process.env,
  signingMode = 'disabled'
}) {
  const mode = normalizeStoreSigningMode(signingMode);
  const signing = validateSigningConfig(storePackageConfig.signing);
  const enabled = mode !== 'disabled';
  const required = mode === 'required';
  const rawPublisher = env[signing.publisherSubjectEnvVar]?.trim() || null;
  const normalizedPublisher = rawPublisher ? stripOptionalWrappingQuotes(rawPublisher) : null;

  const resolved = {
    mode,
    enabled,
    required,
    publisher: normalizedPublisher,
    publisherSubjectEnvVar: signing.publisherSubjectEnvVar,
    verificationScriptRelativePath: signing.verificationScriptRelativePath,
    azure: {
      clientId: env[signing.azure.clientIdEnvVar]?.trim() || null,
      tenantId: env[signing.azure.tenantIdEnvVar]?.trim() || null,
      subscriptionId: env[signing.azure.subscriptionIdEnvVar]?.trim() || null,
      endpoint: env[signing.azure.endpointEnvVar]?.trim() || null,
      accountName: env[signing.azure.accountNameEnvVar]?.trim() || null,
      certificateProfileName: env[signing.azure.certificateProfileNameEnvVar]?.trim() || null
    },
    envVarNames: {
      publisher: signing.publisherSubjectEnvVar,
      clientId: signing.azure.clientIdEnvVar,
      tenantId: signing.azure.tenantIdEnvVar,
      subscriptionId: signing.azure.subscriptionIdEnvVar,
      endpoint: signing.azure.endpointEnvVar,
      accountName: signing.azure.accountNameEnvVar,
      certificateProfileName: signing.azure.certificateProfileNameEnvVar
    },
    missing: []
  };

  if (!enabled) {
    return resolved;
  }

  for (const [key, envVarName] of Object.entries(resolved.envVarNames)) {
    const value = key === 'publisher' ? resolved.publisher : resolved.azure[key];
    if (!value) {
      resolved.missing.push(envVarName);
    }
  }

  if (resolved.missing.length > 0) {
    throw new Error(`Missing Store signing configuration: ${resolved.missing.join(', ')}.`);
  }

  if (!isValidDistinguishedName(resolved.publisher)) {
    throw new Error(
      `Invalid Store signing publisher in ${resolved.publisherSubjectEnvVar}. Expected an X.500 subject like CN=Example, O=Example Corp, C=US.`
    );
  }

  return resolved;
}
