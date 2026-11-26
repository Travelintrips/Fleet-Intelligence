import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock("../lib/fleet-diva-prod-db", () => ({
  divaTaxWriterPool: { connect: db.connect },
}));

import {
  createDivaAsset,
  DivaAssetCreateError,
  validateDivaAssetCreate,
} from "../lib/fleet-diva-asset-create";
import { editDivaAnnualTax, validateDivaTaxEdit } from "../lib/fleet-diva-tax-edit-prod";

const actor = "fleet-admin@example.test";
const version = "2026-11-26T08:00:00.000Z";
const input = (overrides: Record<string, unknown> = {}) => ({
  plate: " b 9876 xyz ",
  vehicleType: "car",
  brand: " Wuling ",
  model: " Cloud EV ",
  year: "2026",
  color: " Putih ",
  chassisNumber: " lsv11223344556677 ",
  engineNumber: " eng9876xyz ",
  fuelType: "electric",
  notes: "Unit baru perusahaan",
  taxStatus: "unrecorded",
  taxPaidOn: "",
  taxDueOn: "",
  ...overrides,
});

function calls() {
  return db.query.mock.calls.map(([sql, values]) => ({
    sql: String(sql),
    values: (values ?? []) as unknown[],
  }));
}

function insertsInto(table: string) {
  return calls().filter(call => new RegExp(`\\bINSERT\\s+INTO\\s+public\\.${table}\\b`, "i").test(call.sql));
}

