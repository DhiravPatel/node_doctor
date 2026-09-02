// ---------------------------------------------------------------------------
// GENERATED FILE — do not edit by hand.
// Regenerate with `npm run gen:registry` (scripts/gen-registry.ts).
// The generator scans src/diagnostics/<bucket>/*.ts, imports each diagnostic export, and
// emits this list, sorted by bucket then diagnostic id.
// ---------------------------------------------------------------------------

import type { Diagnostic } from "./types.ts";

// ai
import { aiCallInLoop } from "../diagnostics/ai/ai-call-in-loop.ts";
import { mcpToolUnrestrictedCapability } from "../diagnostics/ai/mcp-tool-unrestricted-capability.ts";
import { noLlmOutputInSink } from "../diagnostics/ai/no-llm-output-in-sink.ts";
import { noPromptInjection } from "../diagnostics/ai/no-prompt-injection.ts";
import { noSystemPromptLeak } from "../diagnostics/ai/no-system-prompt-leak.ts";
import { noUnboundedAgentLoop } from "../diagnostics/ai/no-unbounded-agent-loop.ts";
import { noUnguardedLlmJsonParse } from "../diagnostics/ai/no-unguarded-llm-json-parse.ts";
import { requireLlmTokenLimit } from "../diagnostics/ai/require-llm-token-limit.ts";
// api
import { graphqlIntrospectionInProduction } from "../diagnostics/api/graphql-introspection-in-production.ts";
import { graphqlMissingDepthLimit } from "../diagnostics/api/graphql-missing-depth-limit.ts";
import { graphqlResolverReturnsRawError } from "../diagnostics/api/graphql-resolver-returns-raw-error.ts";
import { grpcInsecureCredentials } from "../diagnostics/api/grpc-insecure-credentials.ts";
// async
import { noAsyncArrayCallback } from "../diagnostics/async/no-async-array-callback.ts";
import { noAsyncExecutor } from "../diagnostics/async/no-async-executor.ts";
import { noAwaitInLoopOverIndependentWork } from "../diagnostics/async/no-await-in-loop-over-independent-work.ts";
import { noDetachedChildWithoutUnref } from "../diagnostics/async/no-detached-child-without-unref.ts";
import { noMissingCatchOnAsyncIife } from "../diagnostics/async/no-missing-catch-on-async-iife.ts";
import { noRaceWithoutTimeout } from "../diagnostics/async/no-race-without-timeout.ts";
import { noSwallowedErrorEmptyCatch } from "../diagnostics/async/no-swallowed-error-empty-catch.ts";
import { noUnboundedPromiseAll } from "../diagnostics/async/no-unbounded-promise-all.ts";
import { noUnclonableWorkerMessage } from "../diagnostics/async/no-unclonable-worker-message.ts";
import { requireFetchTimeout } from "../diagnostics/async/require-fetch-timeout.ts";
// bugs
import { noBigintPrecisionLoss } from "../diagnostics/bugs/no-bigint-precision-loss.ts";
import { noBrokenSortComparator } from "../diagnostics/bugs/no-broken-sort-comparator.ts";
import { noChunkStringConcat } from "../diagnostics/bugs/no-chunk-string-concat.ts";
import { noConstantCondition } from "../diagnostics/bugs/no-constant-condition.ts";
import { noDirnameInEsm } from "../diagnostics/bugs/no-dirname-in-esm.ts";
import { noFloatingPromiseInTry } from "../diagnostics/bugs/no-floating-promise-in-try.ts";
import { noLocalDateAsIsoDatestring } from "../diagnostics/bugs/no-local-date-as-iso-datestring.ts";
import { noNamespaceObjectWrite } from "../diagnostics/bugs/no-namespace-object-write.ts";
import { noNanComparison } from "../diagnostics/bugs/no-nan-comparison.ts";
import { noOutOfRangeExitCode } from "../diagnostics/bugs/no-out-of-range-exit-code.ts";
import { noOversizedTimerDelay } from "../diagnostics/bugs/no-oversized-timer-delay.ts";
import { noShadowedRoute } from "../diagnostics/bugs/no-shadowed-route.ts";
import { noSparseArrayIteration } from "../diagnostics/bugs/no-sparse-array-iteration.ts";
import { noStringLengthAsContentLength } from "../diagnostics/bugs/no-string-length-as-content-length.ts";
import { noThrowLiteral } from "../diagnostics/bugs/no-throw-literal.ts";
import { noTofixedAsNumber } from "../diagnostics/bugs/no-tofixed-as-number.ts";
import { noUnclampedMonthShift } from "../diagnostics/bugs/no-unclamped-month-shift.ts";
import { noUnreachableCleanupAfterExit } from "../diagnostics/bugs/no-unreachable-cleanup-after-exit.ts";
import { noUnreachableCode } from "../diagnostics/bugs/no-unreachable-code.ts";
import { noUnstableOffsetPagination } from "../diagnostics/bugs/no-unstable-offset-pagination.ts";
import { noUrlAsFilesystemPath } from "../diagnostics/bugs/no-url-as-filesystem-path.ts";
// config
import { noNonNullEnvAccess } from "../diagnostics/config/no-nonnull-env-access.ts";
// db
import { noDbConnectionPerRequest } from "../diagnostics/db/no-db-connection-per-request.ts";
import { noExternalCallInsideOpenTransaction } from "../diagnostics/db/no-external-call-inside-open-transaction.ts";
import { noFindmanyThenFilterInJs } from "../diagnostics/db/no-findmany-then-filter-in-js.ts";
import { noMissingAwaitOnQuery } from "../diagnostics/db/no-missing-await-on-query.ts";
import { noQueryInLoop } from "../diagnostics/db/no-query-in-loop.ts";
import { noUntransactedDependentWrites } from "../diagnostics/db/no-untransacted-dependent-writes.ts";
// event-loop
import { noLargeJsonParseInRequestPath } from "../diagnostics/event-loop/no-large-json-parse-in-request-path.ts";
import { noProcessExitInRequestPath } from "../diagnostics/event-loop/no-process-exit-in-request-path.ts";
import { noRedosProneRegex } from "../diagnostics/event-loop/no-redos-prone-regex.ts";
import { noSyncBcryptInRequestPath } from "../diagnostics/event-loop/no-sync-bcrypt-in-request-path.ts";
import { noSyncIoInRequestPath } from "../diagnostics/event-loop/no-sync-io-in-request-path.ts";
import { noSyncIoReachableFromHandler } from "../diagnostics/event-loop/no-sync-io-reachable-from-handler.ts";
import { requirePaginationLimit } from "../diagnostics/event-loop/require-pagination-limit.ts";
// frameworks
import { hapiRouteAuthDisabled } from "../diagnostics/frameworks/hapi-route-auth-disabled.ts";
import { hapiRouteMissingValidation } from "../diagnostics/frameworks/hapi-route-missing-validation.ts";
import { noHonoExactPathMiddleware } from "../diagnostics/frameworks/no-hono-exact-path-middleware.ts";
import { noNestResWithoutSend } from "../diagnostics/frameworks/no-nest-res-without-send.ts";
import { noPeerInconsistentHandler } from "../diagnostics/frameworks/no-peer-inconsistent-handler.ts";
import { noUnawaitedAdonisAuthCheck } from "../diagnostics/frameworks/no-unawaited-adonis-auth-check.ts";
import { noUnawaitedAdonisValidation } from "../diagnostics/frameworks/no-unawaited-adonis-validation.ts";
import { noUnawaitedHonoBody } from "../diagnostics/frameworks/no-unawaited-hono-body.ts";
import { noUnawaitedKoaNext } from "../diagnostics/frameworks/no-unawaited-koa-next.ts";
import { noUnawaitedNextDynamicApi } from "../diagnostics/frameworks/no-unawaited-next-dynamic-api.ts";
import { noUnreturnedHonoResponse } from "../diagnostics/frameworks/no-unreturned-hono-response.ts";
import { restifyMissingErrorHandler } from "../diagnostics/frameworks/restify-missing-error-handler.ts";
// http
import { corsCredentialsReflect } from "../diagnostics/http/cors-credentials-reflect.ts";
import { expressAsyncHandlerUnprotected } from "../diagnostics/http/express-async-handler-unprotected.ts";
import { expressMissingReturnAfterResponse } from "../diagnostics/http/express-missing-return-after-response.ts";
import { fastifyMissingSchema } from "../diagnostics/http/fastify-missing-schema.ts";
import { nestMissingValidationPipe } from "../diagnostics/http/nest-missing-validation-pipe.ts";
import { noBodyOnBodilessStatus } from "../diagnostics/http/no-body-on-bodiless-status.ts";
import { noErrorResponseWithSuccessStatus } from "../diagnostics/http/no-error-response-with-success-status.ts";
import { noExpress4RemovedApi } from "../diagnostics/http/no-express4-removed-api.ts";
import { noMissingBodySizeLimit } from "../diagnostics/http/no-missing-body-size-limit.ts";
import { noNestedQueryOnSimpleParser } from "../diagnostics/http/no-nested-query-on-simple-parser.ts";
import { noSendAfterNext } from "../diagnostics/http/no-send-after-next.ts";
import { noSharedCacheAuthenticatedResponse } from "../diagnostics/http/no-shared-cache-authenticated-response.ts";
import { noStatusCodeAsResponseBody } from "../diagnostics/http/no-status-code-as-response-body.ts";
import { noTrustProxyTrue } from "../diagnostics/http/no-trust-proxy-true.ts";
import { noWildcardBodyParser } from "../diagnostics/http/no-wildcard-body-parser.ts";
import { requireErrorHandlingMiddleware } from "../diagnostics/http/require-error-handling-middleware.ts";
// maintainability
import { deepNesting } from "../diagnostics/maintainability/deep-nesting.ts";
import { highCyclomaticComplexity } from "../diagnostics/maintainability/high-cyclomatic-complexity.ts";
import { jsdocParamMismatch } from "../diagnostics/maintainability/jsdoc-param-mismatch.ts";
import { maxFunctionLength } from "../diagnostics/maintainability/max-function-length.ts";
import { noAssertionFreeTest } from "../diagnostics/maintainability/no-assertion-free-test.ts";
import { noCircularImports } from "../diagnostics/maintainability/no-circular-imports.ts";
import { noConsoleLogInCommittedCode } from "../diagnostics/maintainability/no-console-log-in-committed-code.ts";
import { noDeadAsync } from "../diagnostics/maintainability/no-dead-async.ts";
import { noDuplicateRouteDefinition } from "../diagnostics/maintainability/no-duplicate-route-definition.ts";
import { noFlakyTestPattern } from "../diagnostics/maintainability/no-flaky-test-pattern.ts";
import { noMockOfMissingExport } from "../diagnostics/maintainability/no-mock-of-missing-export.ts";
import { noRedundantTryCatchRethrow } from "../diagnostics/maintainability/no-redundant-try-catch-rethrow.ts";
import { noTautologicalMockAssertion } from "../diagnostics/maintainability/no-tautological-mock-assertion.ts";
import { noUnimplementedStub } from "../diagnostics/maintainability/no-unimplemented-stub.ts";
import { preferNodeProtocolImports } from "../diagnostics/maintainability/prefer-node-protocol-imports.ts";
// modernization
import { noDeprecatedNodeApi } from "../diagnostics/modernization/no-deprecated-node-api.ts";
import { noNodeBuiltinOnEdge } from "../diagnostics/modernization/no-node-builtin-on-edge.ts";
// performance
import { noSequentialIndependentAwaits } from "../diagnostics/performance/no-sequential-independent-awaits.ts";
// reliability
import { noCacheWithoutTtl } from "../diagnostics/reliability/no-cache-without-ttl.ts";
import { noCrossRequestStateMutation } from "../diagnostics/reliability/no-cross-request-state-mutation.ts";
import { noDroppedAbortSignal } from "../diagnostics/reliability/no-dropped-abort-signal.ts";
import { noErrorCauseDiscarded } from "../diagnostics/reliability/no-error-cause-discarded.ts";
import { noInfiniteRetryWithoutBackoff } from "../diagnostics/reliability/no-infinite-retry-without-backoff.ts";
import { noInvalidCronExpression } from "../diagnostics/reliability/no-invalid-cron-expression.ts";
import { noInvertedTimeoutBudget } from "../diagnostics/reliability/no-inverted-timeout-budget.ts";
import { noListenerAddedPerRequest } from "../diagnostics/reliability/no-listener-added-per-request.ts";
import { noLiteralListenerRemoval } from "../diagnostics/reliability/no-literal-listener-removal.ts";
import { noLivenessCheckWithDependency } from "../diagnostics/reliability/no-liveness-check-with-dependency.ts";
import { noLostAsyncContext } from "../diagnostics/reliability/no-lost-async-context.ts";
import { noMissingStreamErrorHandler } from "../diagnostics/reliability/no-missing-stream-error-handler.ts";
import { noMissingWebsocketErrorHandler } from "../diagnostics/reliability/no-missing-websocket-error-handler.ts";
import { noRetryAmplification } from "../diagnostics/reliability/no-retry-amplification.ts";
import { noThrowInFinally } from "../diagnostics/reliability/no-throw-in-finally.ts";
import { noUnboundedModuleCache } from "../diagnostics/reliability/no-unbounded-module-cache.ts";
import { noUncatchableSignalHandler } from "../diagnostics/reliability/no-uncatchable-signal-handler.ts";
import { noUnclearedModuleInterval } from "../diagnostics/reliability/no-uncleared-module-interval.ts";
import { noUnhandledPipeError } from "../diagnostics/reliability/no-unhandled-pipe-error.ts";
import { noUnreleasedResource } from "../diagnostics/reliability/no-unreleased-resource.ts";
import { requireSigtermHandler } from "../diagnostics/reliability/require-sigterm-handler.ts";
// security
import { jwtMissingExpiration } from "../diagnostics/security/jwt-missing-expiration.ts";
import { noCrossTenantCacheKey } from "../diagnostics/security/no-cross-tenant-cache-key.ts";
import { noDisabledTlsVerification } from "../diagnostics/security/no-disabled-tls-verification.ts";
import { noErrorLeakToClient } from "../diagnostics/security/no-error-leak-to-client.ts";
import { noEvalWithInput } from "../diagnostics/security/no-eval-with-input.ts";
import { noExecWithInterpolation } from "../diagnostics/security/no-exec-with-interpolation.ts";
import { noFunctionConstructorWithInput } from "../diagnostics/security/no-function-constructor-with-input.ts";
import { noHardcodedSecretLiteral } from "../diagnostics/security/no-hardcoded-secret-literal.ts";
import { noJwtDecodeAsVerify } from "../diagnostics/security/no-jwt-decode-as-verify.ts";
import { noJwtNoneAlgorithm } from "../diagnostics/security/no-jwt-none-algorithm.ts";
import { noMassAssignment } from "../diagnostics/security/no-mass-assignment.ts";
import { noMathRandomForToken } from "../diagnostics/security/no-math-random-for-token.ts";
import { noNondeterministicStableKey } from "../diagnostics/security/no-nondeterministic-stable-key.ts";
import { noNosqlObjectInjection } from "../diagnostics/security/no-nosql-object-injection.ts";
import { noOpenRedirect } from "../diagnostics/security/no-open-redirect.ts";
import { noPathTraversal } from "../diagnostics/security/no-path-traversal.ts";
import { noPrototypePollution } from "../diagnostics/security/no-prototype-pollution.ts";
import { noSensitiveDataInLogs } from "../diagnostics/security/no-sensitive-data-in-logs.ts";
import { noSqlTemplateInterpolation } from "../diagnostics/security/no-sql-template-interpolation.ts";
import { noSsrfUnvalidatedUrl } from "../diagnostics/security/no-ssrf-unvalidated-url.ts";
import { noStateChangeOnGet } from "../diagnostics/security/no-state-change-on-get.ts";
import { noStatefulGlobalRegexTest } from "../diagnostics/security/no-stateful-global-regex-test.ts";
import { noStaticCipherIv } from "../diagnostics/security/no-static-cipher-iv.ts";
import { noTaintedSinkViaHelper } from "../diagnostics/security/no-tainted-sink-via-helper.ts";
import { noTimingUnsafeSecretCompare } from "../diagnostics/security/no-timing-unsafe-secret-compare.ts";
import { noUnanchoredSecurityRegex } from "../diagnostics/security/no-unanchored-security-regex.ts";
import { noUnnormalizedIdentityComparison } from "../diagnostics/security/no-unnormalized-identity-comparison.ts";
import { noUnsafeArchiveExtraction } from "../diagnostics/security/no-unsafe-archive-extraction.ts";
import { noUnsafeDeserialization } from "../diagnostics/security/no-unsafe-deserialization.ts";
import { noUnsafeRegexpFromInput } from "../diagnostics/security/no-unsafe-regexp-from-input.ts";
import { noVmRunUntrusted } from "../diagnostics/security/no-vm-run-untrusted.ts";
import { noWeakCipher } from "../diagnostics/security/no-weak-cipher.ts";
import { noWeakCryptoParameters } from "../diagnostics/security/no-weak-crypto-parameters.ts";
import { noWeakHashForPassword } from "../diagnostics/security/no-weak-hash-for-password.ts";
import { noXssInHtmlResponse } from "../diagnostics/security/no-xss-in-html-response.ts";
import { requireJwtAlgorithmsAllowlist } from "../diagnostics/security/require-jwt-algorithms-allowlist.ts";
import { requireSecureCookieFlags } from "../diagnostics/security/require-secure-cookie-flags.ts";
import { secretInEnvFallback } from "../diagnostics/security/secret-in-env-fallback.ts";
// typed
import { noFloatingPromise } from "../diagnostics/typed/no-floating-promise.ts";

