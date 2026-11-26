/**
 * Execute the exact migration against disposable in-memory PostgreSQL (PGlite).
 * This script accepts no database URL and cannot connect to DEV or PROD.
 * Run npm run test:diva-db with the pinned development dependency, or set:
 * FLEET_DIVA_PGLITE_MODULE=/absolute/path/to/pglite/dist/index.js \
 *   node scripts/verify-diva-asset-create.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const modulePath = process.env.FLEET_DIVA_PGLITE_MODULE;
const { PGlite } = await import(modulePath ? pathToFileURL(modulePath).href : "@electric-sql/pglite");
const db = new PGlite();
const reader = "fleet_diva_asset_reader_login_prod";
const editor = "fleet_diva_tax_editor_login_prod";
const checks = [];

async function check(name, action) {
  await action();
  checks.push(name);
  console.log(`PASS ${name}`);
}
async function role(name, action) {
  assert.ok([reader, editor].includes(name));
  await db.exec(`SET ROLE ${name}`);
  try { return await action(); }
  finally { await db.exec("RESET ROLE"); }
}
async function rejected(code, action) {
  await assert.rejects(action, error => error?.code === code);
}
async function snapshot(table, lastId = 2147483647) {
  assert.ok(["fleet_units", "fleet_documents", "fleet_tax_edit_audit", "fleet_vehicles", "fleet_drivers", "fleet_transactions", "fleet_outstanding"].includes(table));
  return (await db.query(`SELECT COALESCE(jsonb_agg(t ORDER BY id), '[]'::jsonb) AS rows FROM public.${table} t WHERE id <= $1`, [lastId])).rows[0].rows;
}

// The fixture preserves the relevant live column types/defaults and old grants.
// No production row contents or credentials are loaded into this test database.
const fixture = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE TABLE public.companies (id integer PRIMARY KEY, name text, is_active boolean);
INSERT INTO public.companies VALUES (3, 'PT Diva Servis', true);
CREATE TABLE public.fleet_units (
 id serial PRIMARY KEY, company_id text NOT NULL DEFAULT 'default',
 unit_number text NOT NULL, plate_number text NOT NULL, vehicle_type text NOT NULL DEFAULT 'truck',
 brand text, model text, year integer, engine_number text, chassis_number text, color text,
 capacity_kg real, capacity_m3 real, fuel_type text DEFAULT 'solar', ownership_type text DEFAULT 'own',
 status text NOT NULL DEFAULT 'available', current_odometer_km real DEFAULT 0,
 base_location text, assigned_driver_id integer, photo_url text, notes text,
 is_active boolean NOT NULL DEFAULT true, created_by text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.fleet_documents (
 id serial PRIMARY KEY, company_id text NOT NULL DEFAULT 'default', fleet_unit_id integer NOT NULL,
 doc_type text NOT NULL, doc_number text, issued_date date, expired_date date,
 issuing_authority text, file_url text, status text NOT NULL DEFAULT 'active',
 reminder_days integer DEFAULT 30, notes text, created_by text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.fleet_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY deny_all_until_explicit_policy ON public.fleet_units TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY deny_all_until_explicit_policy ON public.fleet_documents TO anon, authenticated USING (false) WITH CHECK (false);
INSERT INTO public.fleet_units (company_id,unit_number,plate_number,ownership_type)
 VALUES ('default','OTHER-UNIT','D100AAA','own'), ('3','LEASED-UNIT','B8000RNT','rent');
INSERT INTO public.fleet_documents (company_id,fleet_unit_id,doc_type)
 VALUES ('default',1,'annual_vehicle_tax'), ('3',2,'annual_vehicle_tax');
CREATE TABLE public.fleet_vehicles (id serial PRIMARY KEY, company_id integer, evidence text);
CREATE TABLE public.fleet_drivers (id serial PRIMARY KEY, company_id integer, evidence text);
CREATE TABLE public.fleet_transactions (id serial PRIMARY KEY, company_id integer, evidence text);
CREATE TABLE public.fleet_outstanding (id serial PRIMARY KEY, company_id integer, evidence text);
INSERT INTO public.fleet_vehicles (company_id,evidence) VALUES (1,'operational-baseline');
INSERT INTO public.fleet_drivers (company_id,evidence) VALUES (1,'driver-baseline');
INSERT INTO public.fleet_transactions (company_id,evidence) VALUES (1,'transaction-baseline');
INSERT INTO public.fleet_outstanding (company_id,evidence) VALUES (1,'outstanding-baseline');
`;

async function insertUnit(overrides = {}) {
  const value = {
    company: "3", unitNumber: "DVS-TEST-B9001TST", plate: "B9001TST", vehicleType: "car",
    brand: "Test", model: "Fixture", year: 2026, color: "White",
    chassis: "TESTVIN000000001", engine: "TESTENGINE000001", fuel: "electric",
    ownership: "own", status: "registered", notes: "Isolated test only", active: true,
    actor: "fleet-test@example.invalid", ...overrides,
  };
  return (await db.query(`
    INSERT INTO public.fleet_units
     (company_id,unit_number,plate_number,vehicle_type,brand,model,year,color,
      chassis_number,engine_number,fuel_type,ownership_type,status,notes,is_active,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    RETURNING id,plate_number`, Object.values(value))).rows[0];
}
async function insertTax(unitId, overrides = {}) {
  const value = { company: "3", unitId, type: "annual_vehicle_tax", status: "unrecorded", ...overrides };
  return (await db.query(`
    INSERT INTO public.fleet_documents
     (company_id,fleet_unit_id,doc_type,issued_date,expired_date,status,reminder_days,created_by)
    VALUES ($1,$2,$3,NULL,NULL,$4,30,'fleet-test@example.invalid')
    RETURNING id,updated_at::text AS version`, Object.values(value))).rows[0];
}
async function insertAudit(documentId, plate, overrides = {}) {
  const value = { company: "3", documentId, plate, ...overrides };
  await db.query(`
    INSERT INTO public.fleet_tax_edit_audit
     (company_id,document_id,plate_number,actor,before_state,after_state)
    VALUES ($1,$2,$3,'fleet-test@example.invalid','{}'::jsonb,
      '{"action":"asset_registered"}'::jsonb)`, Object.values(value));
}

try {
  await db.exec(fixture);
  await db.exec(await readFile(new URL("../deploy/prod-diva-asset-release-20261118.sql", import.meta.url), "utf8"));
  await db.exec(`
    GRANT SELECT (chassis_number,engine_number) ON public.fleet_units TO ${reader};
    INSERT INTO public.fleet_units (company_id,unit_number,plate_number,brand,model,ownership_type,status)
      VALUES ('3','DVS-BYD-FIXTURE','B1131PNR','BYD','M6','own','registered');
    INSERT INTO public.fleet_documents (company_id,fleet_unit_id,doc_type,expired_date,status)
      SELECT '3',id,'annual_vehicle_tax',DATE '2026-12-12','unpaid'
      FROM public.fleet_units WHERE plate_number='B1131PNR';
    INSERT INTO public.fleet_tax_edit_audit
      (company_id,document_id,plate_number,actor,before_state,after_state)
      SELECT '3',d.id,'B1649PNV','fixture@example.invalid','{}','{"existing":true}'
      FROM public.fleet_documents d JOIN public.fleet_units u ON u.id=d.fleet_unit_id
      WHERE u.plate_number='B1649PNV';
  `);
  const tables = ["fleet_units", "fleet_documents", "fleet_tax_edit_audit", "fleet_vehicles", "fleet_drivers", "fleet_transactions", "fleet_outstanding"];
  const before = Object.fromEntries(await Promise.all(tables.map(async table => [table, await snapshot(table)])));
  const migration = await readFile(new URL("../deploy/prod-diva-asset-create-20261126.sql", import.meta.url), "utf8");

  await check("migration preserves all existing records and is repeatable", async () => {
    await db.exec(migration);
    await db.exec(migration);
    for (const table of tables) assert.deepEqual(await snapshot(table), before[table]);
  });

  await check("exact application readiness SQL confirms INSERT grants, sequences, and unique index", async () => {
    const source = await readFile(new URL("../apps/api/src/lib/fleet-diva-prod-db.ts", import.meta.url), "utf8");
    const readinessFunction = source.split("export async function divaAssetCreateReady")[1];
    const readinessSql = readinessFunction?.match(/p\.query\(`([\s\S]*?)`\)/)?.[1];
    assert.ok(readinessSql, "The actual divaAssetCreateReady SQL must be available");
    const rows = await role(editor, async () => (await db.query(readinessSql)).rows);
    assert.deepEqual(rows, [{
      units_insert: true, documents_insert: true, units_sequence: true,
      documents_sequence: true, unique_plate: true,
    }]);
  });

  await check("reader sees four owned Diva assets and no other-company or rented assets", async () => {
    const rows = await role(reader, async () => (await db.query("SELECT plate_number FROM public.fleet_units ORDER BY plate_number")).rows);
    assert.deepEqual(rows.map(row => row.plate_number), ["B1131PNR", "B1649PNV", "B1650PNV", "B1926PDT"]);
  });
  await check("reader cannot insert or modify an asset", async () => {
    await role(reader, () => rejected("42501", () => insertUnit()));
    await role(reader, () => rejected("42501", () => db.query("UPDATE public.fleet_units SET status='registered'")));
  });

  let registeredUnit;
  let registeredTax;
  await check("editor commits one Company-3 asset, annual-tax record, and matching creation audit", async () => {
    await role(editor, async () => {
      await db.exec("BEGIN");
      try {
        registeredUnit = await insertUnit();
        registeredTax = await insertTax(registeredUnit.id);
        await insertAudit(registeredTax.id, registeredUnit.plate_number);
        await db.exec("COMMIT");
      } catch (error) { await db.exec("ROLLBACK"); throw error; }
    });
    const unit = (await db.query("SELECT company_id,ownership_type,status FROM public.fleet_units WHERE id=$1", [registeredUnit.id])).rows[0];
    assert.deepEqual(unit, { company_id: "3", ownership_type: "own", status: "registered" });
    assert.equal((await db.query("SELECT count(*)::int AS count FROM public.fleet_tax_edit_audit WHERE document_id=$1", [registeredTax.id])).rows[0].count, 1);
    const shown = await role(reader, async () => (await db.query("SELECT plate_number FROM public.fleet_units WHERE plate_number='B9001TST'")).rows);
    assert.equal(shown.length, 1);
  });

  for (const [name, overrides] of [
    ["other company", { company: "1", plate: "B9002TST" }],
    ["rented asset", { ownership: "rent", plate: "B9002TST" }],
    ["nonregistered status", { status: "available", plate: "B9002TST" }],
    ["inactive asset", { active: false, plate: "B9002TST" }],
    ["unnormalized plate", { plate: "b 9002 tst" }],
  ]) {
    await check(`RLS rejects ${name}`, () => role(editor, () => rejected("42501", () => insertUnit(overrides))));
  }
  await check("database prevents duplicate normalized plate, chassis, and engine", async () => {
    await role(editor, () => rejected("23505", () => insertUnit({ chassis: null, engine: null })));
    await role(editor, () => rejected("23505", () => insertUnit({ plate: "B9002TST", chassis: "testvin-000000001", engine: "OTHERENGINE" })));
    await role(editor, () => rejected("23505", () => insertUnit({ plate: "B9002TST", chassis: "OTHERVIN", engine: "testengine-000001" })));
    // Root fixture insertion bypasses RLS to test the index's normalization too.
    await rejected("23505", () => db.query("INSERT INTO public.fleet_units (company_id,unit_number,plate_number) VALUES ('3','TEST-DUPLICATE','b 9001 tst')"));
  });
  await check("missing optional chassis and engine allow multiple distinct assets", async () => {
    await role(editor, async () => {
      await insertUnit({ plate: "B9010TST", unitNumber: "TEST-EMPTY-1", chassis: null, engine: null });
      await insertUnit({ plate: "B9011TST", unitNumber: "TEST-EMPTY-2", chassis: "", engine: "" });
    });
  });
  await check("tax INSERT rejects another company, unrelated unit, and different document type", async () => {
    await role(editor, () => rejected("42501", () => insertTax(registeredUnit.id, { company: "1" })));
    await role(editor, () => rejected("42501", () => insertTax(1)));
    await role(editor, () => rejected("42501", () => insertTax(2)));
    await role(editor, () => rejected("42501", () => insertTax(registeredUnit.id, { type: "ownership_transfer" })));
  });
  await check("audit INSERT requires the actual unit, document, plate, and Company 3 relationship", async () => {
    await role(editor, () => rejected("42501", () => insertAudit(registeredTax.id, "B1649PNV")));
    await role(editor, () => rejected("42501", () => insertAudit(1, "D100AAA")));
    await role(editor, () => rejected("42501", () => insertAudit(registeredTax.id, registeredUnit.plate_number, { company: "1" })));
  });
  await check("failed audit rolls back the new asset and tax document", async () => {
    const countsBefore = (await db.query("SELECT (SELECT count(*) FROM public.fleet_units) units,(SELECT count(*) FROM public.fleet_documents) documents,(SELECT count(*) FROM public.fleet_tax_edit_audit) audits")).rows[0];
    await role(editor, async () => {
      await db.exec("BEGIN");
      try {
        const unit = await insertUnit({ plate: "B9020TST", chassis: null, engine: null });
        const tax = await insertTax(unit.id);
        await rejected("42501", () => insertAudit(tax.id, "B9001TST"));
      } finally { await db.exec("ROLLBACK"); }
    });
    assert.deepEqual((await db.query("SELECT (SELECT count(*) FROM public.fleet_units) units,(SELECT count(*) FROM public.fleet_documents) documents,(SELECT count(*) FROM public.fleet_tax_edit_audit) audits")).rows[0], countsBefore);
  });
  await check("new vehicle tax can be updated with optimistic version and audited", async () => {
    await role(editor, async () => {
      const updated = await db.query("UPDATE public.fleet_documents SET expired_date='2027-12-12',status='unpaid',updated_at=now() WHERE id=$1 AND company_id='3' AND updated_at=$2::timestamptz RETURNING id", [registeredTax.id, registeredTax.version]);
      assert.equal(updated.rows.length, 1);
      await insertAudit(registeredTax.id, registeredUnit.plate_number);
      const stale = await db.query("UPDATE public.fleet_documents SET expired_date='2028-12-12' WHERE id=$1 AND updated_at=$2::timestamptz RETURNING id", [registeredTax.id, registeredTax.version]);
      assert.equal(stale.rows.length, 0);
    });
  });
  await check("editor still cannot change asset rows, attachments, audit history, or operational data", async () => {
    await role(editor, async () => {
      for (const sql of [
        "UPDATE public.fleet_units SET status='available'",
        "DELETE FROM public.fleet_units",
        "DELETE FROM public.fleet_documents",
        "UPDATE public.fleet_documents SET file_url='test'",
        "UPDATE public.fleet_tax_edit_audit SET actor='test'",
        "DELETE FROM public.fleet_tax_edit_audit",
        "INSERT INTO public.fleet_vehicles (company_id) VALUES (3)",
        "UPDATE public.fleet_drivers SET evidence='changed'",
        "UPDATE public.fleet_transactions SET evidence='changed'",
        "DELETE FROM public.fleet_outstanding",
      ]) await rejected("42501", () => db.query(sql));
    });
  });
  await check("all preexisting asset, tax, audit, and operational rows remain unchanged", async () => {
    for (const table of tables) {
      const maxId = Math.max(0, ...before[table].map(row => row.id));
      assert.deepEqual(await snapshot(table, maxId), before[table]);
    }
  });
  console.log(JSON.stringify({ status: "PASS", checks: checks.length, engine: (await db.query("SELECT version() AS version")).rows[0].version, productionWrites: 0 }));
} finally {
  await db.close();
}
