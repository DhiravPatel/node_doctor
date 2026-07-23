/**
 * CI/CD pipeline text diagnostics (GitHub Actions). These are the live
 * supply-chain and privilege-escalation footguns: a workflow runs with the
 * repository's token and secrets, so an injection here is not a bug in the app —
 * it is a compromise of the pipeline that ships the app.
 */

import type { TextDiagnostic } from "../../core/text-scan.ts";
import { ciScriptInjection } from "./ci-script-injection.ts";
import { ciUnpinnedAction } from "./ci-unpinned-action.ts";
import { ciPullRequestTargetCheckout } from "./ci-pull-request-target-checkout.ts";

export const CICD_DIAGNOSTICS: TextDiagnostic[] = [
  ciPullRequestTargetCheckout,
  ciScriptInjection,
  ciUnpinnedAction,
];

export { ciScriptInjection, ciUnpinnedAction, ciPullRequestTargetCheckout };