beforeEach(() => {
  db.connect.mockReset();
  db.query.mockReset();
  db.release.mockReset();
  db.connect.mockResolvedValue({ query: db.query, release: db.release });
  db.query.mockImplementation(async (sql: string) => {
    if (/\bINSERT\s+INTO\s+public\.fleet_units\b/i.test(sql)) {
      return { rows: [{ id: 101, company_id: "3", plate_number: "B9876XYZ" }], rowCount: 1 };
    }
    if (/\bINSERT\s+INTO\s+public\.fleet_documents\b/i.test(sql)) {
      return { rows: [{ id: 201, updated_at: version, version }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
});

describe("Diva asset registration validation", () => {
  it("normalizes a complete vehicle identity before storage", () => {
    expect(validateDivaAssetCreate(input())).toMatchObject({
      plate: "B9876XYZ",
      vehicleType: "car",
      brand: "Wuling",
      model: "Cloud EV",
      chassisNumber: "LSV11223344556677",
      engineNumber: "ENG9876XYZ",
      fuelType: "electric",
    });
  });

  it.each(["plate", "brand", "model", "chassisNumber", "engineNumber"])(
    "requires the %s vehicle identity field",
    field => expect(() => validateDivaAssetCreate(input({ [field]: "   " }))).toThrow(DivaAssetCreateError),
  );

  it("uses Mobil when no vehicle type is supplied", () => {
    expect(validateDivaAssetCreate(input({ vehicleType: undefined })).vehicleType).toBe("car");
  });

  it.each([
    { companyId: 1 },
    { companyId: "1" },
    { ownershipType: "rental" },
    { vehicleType: "aircraft" },
    { fuelType: "unsupported" },
    { year: "not-a-year" },
    { year: 2026.5 },
    { plate: "not a plate" },
    { brand: "x".repeat(101) },
    { model: "x".repeat(101) },
    { color: "x".repeat(61) },
    { chassisNumber: "x".repeat(65) },
    { engineNumber: "ab" },
    { notes: "x".repeat(1001) },
  ])("rejects invalid company, ownership, or vehicle data: %j", fields => {
    expect(() => validateDivaAssetCreate(input(fields))).toThrow(DivaAssetCreateError);
  });

  it("accepts a missing fuel choice without applying the database's diesel default", () => {
    expect(validateDivaAssetCreate(input({ fuelType: "" })).fuelType).toBeNull();
  });

  it.each([
    { taxStatus: "unrecorded", taxPaidOn: "2026-11-20" },
    { taxStatus: "unrecorded", taxDueOn: "2027-11-20" },
    { taxStatus: "unpaid", taxDueOn: "" },
    { taxStatus: "due_soon", taxPaidOn: "2026-11-20", taxDueOn: "2027-11-20" },
    { taxStatus: "paid_due_verified", taxPaidOn: "", taxDueOn: "2027-11-20" },
    { taxStatus: "paid_due_verified", taxPaidOn: "2026-11-20", taxDueOn: "" },
    { taxStatus: "paid_due_verified", taxPaidOn: "2026-11-20", taxDueOn: "2026-11-20" },
    { taxStatus: "paid_due_verified", taxPaidOn: "2026-11-20", taxDueOn: "2026-11-19" },
    { taxStatus: "paid_late_due_unverified", taxPaidOn: "" },
    { taxStatus: "paid_late_due_unverified", taxPaidOn: "2026-11-20", taxDueOn: "2027-11-20" },
    { taxStatus: "unpaid", taxDueOn: "2027-02-30" },
    { taxStatus: "unpaid", taxDueOn: "20-11-2027" },
    { taxStatus: "invented" },
  ])("rejects inconsistent or invalid tax dates: %j", fields => {
    expect(() => validateDivaAssetCreate(input(fields))).toThrow(DivaAssetCreateError);
  });

  it.each([
    { taxStatus: "unrecorded", taxPaidOn: "", taxDueOn: "" },
    { taxStatus: "unpaid", taxPaidOn: "", taxDueOn: "2027-11-20" },
    { taxStatus: "due_soon", taxPaidOn: "", taxDueOn: "2026-12-20" },
    { taxStatus: "paid_due_verified", taxPaidOn: "2026-11-20", taxDueOn: "2027-11-20" },
    { taxStatus: "paid_late_due_unverified", taxPaidOn: "2026-11-20", taxDueOn: "" },
    { taxStatus: "unpaid", taxPaidOn: "", taxDueOn: "2028-02-29" },
  ])("accepts a supported tax record: %j", fields => {
    expect(() => validateDivaAssetCreate(input(fields))).not.toThrow();
  });
});

describe("Diva asset registration transaction", () => {
  it("saves the unit, annual tax document and creation audit in one transaction", async () => {
    const result = await createDivaAsset(input(), actor);

    expect(result).toMatchObject({ ok: true, companyId: 3 });
    expect(db.connect).toHaveBeenCalledTimes(1);
    expect(insertsInto("fleet_units")).toHaveLength(1);
    expect(insertsInto("fleet_documents")).toHaveLength(1);
    expect(insertsInto("fleet_tax_edit_audit")).toHaveLength(1);
    const statements = calls().map(call => call.sql.trim());
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(statements).not.toContain("ROLLBACK");

    const unit = insertsInto("fleet_units")[0];
    expect(unit.values).toContain("B9876XYZ");
    expect(unit.values).toContain("LSV11223344556677");
    expect(unit.values).toContain("ENG9876XYZ");
    expect(unit.sql + JSON.stringify(unit.values)).toContain("registered");
    expect(unit.sql + JSON.stringify(unit.values)).toContain("own");

    const document = insertsInto("fleet_documents")[0];
    expect(document.values).toContain(101);
    expect(document.sql + JSON.stringify(document.values)).toContain("annual_vehicle_tax");

    const audit = insertsInto("fleet_tax_edit_audit")[0];
    expect(audit.values).toContain(201);
    expect(audit.values).toContain(actor);
    expect(audit.sql + JSON.stringify(audit.values)).toContain("asset_registered");

    // This feature must never add an operational GoCar vehicle or a finance transaction.
    expect(statements.join("\n")).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.(?:fleet_vehicles|fleet_transactions|journal_entries)\b/i);
    expect(db.release).toHaveBeenCalledTimes(1);
  });

  it("rejects bad input before acquiring a writer connection", async () => {
    await expect(createDivaAsset(input({ chassisNumber: "" }), actor)).rejects.toBeInstanceOf(DivaAssetCreateError);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rejects missing admin identity before acquiring a writer connection", async () => {
    await expect(createDivaAsset(input(), "")).rejects.toMatchObject({ status: 403 });
    expect(db.connect).not.toHaveBeenCalled();
  });

  it.each(["fleet_documents", "fleet_tax_edit_audit"])(
    "rolls the asset back if %s cannot be saved",
    async table => {
      const normalQuery = db.query.getMockImplementation()!;
      const failure = new Error("Synthetic write failure");
      db.query.mockImplementation(async (sql: string, values?: unknown[]) => {
        if (new RegExp(`\\bINSERT\\s+INTO\\s+public\\.${table}\\b`, "i").test(sql)) throw failure;
        return normalQuery(sql, values);
      });

      await expect(createDivaAsset(input(), actor)).rejects.toThrow();
      expect(insertsInto("fleet_units")).toHaveLength(1);
      expect(calls().map(call => call.sql.trim())).toContain("ROLLBACK");
      expect(calls().map(call => call.sql.trim())).not.toContain("COMMIT");
      expect(db.release).toHaveBeenCalledTimes(1);
    },
  );

  it("returns a conflict for a concurrent duplicate save and never overwrites the asset", async () => {
    const normalQuery = db.query.getMockImplementation()!;
    db.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (/\bINSERT\s+INTO\s+public\.fleet_units\b/i.test(sql)) {
        throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
      }
      return normalQuery(sql, values);
    });

    await expect(createDivaAsset(input(), actor)).rejects.toMatchObject({ status: 409 });
    expect(insertsInto("fleet_documents")).toHaveLength(0);
    expect(calls().map(call => call.sql.trim())).toContain("ROLLBACK");
    expect(calls().map(call => call.sql).join("\n")).not.toMatch(/\bON\s+CONFLICT\s+[\s\S]*\bDO\s+UPDATE\b|\bUPDATE\s+public\.fleet_units\b/i);
    expect(db.release).toHaveBeenCalledTimes(1);
  });

  it("still releases its connection when rollback itself fails", async () => {
    const normalQuery = db.query.getMockImplementation()!;
    db.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (/\bINSERT\s+INTO\s+public\.fleet_documents\b/i.test(sql)) throw new Error("Document unavailable");
      if (sql.trim() === "ROLLBACK") throw new Error("Connection already closed");
      return normalQuery(sql, values);
    });

    await expect(createDivaAsset(input(), actor)).rejects.toThrow();
    expect(db.release).toHaveBeenCalledTimes(1);
    expect(calls().map(call => call.sql.trim())).not.toContain("COMMIT");
  });
});

