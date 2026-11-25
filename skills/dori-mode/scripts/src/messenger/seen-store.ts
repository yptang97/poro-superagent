/**
 * A bounded, file-backed set of message ids, so a restarted channel consumer does not answer the same message twice.
 * The last MAX_SEEN_IDS ids are kept; a missing or corrupt file starts empty instead of stopping the channel.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type SeenStore = { has(id: string): boolean; add(id: string): void };

const MAX_SEEN_IDS = 1000;

export const fileSeenStore = (path: string, what: string, warn: (message: string) => void = () => {}): SeenStore => {
  let warned = false;
  let ids: Set<string> | undefined;
  const load = (): Set<string> => {
    if (ids) return ids;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      ids = new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
      if (!Array.isArray(parsed) && !warned) {
        warned = true;
        warn(`${what} at ${path} is not a JSON array; starting empty`);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" && !warned) {
        warned = true;
        warn(`${what} at ${path} is unreadable; starting empty`);
      }
      ids = new Set();
    }
    return ids;
  };
  return {
    has: (id) => load().has(id),
    add(id) {
      const set = load();
      set.add(id);
      const kept = [...set].slice(-MAX_SEEN_IDS);
      ids = new Set(kept);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(kept));
    },
  };
};
