function normalizeOptionalString(value) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized : null;
}

export function resolveDlcAzureSasUrl({ dlcAzureSasUrl, serverAzureSasUrl } = {}) {
  return normalizeOptionalString(dlcAzureSasUrl) ?? normalizeOptionalString(serverAzureSasUrl);
}
