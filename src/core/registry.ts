// ---------------------------------------------------------------------------
// GENERATED FILE — do not edit by hand.
// Regenerate with `npm run gen:registry` (scripts/gen-registry.ts).
// The generator scans src/diagnostics/<bucket>/*.ts, imports each diagnostic export, and
// emits this list, sorted by bucket then diagnostic id.
// ---------------------------------------------------------------------------

import type { Diagnostic } from "./types.ts";

// async
import { noAsyncArrayCallback } from "../diagnostics/async/no-async-array-callback.ts";
import { noAsyncExecutor } from "../diagnostics/async/no-async-executor.ts";
import { noAwaitInLoopOverIndependentWork } from "../diagnostics/async/no-await-in-loop-over-independent-work.ts";
import { noMissingCatchOnAsyncIife } from "../diagnostics/async/no-missing-catch-on-async-iife.ts";
import { noRaceWithoutTimeout } from "../diagnostics/async/no-race-without-timeout.ts";
import { noSwallowedErrorEmptyCatch } from "../diagnostics/async/no-swallowed-error-empty-catch.ts";
import { noUnboundedPromiseAll } from "../diagnostics/async/no-unbounded-promise-all.ts";
import { requireFetchTimeout } from "../diagnostics/async/require-fetch-timeout.ts";
// db
import { noDbConnectionPerRequest } from "../diagnostics/db/no-db-connection-per-request.ts";
import { noExternalCallInsideOpenTransaction } from "../diagnostics/db/no-external-call-inside-open-transaction.ts";
import { noFindmanyThenFilterInJs } from "../diagnostics/db/no-findmany-then-filter-in-js.ts";
import { noMissingAwaitOnQuery } from "../diagnostics/db/no-missing-await-on-query.ts";
import { noQueryInLoop } from "../diagnostics/db/no-query-in-loop.ts";
// event-loop
import { noLargeJsonParseInRequestPath } from "../diagnostics/event-loop/no-large-json-parse-in-request-path.ts";
import { noProcessExitInRequestPath } from "../diagnostics/event-loop/no-process-exit-in-request-path.ts";
import { noRedosProneRegex } from "../diagnostics/event-loop/no-redos-prone-regex.ts";
import { noSyncBcryptInRequestPath } from "../diagnostics/event-loop/no-sync-bcrypt-in-request-path.ts";
import { noSyncIoInRequestPath } from "../diagnostics/event-loop/no-sync-io-in-request-path.ts";
import { noSyncIoReachableFromHandler } from "../diagnostics/event-loop/no-sync-io-reachable-from-handler.ts";
import { requirePaginationLimit } from "../diagnostics/event-loop/require-pagination-limit.ts";
// http
import { corsCredentialsReflect } from "../diagnostics/http/cors-credentials-reflect.ts";
import { expressAsyncHandlerUnprotected } from "../diagnostics/http/express-async-handler-unprotected.ts";
import { expressMissingReturnAfterResponse } from "../diagnostics/http/express-missing-return-after-response.ts";
import { fastifyMissingSchema } from "../diagnostics/http/fastify-missing-schema.ts";
import { nestMissingValidationPipe } from "../diagnostics/http/nest-missing-validation-pipe.ts";
import { noMissingBodySizeLimit } from "../diagnostics/http/no-missing-body-size-limit.ts";
import { noSendAfterNext } from "../diagnostics/http/no-send-after-next.ts";
import { noTrustProxyTrue } from "../diagnostics/http/no-trust-proxy-true.ts";
import { requireErrorHandlingMiddleware } from "../diagnostics/http/require-error-handling-middleware.ts";
// maintainability
import { noConsoleLogInCommittedCode } from "../diagnostics/maintainability/no-console-log-in-committed-code.ts";
import { noDeadAsync } from "../diagnostics/maintainability/no-dead-async.ts";
import { noDuplicateRouteDefinition } from "../diagnostics/maintainability/no-duplicate-route-definition.ts";
import { noRedundantTryCatchRethrow } from "../diagnostics/maintainability/no-redundant-try-catch-rethrow.ts";
import { preferNodeProtocolImports } from "../diagnostics/maintainability/prefer-node-protocol-imports.ts";
// reliability
import { noInfiniteRetryWithoutBackoff } from "../diagnostics/reliability/no-infinite-retry-without-backoff.ts";
import { noListenerAddedPerRequest } from "../diagnostics/reliability/no-listener-added-per-request.ts";
import { noMissingStreamErrorHandler } from "../diagnostics/reliability/no-missing-stream-error-handler.ts";
import { noThrowInFinally } from "../diagnostics/reliability/no-throw-in-finally.ts";
import { noUnboundedModuleCache } from "../diagnostics/reliability/no-unbounded-module-cache.ts";
import { noUnclearedModuleInterval } from "../diagnostics/reliability/no-uncleared-module-interval.ts";
import { requireSigtermHandler } from "../diagnostics/reliability/require-sigterm-handler.ts";
// security
import { noDisabledTlsVerification } from "../diagnostics/security/no-disabled-tls-verification.ts";
import { noEvalWithInput } from "../diagnostics/security/no-eval-with-input.ts";
import { noExecWithInterpolation } from "../diagnostics/security/no-exec-with-interpolation.ts";
import { noFunctionConstructorWithInput } from "../diagnostics/security/no-function-constructor-with-input.ts";
import { noHardcodedSecretLiteral } from "../diagnostics/security/no-hardcoded-secret-literal.ts";
import { noJwtDecodeAsVerify } from "../diagnostics/security/no-jwt-decode-as-verify.ts";
import { noJwtNoneAlgorithm } from "../diagnostics/security/no-jwt-none-algorithm.ts";
import { noMathRandomForToken } from "../diagnostics/security/no-math-random-for-token.ts";
import { noNosqlObjectInjection } from "../diagnostics/security/no-nosql-object-injection.ts";
import { noOpenRedirect } from "../diagnostics/security/no-open-redirect.ts";
import { noPathTraversal } from "../diagnostics/security/no-path-traversal.ts";
import { noSqlTemplateInterpolation } from "../diagnostics/security/no-sql-template-interpolation.ts";
import { noSsrfUnvalidatedUrl } from "../diagnostics/security/no-ssrf-unvalidated-url.ts";
import { noTimingUnsafeSecretCompare } from "../diagnostics/security/no-timing-unsafe-secret-compare.ts";
import { noUnsafeRegexpFromInput } from "../diagnostics/security/no-unsafe-regexp-from-input.ts";
import { noVmRunUntrusted } from "../diagnostics/security/no-vm-run-untrusted.ts";
import { noWeakCipher } from "../diagnostics/security/no-weak-cipher.ts";
import { noWeakHashForPassword } from "../diagnostics/security/no-weak-hash-for-password.ts";
import { requireJwtAlgorithmsAllowlist } from "../diagnostics/security/require-jwt-algorithms-allowlist.ts";
import { requireSecureCookieFlags } from "../diagnostics/security/require-secure-cookie-flags.ts";
import { secretInEnvFallback } from "../diagnostics/security/secret-in-env-fallback.ts";

