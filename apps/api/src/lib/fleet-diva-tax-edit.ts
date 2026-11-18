import { divaTaxWriterPool } from "./fleet-diva-tax-db";

const PLATES = new Set(["B1649PNV", "B1650PNV", "B1926PDT"]);
export const DIVA_TAX_STATUSES = [
  "paid_due_verified", "paid_late_due_unverified", "due_soon", "unpaid",
] as const;
type TaxStatus = (typeof DIVA_TAX_STATUSES)[number];

export class DivaTaxEditError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function validDate(input: unknown, allowEmpty: boolean): string | null {
  if (input === null || input === "") {
    if (allowEmpty) return null;
    throw new DivaTaxEditError("Tanggal wajib diisi.");
  }
  if (typeof input !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(input)) {
    throw new DivaTaxEditError("Tanggal harus memakai format YYYY-MM-DD.");
  }
  const [year, month, day] = input.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0,10) !== input) throw new DivaTaxEditError("Tanggal kalender tidak valid.");
  return input;
}

export function validateDivaTaxEdit(plate: string, body: Record<string,unknown>) {
  if (!PLATES.has(plate)) throw new DivaTaxEditError("Kendaraan ini bukan aset Diva yang disetujui.", 404);
  const status = body.status;
  if (typeof status !== "string" || !(DIVA_TAX_STATUSES as readonly string[]).includes(status)) {
    throw new DivaTaxEditError("Status pajak tidak valid.");
  }
  const paidOn = validDate(body.paidOn, true);
  const dueOn = validDate(body.dueOn, true);
  if (["paid_due_verified", "paid_late_due_unverified"].includes(status) && !paidOn) {
    throw new DivaTaxEditError("Status sudah dibayar membutuhkan tanggal pembayaran.");
  }
  if (["unpaid", "due_soon"].includes(status) && paidOn) {
    throw new DivaTaxEditError("Status belum dibayar tidak boleh memiliki tanggal pembayaran.");
  }
  if (["unpaid", "due_soon"].includes(status) && !dueOn) {
    throw new DivaTaxEditError("Pajak belum dibayar membutuhkan tanggal jatuh tempo.");
  }
  if (status === "paid_due_verified" && !dueOn) {
    throw new DivaTaxEditError("Jatuh tempo baru wajib diisi untuk status terverifikasi.");
  }
  if (status === "paid_late_due_unverified" && dueOn) {
    throw new DivaTaxEditError("Jatuh tempo berikutnya belum diverifikasi; kosongkan tanggal baru.");
  }
  if (paidOn && dueOn && dueOn <= paidOn) {
    throw new DivaTaxEditError("Jatuh tempo tahun berikutnya harus sesudah tanggal pembayaran.");
  }
  const version = body.version;
  if (typeof version !== "string" || Number.isNaN(new Date(version).getTime())) {
    throw new DivaTaxEditError("Versi data pajak wajib valid untuk mencegah penimpaan.");
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > 300 || /[\r\n\u0000-\u001f]/.test(note)) {
    throw new DivaTaxEditError("Catatan maksimal 300 karakter tanpa baris baru.");
  }
  return { paidOn, dueOn, status: status as TaxStatus, version, note };
}

export async function editDivaAnnualTax(plate: string, input: Record<string,unknown>, actor: string) {
  const payload = validateDivaTaxEdit(plate, input);
  if (typeof actor !== "string" || !actor.includes("@") || actor.length > 255) {
    throw new DivaTaxEditError("Identitas admin tidak valid.", 403);
  }
  const client = await divaTaxWriterPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='12000ms'");
    await client.query("SET LOCAL lock_timeout='3000ms'");
    const result = await client.query(
      `SELECT d.id,d.issued_date::text paid_on,d.expired_date::text due_on,d.status,d.updated_at::text version
         FROM public.fleet_documents d
         JOIN public.fleet_units u ON u.id=d.fleet_unit_id AND u.company_id=d.company_id
        WHERE d.company_id='3' AND d.doc_type='annual_vehicle_tax'
          AND u.company_id='3' AND u.plate_number=$1 LIMIT 2`,[plate],
    );
    if (result.rows.length !== 1) throw new DivaTaxEditError("Dokumen pajak tidak ditemukan atau duplikat.", 409);
    const before = result.rows[0];
    if (new Date(before.version).getTime() !== new Date(payload.version).getTime()) {
      throw new DivaTaxEditError("Data berubah. Muat ulang sebelum menyimpan.", 409);
    }
    const msg = `[Edit pajak DEV ${new Date().toISOString()} oleh ${actor}] status=${payload.status}; bayar=${payload.paidOn || "-"}; habis=${payload.dueOn || "-"}; ${payload.note}`;
    const updated = await client.query(
      `UPDATE public.fleet_documents SET
          issued_date=$1::date, expired_date=$2::date, status=$3,
          notes=LEFT(COALESCE(notes,'') || E'\\n' || $4, 10000), updated_at=now()
        WHERE id=$5 AND company_id='3' AND doc_type='annual_vehicle_tax'
          AND updated_at=$6::timestamptz
        RETURNING id,issued_date::text paid_on,expired_date::text due_on,status,updated_at::text version`,
      [payload.paidOn,payload.dueOn,payload.status,msg,before.id,payload.version],
    );
    if (updated.rows.length !== 1) throw new DivaTaxEditError("Perubahan bersamaan terdeteksi. Muat ulang.", 409);
    const after = updated.rows[0];
    await client.query(
      `INSERT INTO public.fleet_tax_edit_audit_dev
       (company_id,document_id,plate_number,actor,before_state,after_state)
       VALUES ('3',$1,$2,$3,$4::jsonb,$5::jsonb)`,
      [before.id,plate,actor,
       JSON.stringify({paidOn:before.paid_on,dueOn:before.due_on,status:before.status}),
       JSON.stringify({paidOn:after.paid_on,dueOn:after.due_on,status:after.status,note:payload.note})],
    );
    await client.query("COMMIT");
    return {ok:true,plate,companyId:3,paidOn:after.paid_on,dueOn:after.due_on,status:after.status,version:after.version};
  } catch (error) {
    await client.query("ROLLBACK").catch(()=>undefined);
    throw error;
  } finally {client.release();}
}
