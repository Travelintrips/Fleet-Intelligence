export type FleetSendType = "manual" | "selected" | "auto";

export function shouldSuppressFleetSend(sendType: FleetSendType, previouslySentAutoToday: boolean, oneTimeResendId?: string): boolean {
  return sendType === "auto" && previouslySentAutoToday && !oneTimeResendId;
}

export function fleetSendIdempotencyKey(args: {
  companyId: number;
  outstandingId: number;
  sendType: FleetSendType;
  manualRequestId?: string | null;
  oneTimeResendId?: string;
  todayWib: string;
}): string {
  if (args.oneTimeResendId) return `fleet-wa:one-time:${args.oneTimeResendId}:${args.outstandingId}`;
  if (args.sendType === "auto") return `fleet-wa:${args.companyId}:${args.outstandingId}:auto:${args.todayWib}`;
  if (!args.manualRequestId) throw new Error("Manual WA request ID is required.");
  return `fleet-wa:${args.companyId}:${args.outstandingId}:${args.sendType}:${args.manualRequestId}`;
}
