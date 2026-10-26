import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";

export const sha256Bytes = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

export const sha256FileSync = (path: string): string => sha256Bytes(readFileSync(path));
export const sizeOf = (path: string): number => statSync(path).size;
