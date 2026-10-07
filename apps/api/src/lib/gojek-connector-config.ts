export type GojekConnectorConfig = {
  enabled: boolean;
  mode: "interactive_export";
  portalUrl: string;
  allowedHost: string;
  sharedSecretConfigured: boolean;
  encryptionKeyConfigured: boolean;
  companyId: number;
  maxFileMb: number;
  retentionHours: number;
};

function boolEnv(value: unknown): boolean {
  return String(value ?? "").trim().toLowerCase() === "true";
}

export function getGojekConnectorConfig(): GojekConnectorConfig {
  const portalUrl = String(
    process.env.GOJEK_FLEET_PORTAL_URL ?? "https://fleetpartner.gojek.com",
  ).trim();

  const parsed = new URL(portalUrl);
  const allowedHost = String(
    process.env.GOJEK_CONNECTOR_ALLOWED_HOST ?? "fleetpartner.gojek.com",
  ).trim();

  if (parsed.protocol !== "https:" || parsed.hostname !== allowedHost) {
    throw new Error("GOJEK_FLEET_PORTAL_URL wajib HTTPS dan sesuai GOJEK_CONNECTOR_ALLOWED_HOST.");
  }

  const companyId = Number(process.env.GOJEK_CONNECTOR_COMPANY_ID ?? 1);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new Error("GOJEK_CONNECTOR_COMPANY_ID wajib integer positif.");
  }

  return {
    enabled: boolEnv(process.env.GOJEK_CONNECTOR_ENABLED),
    mode: "interactive_export",
    portalUrl,
    allowedHost,
    sharedSecretConfigured: Boolean(String(process.env.GOJEK_CONNECTOR_SHARED_SECRET ?? "").trim()),
    encryptionKeyConfigured: Boolean(String(process.env.GOJEK_CONNECTOR_ENCRYPTION_KEY ?? "").trim()),
    companyId,
    maxFileMb: Math.min(Math.max(Number(process.env.GOJEK_CONNECTOR_MAX_FILE_MB ?? 10) || 10, 1), 12),
    retentionHours: Math.min(Math.max(Number(process.env.GOJEK_CONNECTOR_RETENTION_HOURS ?? 24) || 24, 1), 168),
  };
}
