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

  return requireArray(value, label).map((entry, index) => requireNonEmptyString(entry, `${label}[${index}]`));
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
    revision: requireInteger(packageVersion.revision, 'storePackageConfig.packageVersion.revision', { min: 0, max: 65535 }),
  };
}

function validateSigningConfig(config) {
  const signing = requireObject(config, 'storePackageConfig.signing');
  const azure = requireObject(signing.azure, 'storePackageConfig.signing.azure');
  return {
    publisherSubjectEnvVar: optionalNonEmptyString(signing.publisherSubjectEnvVar, 'storePackageConfig.signing.publisherSubjectEnvVar'),
    publisherSubject: optionalNonEmptyString(signing.publisherSubject, 'storePackageConfig.signing.publisherSubject'),
    skipFinalAppxSigning: signing.skipFinalAppxSigning === undefined
      ? false
      : requireBoolean(signing.skipFinalAppxSigning, 'storePackageConfig.signing.skipFinalAppxSigning'),
    verificationScriptRelativePath: requireNonEmptyString(signing.verificationScriptRelativePath, 'storePackageConfig.signing.verificationScriptRelativePath'),
    azure: {
      clientIdEnvVar: requireNonEmptyString(azure.clientIdEnvVar, 'storePackageConfig.signing.azure.clientIdEnvVar'),
      tenantIdEnvVar: requireNonEmptyString(azure.tenantIdEnvVar, 'storePackageConfig.signing.azure.tenantIdEnvVar'),
      clientSecretEnvVar: requireNonEmptyString(azure.clientSecretEnvVar, 'storePackageConfig.signing.azure.clientSecretEnvVar'),
      publisherName: optionalNonEmptyString(azure.publisherName, 'storePackageConfig.signing.azure.publisherName'),
      endpoint: optionalNonEmptyString(azure.endpoint, 'storePackageConfig.signing.azure.endpoint'),
      codeSigningAccountName: optionalNonEmptyString(azure.codeSigningAccountName, 'storePackageConfig.signing.azure.codeSigningAccountName'),
      certificateProfileName: optionalNonEmptyString(azure.certificateProfileName, 'storePackageConfig.signing.azure.certificateProfileName'),
      endpointEnvVar: optionalNonEmptyString(azure.endpointEnvVar, 'storePackageConfig.signing.azure.endpointEnvVar'),
      codeSigningAccountNameEnvVar: optionalNonEmptyString(azure.codeSigningAccountNameEnvVar, 'storePackageConfig.signing.azure.codeSigningAccountNameEnvVar'),
      certificateProfileNameEnvVar: optionalNonEmptyString(azure.certificateProfileNameEnvVar, 'storePackageConfig.signing.azure.certificateProfileNameEnvVar'),
    },
  };
}

