/**
 * A tiny bounded-concurrency map. Runs `fn` over `items` with at most
 * `concurrency` in flight, preserving input order in the result array.
 */
export const mapPool = async <T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(concurrency, items.length || 1));
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
  return out;
};
