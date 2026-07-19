import fs from "node:fs";

// Fail fast at boot instead of degrading with a hardcoded fallback.
if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is required");
}

export const JWT_SECRET = process.env.JWT_SECRET;

// Non-secret vars may have sensible defaults.
export const PORT = process.env.PORT || "3000";

// Sync read at MODULE SCOPE is a correct one-time boot cost, not a request-path stall.
export const config = JSON.parse(
  fs.readFileSync(new URL("../config.json", import.meta.url), "utf8"),
);
