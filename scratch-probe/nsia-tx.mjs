import { lintSource } from "../src/core/scan.ts";
import { noSequentialIndependentAwaits as D } from "../src/diagnostics/performance/no-sequential-independent-awaits.ts";
const caps = new Set(["node","esm","typescript","express"]);
const n=(src)=>lintSource({filePath:"a.ts",sourceText:src,diagnostics:[D],capabilities:caps}).findings.length;
const c={
 "tx.user.findMany x2 (interactive tx, param named tx => hint miss)":`async function f(){const a=await tx.user.findMany();const b=await tx.post.findMany();return[a,b];}`,
 "prisma.user.findMany x2 (prisma hint; interactive-tx footgun if tx)":`async function f(){const a=await prisma.user.findMany();const b=await prisma.post.findMany();return[a,b];}`,
 "db.user.findMany x2 (db could be interactive-tx client)":`async function f(){const a=await db.user.findMany();const b=await db.post.findMany();return[a,b];}`,
 "sequelize.query SELECT x2 (single sequelize instance)":`async function f(){const a=await sequelize.query("SELECT 1");const b=await sequelize.query("SELECT 2");return[a,b];}`,
};
for(const[l,s]of Object.entries(c)){let o;try{o=n(s);}catch(e){o="ERR:"+e.message;}console.log(`${o}\t${l}`);}