/** Every diagnostic known to node.doctor, in a stable declaration order. */
export const DIAGNOSTICS: Diagnostic[] = [
  // ai
  aiCallInLoop,
  mcpToolUnrestrictedCapability,
  noLlmOutputInSink,
  noPromptInjection,
  noSystemPromptLeak,
  noUnboundedAgentLoop,
  noUnguardedLlmJsonParse,
  requireLlmTokenLimit,
  // api
  graphqlIntrospectionInProduction,
  graphqlMissingDepthLimit,
  graphqlResolverReturnsRawError,
  grpcInsecureCredentials,
  // async
  noAsyncArrayCallback,
  noAsyncExecutor,
  noAwaitInLoopOverIndependentWork,
  noDetachedChildWithoutUnref,
  noMissingCatchOnAsyncIife,
  noRaceWithoutTimeout,
  noSwallowedErrorEmptyCatch,
  noUnboundedPromiseAll,
  noUnclonableWorkerMessage,
  requireFetchTimeout,
  // bugs
  noBigintPrecisionLoss,
  noBrokenSortComparator,
  noChunkStringConcat,
  noConstantCondition,
  noDirnameInEsm,
  noFloatingPromiseInTry,
  noLocalDateAsIsoDatestring,
  noNamespaceObjectWrite,
  noNanComparison,
  noOutOfRangeExitCode,
  noOversizedTimerDelay,
  noShadowedRoute,
  noSparseArrayIteration,
  noStringLengthAsContentLength,
  noThrowLiteral,
  noTofixedAsNumber,
  noUnclampedMonthShift,
  noUnreachableCleanupAfterExit,
  noUnreachableCode,
  noUnstableOffsetPagination,
  noUrlAsFilesystemPath,
  // config
  noNonNullEnvAccess,
  // db
  noDbConnectionPerRequest,
  noExternalCallInsideOpenTransaction,
  noFindmanyThenFilterInJs,
  noMissingAwaitOnQuery,
  noQueryInLoop,
  noUntransactedDependentWrites,
  // event-loop
  noLargeJsonParseInRequestPath,
  noProcessExitInRequestPath,
  noRedosProneRegex,
  noSyncBcryptInRequestPath,
  noSyncIoInRequestPath,
  noSyncIoReachableFromHandler,
  requirePaginationLimit,
  // frameworks
  hapiRouteAuthDisabled,
  hapiRouteMissingValidation,
  noHonoExactPathMiddleware,
  noNestResWithoutSend,
  noPeerInconsistentHandler,
  noUnawaitedAdonisAuthCheck,
  noUnawaitedAdonisValidation,
  noUnawaitedHonoBody,
  noUnawaitedKoaNext,
  noUnawaitedNextDynamicApi,
  noUnreturnedHonoResponse,
  restifyMissingErrorHandler,
  // http
  corsCredentialsReflect,
  expressAsyncHandlerUnprotected,
  expressMissingReturnAfterResponse,
  fastifyMissingSchema,
  nestMissingValidationPipe,
  noBodyOnBodilessStatus,
  noErrorResponseWithSuccessStatus,
  noExpress4RemovedApi,
  noMissingBodySizeLimit,
  noNestedQueryOnSimpleParser,
  noSendAfterNext,
  noSharedCacheAuthenticatedResponse,
  noStatusCodeAsResponseBody,
  noTrustProxyTrue,
  noWildcardBodyParser,
  requireErrorHandlingMiddleware,
  // maintainability
  deepNesting,
  highCyclomaticComplexity,
  jsdocParamMismatch,
  maxFunctionLength,
  noAssertionFreeTest,
  noCircularImports,
  noConsoleLogInCommittedCode,
  noDeadAsync,
  noDuplicateRouteDefinition,
  noFlakyTestPattern,
  noMockOfMissingExport,
  noRedundantTryCatchRethrow,
  noTautologicalMockAssertion,
  noUnimplementedStub,
  preferNodeProtocolImports,
  // modernization
  noDeprecatedNodeApi,
  noNodeBuiltinOnEdge,
  // performance
  noSequentialIndependentAwaits,
  // reliability
  noCacheWithoutTtl,
  noCrossRequestStateMutation,
  noDroppedAbortSignal,
  noErrorCauseDiscarded,
  noInfiniteRetryWithoutBackoff,
  noInvalidCronExpression,
  noInvertedTimeoutBudget,
  noListenerAddedPerRequest,
  noLiteralListenerRemoval,
  noLivenessCheckWithDependency,
  noLostAsyncContext,
  noMissingStreamErrorHandler,
  noMissingWebsocketErrorHandler,
  noRetryAmplification,
  noThrowInFinally,
  noUnboundedModuleCache,
  noUncatchableSignalHandler,
  noUnclearedModuleInterval,
  noUnhandledPipeError,
  noUnreleasedResource,
  requireSigtermHandler,
  // security
  jwtMissingExpiration,
  noCrossTenantCacheKey,
  noDisabledTlsVerification,
  noErrorLeakToClient,
  noEvalWithInput,
  noExecWithInterpolation,
  noFunctionConstructorWithInput,
  noHardcodedSecretLiteral,
  noJwtDecodeAsVerify,
  noJwtNoneAlgorithm,
  noMassAssignment,
  noMathRandomForToken,
  noNondeterministicStableKey,
  noNosqlObjectInjection,
  noOpenRedirect,
  noPathTraversal,
  noPrototypePollution,
  noSensitiveDataInLogs,
  noSqlTemplateInterpolation,
  noSsrfUnvalidatedUrl,
  noStateChangeOnGet,
  noStatefulGlobalRegexTest,
  noStaticCipherIv,
  noTaintedSinkViaHelper,
  noTimingUnsafeSecretCompare,
  noUnanchoredSecurityRegex,
  noUnnormalizedIdentityComparison,
  noUnsafeArchiveExtraction,
  noUnsafeDeserialization,
  noUnsafeRegexpFromInput,
  noVmRunUntrusted,
  noWeakCipher,
  noWeakCryptoParameters,
  noWeakHashForPassword,
  noXssInHtmlResponse,
  requireJwtAlgorithmsAllowlist,
  requireSecureCookieFlags,
  secretInEnvFallback,
  // typed
  noFloatingPromise,
];

/** Diagnostic id → diagnostic, for catalogs, config UIs, and lookups. */
export const DIAGNOSTICS_BY_ID: Map<string, Diagnostic> = new Map(DIAGNOSTICS.map((diagnostic) => [diagnostic.id, diagnostic]));
