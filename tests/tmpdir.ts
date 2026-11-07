// A test's temporary folder removed at its end. A browser a test ran keeps its profile's files open for a moment after it
// is stopped, and Windows refuses to delete an open file (EBUSY, EPERM): the removal is tried again for a few seconds, and
// a folder still held after that is left for the system's temporary-files cleanup (a warning, not a failed test).

import { rmSync } from "node:fs";

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function removeDir(dir: string, tries = 25): void {
  for (let i = 1; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if ((code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") || i >= tries) {
        if (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY") {
          console.warn(`left ${dir}: still in use (${code})`);
          return;
        }
        throw e;
      }
      sleep(200);
    }
  }
}
