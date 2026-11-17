/** Evidence-only display state; a matching row is NEVER dispatch authorization. */
export interface VehicleEvidenceView {
  label: "Perlu Review" | "Bukti data cocok" | "Belum diverifikasi";
  tone: "warning" | "ok" | "unknown";
  reasons: string[];
}

export function fleetVehicleEvidenceView(vehicle: Record<string, unknown>): VehicleEvidenceView {
  const reasons = vehicle.review_reasons;
  if (
    !Array.isArray(reasons) ||
    !reasons.every((reason) => typeof reason === "string" && reason.length > 0) ||
    typeof vehicle.needs_review !== "boolean" ||
    vehicle.needs_review !== (reasons.length > 0)
  ) {
    return {
      label: "Belum diverifikasi",
      tone: "unknown",
      reasons: ["API belum menyediakan bukti data lengkap"],
    };
  }
  if (reasons.length > 0) {
    return { label: "Perlu Review", tone: "warning", reasons };
  }
  return { label: "Bukti data cocok", tone: "ok", reasons: [] };
}
