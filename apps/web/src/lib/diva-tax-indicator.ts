/**
 * Pure, local-calendar tax indicator for PT Diva Servis.
 * Stored payment state and due-date urgency are separate facts: a past payment
 * must not mark an expired tax period as current or create a new due date.
 */
export type DivaTaxSnapshot = {
  tax_status: string | null;
  tax_due_date: string | null;
  tax_renewed_on: string | null;
  tax_reminder_days?: number | null;
};
export type DivaTaxIndicator = {
  label: string;
  detail: string;
  tone: "success" | "warning" | "danger" | "neutral";
};
const DAY_MS = 86_400_000;
const validDay = (date: string | null | undefined): number | null => {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const millis = Date.parse(date + "T00:00:00Z");
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === date ? millis / DAY_MS : null;
};
export function jakartaCalendarToday(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}
export function divaTaxIndicator(tax: DivaTaxSnapshot, today = jakartaCalendarToday()): DivaTaxIndicator {
  const status = tax.tax_status || "unrecorded";
  const daysToday = validDay(today);
  const daysDue = validDay(tax.tax_due_date);
  const daysLeft = daysToday === null || daysDue === null ? null : daysDue - daysToday;
  // Older Fleet documents use active/expiring_soon rather than the editor-specific paid status.
  // Only display payment confirmation when there is an actual payment date AND a future due date.
  const paidVerified = ["paid_due_verified", "active", "expiring_soon"].includes(status)
    && Boolean(tax.tax_renewed_on) && daysDue !== null;
  const paidUnverified = status === "paid_late_due_unverified" && Boolean(tax.tax_renewed_on);
  const reminder = Number.isInteger(tax.tax_reminder_days) && (tax.tax_reminder_days as number) > 0
    ? Math.min(tax.tax_reminder_days as number, 365) : 30;
  if (paidUnverified || status === "renewed_pending_proof") {
    return {label:"Sudah dibayar · perlu verifikasi",detail:"Jatuh tempo baru atau bukti pembayaran belum diverifikasi",tone:"warning"};
  }
  // If the *known* period is expired, do not present it as paid/current.
  if (daysLeft !== null && daysLeft < 0) {
    return {label:"Lewat jatuh tempo",detail: paidVerified
      ? "Pernah dibayar, tetapi masa berlaku terakhir sudah habis"
      : ["unrecorded", "active", "expiring_soon"].includes(status) ? "Tanggal habis; riwayat pembayaran/perpanjangan terbaru belum terverifikasi"
      : "Belum ada catatan pembayaran/perpanjangan terbaru",tone:"danger"};
  }
  if (daysLeft !== null && daysLeft <= reminder) {
    return {label:"Pajak dekat",detail:daysLeft === 0
      ? "Jatuh tempo hari ini" : `Jatuh tempo dalam ${daysLeft} hari`,tone:"warning"};
  }
  if (status === "unrecorded" || (status === "active" && !paidVerified)) {
    return {label:"Belum tercatat",detail:"Pembayaran/perpanjangan belum tercatat",tone:"neutral"};
  }
  if (paidVerified) {
    return {label:"Sudah dibayar",detail:"Jatuh tempo berikutnya telah diverifikasi",tone:"success"};
  }
  if (status === "unpaid" || status === "due_soon") {
    return {label:"Belum dibayar",detail:daysLeft === null
      ? "Tanggal jatuh tempo belum diketahui" : `Jatuh tempo dalam ${daysLeft} hari`,tone:"warning"};
  }
  return {label:"Perlu verifikasi",detail:"Status pajak belum cocok dengan data tanggal",tone:"neutral"};
}
