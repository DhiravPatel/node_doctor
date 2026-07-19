// A real cache: written AND evicted (TTL sweep + explicit delete).
const sessionCache = new Map();

const sweep = setInterval(() => sessionCache.clear(), 60_000);
sweep.unref();

export function remember(token, user) {
  sessionCache.set(token, user);
}

export function forget(token) {
  sessionCache.delete(token);
}

export function lookup(token) {
  return sessionCache.get(token);
}
