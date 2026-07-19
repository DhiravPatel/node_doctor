import fs from "node:fs";

export function warm() {
  return deepWarm();
}

// Two hops from the handler (handler → warm → deepWarm): the sync read here is
// on the request path and must be flagged.
function deepWarm() {
  return fs.readFileSync("./cache.json", "utf8");
}