describe("Tax editing after Diva asset registration", () => {
  const edit = () => ({ status: "unpaid", paidOn: null, dueOn: "2027-11-20", version, note: "Data STNK diterima" });

  it.each(["B1131PNR", "B9876XYZ"])("accepts the registered plate %s instead of a fixed Wuling list", plate => {
    expect(() => validateDivaTaxEdit(plate, edit())).not.toThrow();
  });

  it("edits a new registered asset and appends its tax audit", async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (/\bSELECT\s+d\.id/i.test(sql)) {
        return { rows: [{ id: 201, paid_on: null, due_on: null, status: "unrecorded", version }], rowCount: 1 };
      }
      if (/\bUPDATE\s+public\.fleet_documents/i.test(sql)) {
        return { rows: [{ id: 201, paid_on: null, due_on: "2027-11-20", status: "unpaid", version: "2026-11-26T09:00:00Z" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(editDivaAnnualTax("B9876XYZ", edit(), actor)).resolves.toMatchObject({ ok: true, companyId: 3, plate: "B9876XYZ", status: "unpaid" });
    expect(insertsInto("fleet_tax_edit_audit")).toHaveLength(1);
    expect(insertsInto("fleet_tax_edit_audit")[0].values).toContain("B9876XYZ");
    expect(calls().map(call => call.sql.trim()).at(-1)).toBe("COMMIT");
    expect(db.release).toHaveBeenCalledTimes(1);
  });

  it("does not edit a plate absent from the scoped Company-3 registry", async () => {
    await expect(editDivaAnnualTax("B9876XYZ", edit(), actor)).rejects.toMatchObject({ status: 409 });
    expect(calls().some(call => /\bUPDATE\s+public\.fleet_documents/i.test(call.sql))).toBe(false);
    expect(calls().map(call => call.sql.trim())).toContain("ROLLBACK");
    expect(db.release).toHaveBeenCalledTimes(1);
  });

  it("keeps stale-version protection for a newly registered asset", async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (/\bSELECT\s+d\.id/i.test(sql)) {
        return { rows: [{ id: 201, paid_on: null, due_on: null, status: "unrecorded", version: "2026-11-26T09:00:00Z" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(editDivaAnnualTax("B9876XYZ", edit(), actor)).rejects.toMatchObject({ status: 409 });
    expect(calls().some(call => /\bUPDATE\s+public\.fleet_documents/i.test(call.sql))).toBe(false);
    expect(insertsInto("fleet_tax_edit_audit")).toHaveLength(0);
    expect(calls().map(call => call.sql.trim())).toContain("ROLLBACK");
    expect(db.release).toHaveBeenCalledTimes(1);
  });
});
