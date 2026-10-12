import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Vite emits this event when an old open tab requests an asset removed by a deploy.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  const marker = "fleet:asset-reload";
  const now = Date.now();
  try {
    const previous = Number(sessionStorage.getItem(marker) ?? "0");
    if (now - previous < 60_000) return; // prevent reload loops
    sessionStorage.setItem(marker, String(now));
  } catch {
    // Reload even when storage is disabled.
  }
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
