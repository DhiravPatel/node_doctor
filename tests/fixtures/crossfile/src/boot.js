import fs from "node:fs";

// The SAME kind of sync read — but bootOnly is only ever called at module scope
// (a one-time boot cost), never from a request handler. It must stay SILENT.
export function bootOnly() {
  return fs.readFileSync("./seed.json", "utf8");
}

bootOnly();
