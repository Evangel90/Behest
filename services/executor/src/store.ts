import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Store, TransferMemory } from "./types.js";

/** Small JSON file store for timing hints. Losing it only resets stuck/backoff timers. */
export function fileStore(path: string): Store {
  const data: Record<string, TransferMemory> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return {
    get: (key) => data[key] ?? { hashes: [] },
    set(key, m) {
      data[key] = m;
      writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2));
      renameSync(`${path}.tmp`, path);
    },
  };
}

export function memoryStore(): Store {
  const data = new Map<string, TransferMemory>();
  return { get: (k) => data.get(k) ?? { hashes: [] }, set: (k, m) => void data.set(k, m) };
}
