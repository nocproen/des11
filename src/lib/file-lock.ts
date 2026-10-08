// Serialize GUI read/compare/write operations for the same native path.
// External terminal programs still use normal OS filesystem semantics.
const holder = globalThis as unknown as { __wdFileWrites?: Map<string, Promise<void>> };
const writes = (holder.__wdFileWrites ??= new Map<string, Promise<void>>());
export async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = writes.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  writes.set(path, tail);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (writes.get(path) === tail) writes.delete(path);
  }
}
