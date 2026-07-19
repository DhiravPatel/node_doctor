export function helper() {
  return "ok";
}

// Exported but never imported anywhere → an unused export.
export function unusedHelper() {
  return "dead";
}
