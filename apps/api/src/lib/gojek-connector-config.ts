export type GojekConnectorConfig = {
  enabled: boolean;
  mode: "interactive_export";
  portalUrl: string;
  allowedHost: string;
  sharedSecretConfigured: boolean;
  encryptionKeyConfigured: boolean;
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

  return {
    enabled: boolEnv(process.env.GOJEK_CONNECTOR_ENABLED),
    mode: "interactive_export",
    portalUrl,
    allowedHost,
    sharedSecretConfigured: Boolean(String(process.env.GOJEK_CONNECTOR_SHARED_SECRET ?? "").trim()),
    encryptionKeyConfigured: Boolean(String(process.env.GOJEK_CONNECTOR_ENCRYPTION_KEY ?? "").trim()),
    maxFileMb: Math.min(Math.max(Number(process.env.GOJEK_CONNECTOR_MAX_FILE_MB ?? 25) || 25, 1), 100),
    retentionHours: Math.min(Math.max(Number(process.env.GOJEK_CONNECTOR_RETENTION_HOURS ?? 24) || 24, 1), 168),
  };
}
