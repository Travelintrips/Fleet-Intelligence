import { divaTaxWriterPool } from "./fleet-diva-prod-db";
import { DivaTaxEditError, validateDivaTaxDetails } from "./fleet-diva-tax-edit-prod";

export class DivaAssetCreateError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function textField(value: unknown, label: string, max: number, required = false): string {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new DivaAssetCreateError(`${label} harus berupa teks.`);
  }
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new DivaAssetCreateError(`${label} wajib diisi.`);
  if (result.length > max || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new DivaAssetCreateError(`${label} maksimal ${max} karakter tanpa karakter kontrol.`);
  }
  return result;
}

function identifier(value: unknown, label: string): string {
  const result = textField(value, label, 100, true).toUpperCase().replace(/[ -]/g, "");
  if (!/^[A-Z0-9]{5,64}$/.test(result)) {
    throw new DivaAssetCreateError(`${label} harus berisi 5–64 huruf atau angka.`);
  }
  return result;
}

export function validateDivaAssetCreate(input: Record<string, unknown>) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DivaAssetCreateError("Data kendaraan tidak valid.");
  }
  for (const key of ["companyId", "company_id"] as const) {
    if (input[key] !== undefined && input[key] !== 3 && input[key] !== "3") {
      throw new DivaAssetCreateError("Pemilik kendaraan harus PT Diva Servis.");
    }
  }
  for (const key of ["ownershipType", "ownership_type"] as const) {
    if (input[key] !== undefined && input[key] !== "own") {
      throw new DivaAssetCreateError("Kendaraan harus milik PT Diva Servis.");
    }
  }
  for (const key of ["assetStatus", "status"] as const) {
    if (input[key] !== undefined && input[key] !== "registered") {
      throw new DivaAssetCreateError("Status awal aset harus terdaftar.");
    }
  }
  const rawPlate = textField(input.plate, "Nomor polisi", 24, true);
  const plate = rawPlate.toUpperCase().replace(/[ -]/g, "");
  if (!/^[A-Z]{1,3}[0-9]{1,4}[A-Z]{0,3}$/.test(plate)) {
    throw new DivaAssetCreateError("Nomor polisi tidak valid. Contoh: B 1131 PNR.");
  }
  const vehicleType = input.vehicleType ?? "car";
  if (typeof vehicleType !== "string" || !["car", "motor", "van"].includes(vehicleType)) {
    throw new DivaAssetCreateError("Tipe kendaraan tidak valid.");
  }
  let year: number | null = null;
  if (input.year !== undefined && input.year !== null && input.year !== "") {
    if (!/^[0-9]{4}$/.test(String(input.year))) {
      throw new DivaAssetCreateError("Tahun kendaraan harus empat digit.");
    }
    year = Number(input.year);
    if (year < 1900 || year > new Date().getFullYear() + 1) {
      throw new DivaAssetCreateError("Tahun kendaraan tidak valid.");
    }
  }
  const fuelType = input.fuelType === "" || input.fuelType === undefined ? null : input.fuelType;
  if (fuelType !== null && (typeof fuelType !== "string" || !["electric", "bensin", "solar", "hybrid"].includes(fuelType))) {
    throw new DivaAssetCreateError("Jenis bahan bakar tidak valid.");
  }
  let tax;
  try {
    tax = validateDivaTaxDetails({
      status: input.taxStatus ?? "unrecorded", paidOn: input.taxPaidOn, dueOn: input.taxDueOn,
    });
  } catch (error) {
    if (error instanceof DivaTaxEditError) throw new DivaAssetCreateError(error.message, error.status);
    throw error;
  }
  return {
    companyId: 3 as const, ownershipType: "own" as const, assetStatus: "registered" as const,
    plate, vehicleType, brand: textField(input.brand, "Merek", 100, true),
    model: textField(input.model, "Model", 100, true), year,
    color: textField(input.color, "Warna", 60),
    chassisNumber: identifier(input.chassisNumber, "Nomor rangka / VIN"),
    engineNumber: identifier(input.engineNumber, "Nomor mesin"), fuelType,
    notes: textField(input.notes, "Catatan", 1000),
    taxStatus: tax.status, taxPaidOn: tax.paidOn, taxDueOn: tax.dueOn,
  };
}

export async function createDivaAsset(input: Record<string, unknown>, actor: string) {
  const payload = validateDivaAssetCreate(input);
  if (typeof actor !== "string" || actor.length > 255 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actor)) {
    throw new DivaAssetCreateError("Identitas admin tidak valid.", 403);
  }
  const client = await divaTaxWriterPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='12000ms'");
    await client.query("SET LOCAL lock_timeout='3000ms'");
    // The partial unique indexes on Company 3 are the final authority for
    // concurrent submissions and prevent an accidental overwrite on retry.
    const unit = await client.query(
      `INSERT INTO public.fleet_units
        (company_id,unit_number,plate_number,vehicle_type,brand,model,year,color,
         chassis_number,engine_number,fuel_type,ownership_type,status,notes,is_active,created_by)
       VALUES ('3',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'own','registered',$11,true,$12)
       RETURNING id,plate_number`,
      [`DVS-${payload.plate}`,payload.plate,payload.vehicleType,payload.brand,payload.model,
       payload.year,payload.color || null,payload.chassisNumber,payload.engineNumber,
       payload.fuelType,payload.notes || null,actor],
    );
    const asset = unit.rows[0];
    if (!asset?.id) throw new Error("DIVA_ASSET_INSERT_EMPTY");
    const tax = await client.query(
      `INSERT INTO public.fleet_documents
        (company_id,fleet_unit_id,doc_type,issued_date,expired_date,status,reminder_days,created_by)
       VALUES ('3',$1,'annual_vehicle_tax',$2::date,$3::date,$4,30,$5)
       RETURNING id,updated_at::text AS version`,
      [asset.id,payload.taxPaidOn,payload.taxDueOn,payload.taxStatus,actor],
    );
    const document = tax.rows[0];
    if (!document?.id) throw new Error("DIVA_ASSET_TAX_INSERT_EMPTY");
    await client.query(
      `INSERT INTO public.fleet_tax_edit_audit
        (company_id,document_id,plate_number,actor,before_state,after_state)
       VALUES ('3',$1,$2,$3,'{}'::jsonb,$4::jsonb)`,
      [document.id,payload.plate,actor,
       JSON.stringify({action:"asset_registered",unitId:asset.id,...payload})],
    );
    await client.query("COMMIT");
    return {ok:true,companyId:3,plate:payload.plate,asset,tax:document};
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const code = (error as {code?: string})?.code;
    if (code === "23505") {
      throw new DivaAssetCreateError("Nomor polisi, nomor rangka, atau nomor mesin sudah terdaftar pada aset PT Diva Servis.",409);
    }
    if (code === "42501") {
      throw new DivaAssetCreateError("Penyimpanan aset PT Diva Servis belum tersedia. Silakan hubungi pengelola Fleet.",503);
    }
    throw error;
  } finally { client.release(); }
}