export function validateDesktopStoreConfig(config) {
  requireObject(config, 'desktopStoreConfig');
  const packageIdentity = requireObject(config.packageIdentity, 'desktopStoreConfig.packageIdentity');
  const appx = requireObject(config.appx, 'desktopStoreConfig.appx');

  return {
    ...config,
    sourceElectronBuilderConfigPath: requireNonEmptyString(config.sourceElectronBuilderConfigPath, 'desktopStoreConfig.sourceElectronBuilderConfigPath'),
    inputDirectory: requireNonEmptyString(config.inputDirectory, 'desktopStoreConfig.inputDirectory'),
    outputDirectory: requireNonEmptyString(config.outputDirectory, 'desktopStoreConfig.outputDirectory'),
    stageDirectory: requireNonEmptyString(config.stageDirectory, 'desktopStoreConfig.stageDirectory'),
    assetsDirectory: requireNonEmptyString(config.assetsDirectory, 'desktopStoreConfig.assetsDirectory'),
    metadataOutputPath: requireNonEmptyString(config.metadataOutputPath, 'desktopStoreConfig.metadataOutputPath'),
    runtimeInjectionPath: requireNonEmptyString(config.runtimeInjectionPath, 'desktopStoreConfig.runtimeInjectionPath'),
    packageIdentity: {
      displayName: requireNonEmptyString(packageIdentity.displayName, 'desktopStoreConfig.packageIdentity.displayName'),
      publisherDisplayName: requireNonEmptyString(packageIdentity.publisherDisplayName, 'desktopStoreConfig.packageIdentity.publisherDisplayName'),
      publisher: requireNonEmptyString(packageIdentity.publisher, 'desktopStoreConfig.packageIdentity.publisher'),
      identityName: requireNonEmptyString(packageIdentity.identityName, 'desktopStoreConfig.packageIdentity.identityName'),
      backgroundColor: requireNonEmptyString(packageIdentity.backgroundColor, 'desktopStoreConfig.packageIdentity.backgroundColor'),
      languages: optionalStringArray(packageIdentity.languages, 'desktopStoreConfig.packageIdentity.languages') ?? ['en-US'],
      addAutoLaunchExtension: requireBoolean(packageIdentity.addAutoLaunchExtension, 'desktopStoreConfig.packageIdentity.addAutoLaunchExtension'),
    },
    appx: {
      minVersion: optionalNonEmptyString(appx.minVersion, 'desktopStoreConfig.appx.minVersion'),
      maxVersionTested: optionalNonEmptyString(appx.maxVersionTested, 'desktopStoreConfig.appx.maxVersionTested'),
      capabilities: optionalStringArray(appx.capabilities, 'desktopStoreConfig.appx.capabilities') ?? [],
    },
  };
}

export function validateStorePackageConfig(config) {
  requireObject(config, 'storePackageConfig');
  const desktop = requireObject(config.desktop, 'storePackageConfig.desktop');
  return {
    ...config,
    supportedWindowsTargets: requireArray(config.supportedWindowsTargets, 'storePackageConfig.supportedWindowsTargets').map((entry, index) => requireNonEmptyString(entry, `storePackageConfig.supportedWindowsTargets[${index}]`)),
    packageVersion: validatePackageVersionConfig(config.packageVersion),
    signing: validateSigningConfig(config.signing),
    desktop: {
      submodulePath: requireNonEmptyString(desktop.submodulePath, 'storePackageConfig.desktop.submodulePath'),
      storeConfigPath: requireNonEmptyString(desktop.storeConfigPath, 'storePackageConfig.desktop.storeConfigPath'),
      buildCommand: requireNonEmptyString(desktop.buildCommand, 'storePackageConfig.desktop.buildCommand'),
      runtimeInjectionPath: requireNonEmptyString(desktop.runtimeInjectionPath, 'storePackageConfig.desktop.runtimeInjectionPath'),
    },
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
    schedule: requireNonEmptyString(config.schedule, 'workflowDefaults.schedule'),
  };
}

export async function loadStorePackageConfig() {
  return validateStorePackageConfig(await readJson(STORE_PACKAGE_CONFIG_PATH));
}

export async function loadDesktopStoreConfig(desktopRoot, relativeConfigPath) {
  const configPath = path.resolve(desktopRoot, relativeConfigPath);
  const config = validateDesktopStoreConfig(await readJson(configPath));
  return {
    config,
    configPath,
  };
}

export async function loadWorkflowDefaults() {
  return validateWorkflowDefaults(await readJson(WORKFLOW_DEFAULTS_PATH));
}

