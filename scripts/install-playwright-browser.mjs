import { execFileSync } from "node:child_process";

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const env = {
  ...process.env,
  PLAYWRIGHT_BROWSERS_PATH: "0",
};

console.log("Installing Playwright Chromium into node_modules for Hostinger runtime...");
execFileSync(npx, ["playwright", "install", "chromium"], {
  stdio: "inherit",
  env,
});
console.log("Playwright Chromium bundled successfully.");