/** Every diagnostic known to node.doctor, in a stable declaration order. */
export const DIAGNOSTICS: Diagnostic[] = [
  // async
  noAsyncArrayCallback,
  noAsyncExecutor,
  noAwaitInLoopOverIndependentWork,
  noMissingCatchOnAsyncIife,
  noRaceWithoutTimeout,
  noSwallowedErrorEmptyCatch,
  noUnboundedPromiseAll,
  requireFetchTimeout,
  // db
  noDbConnectionPerRequest,
  noExternalCallInsideOpenTransaction,
  noFindmanyThenFilterInJs,
  noMissingAwaitOnQuery,
  noQueryInLoop,
  // event-loop
  noLargeJsonParseInRequestPath,
  noProcessExitInRequestPath,
  noRedosProneRegex,
  noSyncBcryptInRequestPath,
  noSyncIoInRequestPath,
  noSyncIoReachableFromHandler,
  requirePaginationLimit,
  // http
  corsCredentialsReflect,
  expressAsyncHandlerUnprotected,
  expressMissingReturnAfterResponse,
  fastifyMissingSchema,
  nestMissingValidationPipe,
  noMissingBodySizeLimit,
  noSendAfterNext,
  noTrustProxyTrue,
  requireErrorHandlingMiddleware,
  // maintainability
  noConsoleLogInCommittedCode,
  noDeadAsync,
  noDuplicateRouteDefinition,
  noRedundantTryCatchRethrow,
  preferNodeProtocolImports,
  // reliability
  noInfiniteRetryWithoutBackoff,
  noListenerAddedPerRequest,
  noMissingStreamErrorHandler,
  noThrowInFinally,
  noUnboundedModuleCache,
  noUnclearedModuleInterval,
  requireSigtermHandler,
  // security
  noDisabledTlsVerification,
  noEvalWithInput,
  noExecWithInterpolation,
  noFunctionConstructorWithInput,
  noHardcodedSecretLiteral,
  noJwtDecodeAsVerify,
  noJwtNoneAlgorithm,
  noMathRandomForToken,
  noNosqlObjectInjection,
  noOpenRedirect,
  noPathTraversal,
  noSqlTemplateInterpolation,
  noSsrfUnvalidatedUrl,
  noTimingUnsafeSecretCompare,
  noUnsafeRegexpFromInput,
  noVmRunUntrusted,
  noWeakCipher,
  noWeakHashForPassword,
  requireJwtAlgorithmsAllowlist,
  requireSecureCookieFlags,
  secretInEnvFallback,
];

/** Diagnostic id → diagnostic, for catalogs, config UIs, and lookups. */
export const DIAGNOSTICS_BY_ID: Map<string, Diagnostic> = new Map(DIAGNOSTICS.map((diagnostic) => [diagnostic.id, diagnostic]));