export function normalizeStorePackageVersion(desktopTag, packageVersionConfig = { source: 'desktop-tag', revision: 0 }) {
  const rawTag = requireNonEmptyString(desktopTag, 'desktopTag').replace(/^refs\/tags\//i, '');
  const normalized = rawTag.replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid Desktop tag ${JSON.stringify(desktopTag)}. Expected a stable tag like v1.2.3 so a Store-safe numeric package version can be derived.`);
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
  if (!['disabled', 'enabled', 'required', 'external'].includes(normalized)) {
    throw new Error(`Unsupported signing mode ${JSON.stringify(value)}. Expected disabled, enabled, required, or external.`);
  }
  return normalized;
}

export function getStoreSigningEnvironmentVariableNames(storePackageConfig) {
  const signing = validateSigningConfig(storePackageConfig.signing);
  return [signing.azure.clientIdEnvVar, signing.azure.tenantIdEnvVar, signing.azure.clientSecretEnvVar];
}

export function resolveStoreSigningConfig({
  storePackageConfig,
  env = process.env,
  signingMode = 'disabled',
}) {
  const mode = normalizeStoreSigningMode(signingMode);
  const signing = validateSigningConfig(storePackageConfig.signing);
  const enabled = mode !== 'disabled';
  const required = mode === 'required';
  const external = mode === 'external';
  const configuredPublisher = signing.publisherSubjectEnvVar
    ? (env[signing.publisherSubjectEnvVar]?.trim() || null)
    : null;
  const defaultPublisher = configuredPublisher ?? signing.publisherSubject ?? null;
  const normalizedPublisher = defaultPublisher ? stripOptionalWrappingQuotes(defaultPublisher) : null;
  const publisherName = signing.azure.publisherName ?? normalizedPublisher;

  const resolved = {
    mode,
    enabled,
    required,
    external,
    inlineAzureTrustedSigning: enabled && !external,
    publisher: normalizedPublisher,
    publisherName,
    publisherSubjectEnvVar: signing.publisherSubjectEnvVar ?? null,
    skipFinalAppxSigning: signing.skipFinalAppxSigning,
    verificationScriptRelativePath: signing.verificationScriptRelativePath,
    azure: {
      clientId: env[signing.azure.clientIdEnvVar]?.trim() || null,
      tenantId: env[signing.azure.tenantIdEnvVar]?.trim() || null,
      clientSecret: env[signing.azure.clientSecretEnvVar]?.trim() || null,
      endpoint: signing.azure.endpoint ?? (env[signing.azure.endpointEnvVar]?.trim() || null),
      codeSigningAccountName: signing.azure.codeSigningAccountName ?? (env[signing.azure.codeSigningAccountNameEnvVar]?.trim() || null),
      certificateProfileName: signing.azure.certificateProfileName ?? (env[signing.azure.certificateProfileNameEnvVar]?.trim() || null),
    },
    envVarNames: {
      clientId: signing.azure.clientIdEnvVar,
      tenantId: signing.azure.tenantIdEnvVar,
      clientSecret: signing.azure.clientSecretEnvVar,
    },
    missing: [],
  };

  if (!enabled) {
    return resolved;
  }

  if (!isValidDistinguishedName(resolved.publisher)) {
    throw new Error('Invalid Store signing publisher. Expected an X.500 subject like CN=Example, O=Example Corp, C=US.');
  }

  if (external) {
    return resolved;
  }

  for (const [key, envVarName] of Object.entries(resolved.envVarNames)) {
    if (!resolved.azure[key]) {
      resolved.missing.push(envVarName);
    }
  }

  if (resolved.missing.length > 0) {
    throw new Error(`Missing Store signing configuration: ${resolved.missing.join(', ')}.`);
  }

  if (!resolved.publisherName) {
    throw new Error('Unable to derive Azure Trusted Signing publisherName from storePackageConfig.signing.publisherSubject. Expected the certificate subject to include a CN component.');
  }

  const missingTrustedSigningOptions = [];
  if (!resolved.azure.endpoint) {
    missingTrustedSigningOptions.push('endpoint');
  }
  if (!resolved.azure.codeSigningAccountName) {
    missingTrustedSigningOptions.push('codeSigningAccountName');
  }
  if (!resolved.azure.certificateProfileName) {
    missingTrustedSigningOptions.push('certificateProfileName');
  }

  if (missingTrustedSigningOptions.length > 0) {
    throw new Error(`Missing Azure Trusted Signing options: ${missingTrustedSigningOptions.join(', ')}. Configure them in storePackageConfig.signing.azure or via the declared fallback environment variables.`);
  }

  return resolved;
}
