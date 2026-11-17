import type { NextFunction, Response } from "express";
import type { AdminRequest } from "../routes/admin-auth";
import { isFleetCashDevEnabled } from "./fleet-cash-db";

const ORIGIN = "https://dev-fleet.cstlogistic.co.id";

/** Existing authenticateAdmin has already verified the signed, pinned Google session. */
export function requireFleetCashDevAccess(req: AdminRequest, res: Response, next: NextFunction): void {
  if (process.env.APP_ENV !== "development") { next(); return; }
  if (!isFleetCashDevEnabled()) {
    res.status(409).json({ error: "Pembayaran Fleet DEV belum diaktifkan.", code: "FLEET_CASH_DEV_DISABLED" });
    return;
  }
  if (process.env.FLEET_DEV_GOOGLE_AUTH_ENABLED !== "true" || process.env.APP_BASE_URL !== ORIGIN ||
      !req.secure || req.hostname !== "dev-fleet.cstlogistic.co.id" ||
      req.adminUser?.role !== "super_admin" || Number(req.adminUser?.companyId) !== 1) {
    res.status(403).json({ error: "Pembayaran Fleet DEV memerlukan sesi Google Super Admin perusahaan sumber.", code: "FLEET_CASH_DEV_FORBIDDEN" });
    return;
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (req.get("origin") !== ORIGIN) {
      res.status(403).json({ error: "Origin pembayaran Fleet tidak valid.", code: "FLEET_CASH_ORIGIN_FORBIDDEN" });
      return;
    }
    for (const key of ["companyId", "company_id", "sourceCompanyId"]) {
      if (req.body?.[key] !== undefined && Number(req.body[key]) !== 1) {
        res.status(403).json({ error: "Perusahaan sumber pembayaran tidak sesuai sesi." });
        return;
      }
    }
  }
  res.setHeader("Cache-Control", "private, no-store");
  next();
}
