/** Memoises an async factory. A rejected attempt is forgotten so the next call retries instead of failing forever. */
export function lazy<T>(create: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () =>
    (p ??= create().catch((e) => {
      p = null;
      throw e;
    }));
}
