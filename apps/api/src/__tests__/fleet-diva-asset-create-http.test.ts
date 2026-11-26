import { once } from "node:events";
import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: undefined as Record<string, unknown> | undefined,
  create: vi.fn(),
  ready: vi.fn(),
  read: vi.fn(),
  operational: vi.fn(),
  ServiceError: class extends Error {
    constructor(message: string, public status = 400) { super(message); }
  },
}));

vi.mock("../lib/db", () => ({ pool: { query: state.operational } }));
vi.mock("../routes/admin-auth", () => ({
  authenticateAdmin: (req: Request, res: Response, next: NextFunction) => {
    if (!state.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    Object.assign(req, { adminUser: state.user });
    next();
  },
}));
vi.mock("../lib/fleet-diva-prod-db", () => ({
  divaAssetReadPool: { query: state.read },
  divaTaxWriterPool: { connect: vi.fn() },
  divaAssetReadEnabled: () => process.env.APP_ENV === "production" &&
    process.env.APP_BASE_URL === "https://fleet.cstlogistic.co.id" &&
    process.env.FLEET_DIVA_ASSET_READ_ENABLED_PROD === "true",
  divaTaxWriterEnabled: () => process.env.APP_ENV === "production" &&
    process.env.FLEET_DIVA_ASSET_READ_ENABLED_PROD === "true" &&
    process.env.FLEET_DIVA_TAX_EDIT_ENABLED_PROD === "true",
  divaAssetCreateReady: state.ready,
}));
vi.mock("../lib/fleet-diva-asset-create", () => ({
  createDivaAsset: state.create,
  DivaAssetCreateError: state.ServiceError,
}));

import router from "../routes/fleet-intelligence";

const originalEnv = { ...process.env };
let server: Server;
let baseUrl: string;
const payload = { plate: "B9876XYZ", brand: "Wuling", model: "Cloud EV", chassisNumber: "LSV11223344556677", engineNumber: "ENG9876XYZ" };
const user = (role = "super_admin", email = "owner@example.test", companyId = 1) => ({
  id: "authenticated-fixture", role, email, companyId, firstName: null, lastName: null,
});

beforeAll(async () => {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { log: { error: vi.fn() } });
    next();
  });
  app.use("/api/logistics/fleet", router);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test HTTP listener failed");
  baseUrl = `http://127.0.0.1:${address.port}/api/logistics/fleet/vehicles/diva-assets`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

beforeEach(() => {
  process.env = {
    ...originalEnv,
    APP_ENV: "production",
    APP_BASE_URL: "https://fleet.cstlogistic.co.id",
    FLEET_DIVA_ASSET_READ_ENABLED_PROD: "true",
    FLEET_DIVA_TAX_EDIT_ENABLED_PROD: "true",
    FLEET_DIVA_TAX_DATABASE_URL_PROD: "synthetic-test-only",
    FLEET_DIVA_TAX_STAFF_EMAILS_PROD: "assigned@example.test",
  };
  state.user = user();
  state.create.mockReset().mockResolvedValue({ ok: true, companyId: 3, plate: payload.plate, asset: { id: 101, plate_number: payload.plate }, tax: { id: 201, version: "2026-11-26T08:00:00Z" } });
  state.ready.mockReset().mockResolvedValue(true);
  state.read.mockReset().mockResolvedValue({ rows: [{ plate_number: payload.plate, brand: payload.brand, model: payload.model }] });
  state.operational.mockReset();
});

afterEach(() => { process.env = { ...originalEnv }; });

async function request(options: {
  method?: string;
  origin?: string | null;
  hostname?: string;
  protocol?: string;
  body?: Record<string, unknown>;
} = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Forwarded-Host": options.hostname ?? "fleet.cstlogistic.co.id",
    "X-Forwarded-Proto": options.protocol ?? "https",
  };
  if (options.origin !== null) headers.Origin = options.origin ?? "https://fleet.cstlogistic.co.id";
  return fetch(baseUrl, {
    method: options.method ?? "POST",
    headers,
    ...(options.method === "GET" ? {} : { body: JSON.stringify(options.body ?? payload) }),
  });
}

describe("Diva asset creation HTTP boundary", () => {
  it("saves through the Diva service using the authenticated admin's identity", async () => {
    const response = await request({ body: { ...payload, createdBy: "forged@example.test" } });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true, companyId: 3, plate: payload.plate });
    expect(state.create).toHaveBeenCalledWith({ ...payload, createdBy: "forged@example.test" }, "owner@example.test");
    expect(state.operational).not.toHaveBeenCalled();
  });

  it("allows an explicitly assigned existing Fleet admin", async () => {
    state.user = user("admin", "assigned@example.test", 4);
    expect((await request()).status).toBe(201);
    expect(state.create).toHaveBeenCalledWith(payload, "assigned@example.test");
  });

  it("denies anonymous requests before storage or capability checks", async () => {
    state.user = undefined;
    expect((await request()).status).toBe(401);
    expect(state.ready).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it.each([
    user("admin", "unassigned@example.test", 1),
    user("finance", "assigned@example.test", 1),
    user("super_admin", "other-owner@example.test", 4),
    user("admin", "assigned@example.test", 99),
  ])("denies accounts without the Diva delegation: %j", async account => {
    state.user = account;
    expect((await request()).status).toBe(403);
    expect(state.ready).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it.each([
    { origin: null },
    { origin: "https://another.example.test" },
    { hostname: "another.example.test" },
    { protocol: "http" },
  ])("denies a request with an invalid origin or transport: %j", async options => {
    expect((await request(options)).status).toBe(403);
    expect(state.create).not.toHaveBeenCalled();
  });

  it.each([
    { APP_ENV: "development" },
    { FLEET_DIVA_ASSET_READ_ENABLED_PROD: "false" },
    { FLEET_DIVA_TAX_EDIT_ENABLED_PROD: "false" },
  ])("does not write while the existing Diva feature is disabled: %j", async values => {
    Object.assign(process.env, values);
    expect((await request()).status).toBe(403);
    expect(state.create).not.toHaveBeenCalled();
  });

  it("returns unavailable without calling storage when the asset schema is not ready", async () => {
    state.ready.mockResolvedValue(false);
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toHaveProperty("error");
    expect(state.create).not.toHaveBeenCalled();
  });

  it("preserves the service's conflict response for a duplicate vehicle", async () => {
    state.create.mockRejectedValue(new state.ServiceError("Nomor polisi sudah terdaftar.", 409));
    const response = await request();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Nomor polisi sudah terdaftar." });
  });

  it("returns validation errors without reporting a successful save", async () => {
    state.create.mockRejectedValue(new state.ServiceError("Nomor rangka wajib diisi.", 400));
    const response = await request();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Nomor rangka wajib diisi." });
  });

  it("does not expose connection details on an unexpected database failure", async () => {
    state.create.mockRejectedValue(new Error("postgresql://secret-user:secret-password@private-host/database"));
    const response = await request();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toHaveProperty("error");
    expect(JSON.stringify(body)).not.toMatch(/secret-user|secret-password|private-host|postgresql/);
  });

  it("returns creation availability with the asset list for the form", async () => {
    state.ready.mockResolvedValue(false);
    const response = await request({ method: "GET" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ companyId: 3, companyName: "PT Diva Servis", assetCreateEnabled: false, assets: [{ plate_number: payload.plate }] });
    expect(state.create).not.toHaveBeenCalled();
  });
});
