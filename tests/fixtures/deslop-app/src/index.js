import pc from "picocolors";
import { helper } from "./helper.js";

// picocolors + helper are used; left-pad and unusedHelper and orphan.js are not.
export function main() {
  return pc.green(helper());
}
