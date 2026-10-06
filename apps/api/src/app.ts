import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app = express();
const isProduction = process.env.APP_ENV === "production" || process.env.NODE_ENV === "production";
const appOrigin = String(process.env.APP_BASE_URL || "https://fleet.cstlogistic.co.id").replace(/\/$/, "");

app.disable("x-powered-by");
app.use(pinoHttp({ logger }));
app.use(cors({
  origin: isProduction ? appOrigin : true,
  credentials: true,
}));
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: false, limit: "15mb" }));
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "fleet-intelligence" });
});

app.use("/api", router);

if (isProduction) {
  const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.resolve(runtimeDir, "public");
  app.use(express.static(publicDir, { index: false, maxAge: "1h" }));
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

export default app;
