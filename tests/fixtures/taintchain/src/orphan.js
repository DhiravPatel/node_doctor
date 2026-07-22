export const unreached = (n) => db.query(`SELECT * FROM t WHERE x = ${n}`);
