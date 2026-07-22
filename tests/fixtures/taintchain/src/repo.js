export const findUser = (n) => db.query(`SELECT * FROM users WHERE name = ${n}`);
