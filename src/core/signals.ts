/**
 * Shared vocabulary of "interesting" calls, centralized so diagnostics and the Phase B
 * effect summaries agree on one canonical list. Diagnostic-specific vocabulary stays
 * in the diagnostic file; only the cross-cutting sets live here.
 */

/** Synchronous, event-loop-blocking stdlib calls (method segment names). */
export const SYNC_IO_METHODS = new Set([
  // fs
  "readFileSync",
  "writeFileSync",
  "appendFileSync",
  "readdirSync",
  "statSync",
  "lstatSync",
  "fstatSync",
  "existsSync",
  "accessSync",
  "mkdirSync",
  "rmSync",
  "rmdirSync",
  "unlinkSync",
  "copyFileSync",
  "renameSync",
  "realpathSync",
  "readlinkSync",
  "truncateSync",
  "chmodSync",
  "opendirSync",
  // child_process
  "execSync",
  "execFileSync",
  "spawnSync",
  // crypto (deliberately slow KDFs)
  "pbkdf2Sync",
  "scryptSync",
  // zlib
  "gzipSync",
  "gunzipSync",
  "deflateSync",
  "inflateSync",
  "brotliCompressSync",
  "brotliDecompressSync",
]);

/** Shell-spawning execution APIs (a shell re-parses the string). */
export const SHELL_EXEC = new Set(["exec", "execSync"]);

/** Shell-free execution APIs (argument array, no re-parse). */
export const SAFE_EXEC = new Set(["execFile", "execFileSync", "spawn", "spawnSync"]);

/** Query-shaped ORM/driver method names (used with a db-shaped receiver). */
export const QUERY_METHODS = new Set([
  "findMany",
  "findFirst",
  "findUnique",
  "findFirstOrThrow",
  "findUniqueOrThrow",
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "deleteMany",
  "aggregate",
  "groupBy",
  "count",
  "query",
  "execute",
  "$queryRaw",
  "$executeRaw",
  "$queryRawUnsafe",
  "$executeRawUnsafe",
  "insert",
  "save",
  "findOne",
  "findOneBy",
  "findBy",
]);

/** Receiver-name fragments that suggest a database client (segment-aware). */
export const DB_RECEIVER_HINTS = [
  "db",
  "prisma",
  "knex",
  "sequelize",
  "mongoose",
  "repository",
  "repo",
  "orm",
  "client",
  "pool",
  "conn",
  "connection",
  "datasource",
  "em", // TypeORM EntityManager
  "queryRunner",
  "collection",
  "model",
];
