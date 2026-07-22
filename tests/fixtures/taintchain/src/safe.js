export const safeLookup = (n) => db.query("SELECT * FROM users WHERE name = $1", [n]);
