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
app.set("trust proxy", 1);

if (isProduction) {
  app.use((req, res, next) => {
    const forwardedProto = String(req.get("x-forwarded-proto") ?? "").split(",")[0]?.trim().toLowerCase();
    const isHttps = req.secure || forwardedProto === "https";
    if (!isHttps) {
      const host = req.get("host") || "fleet.cstlogistic.co.id";
      res.redirect(308, `https://${host}${req.originalUrl}`);
      return;
    }
    next();
  });
}
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
  // Fingerprinted assets are immutable; HTML must not stay cached across deploys.
  app.use("/assets", express.static(path.join(publicDir, "assets"), {
    index: false, immutable: true, maxAge: "1y", fallthrough: false,
  }));
  app.use(express.static(publicDir, { index: false, maxAge: 0, setHeaders(res, filePath) {
    if (filePath.endsWith(".html") || filePath.endsWith("deploy-version.json")) {
      res.setHeader("Cache-Control", "no-store");
    }
  } }));
  // Missing JS/CSS/images must never receive the SPA HTML fallback.
  app.get(/^\/(?:assets\/.*|.*\.(?:js|mjs|css|map|wasm|json|png|jpe?g|svg|ico|webp|woff2?|ttf))$/i, (_req, res) => {
    res.status(404).type("text/plain").send("Asset not found");
  });
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

export default app;
