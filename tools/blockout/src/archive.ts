// Deterministic source archive: ustar + gzip, written here so the same inputs give
// the same bytes on any machine (sorted names, zeroed mtime/uid/gid, fixed gzip
// header). Archiving is bookkeeping, not video processing.

import { gzipSync } from "bun";

export interface ArchiveEntry {
  /** Relative, forward-slash path inside the archive. */
  path: string;
  data: Uint8Array;
}

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function header(path: string, size: number): Uint8Array {
  if (new TextEncoder().encode(path).length > 100) throw new Error(`archive path too long for ustar: ${path}`);
  const h = new Uint8Array(512);
  const put = (off: number, text: string) => h.set(new TextEncoder().encode(text), off);
  put(0, path);
  put(100, octal(0o644, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(size, 12));
  put(136, octal(0, 12)); // mtime: zero, on purpose
  put(148, "        "); // checksum placeholder
  put(156, "0");
  put(257, "ustar\0");
  put(263, "00");
  let sum = 0;
  for (const b of h) sum += b;
  put(148, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}

export function tarGz(entries: ArchiveEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const blocks: Uint8Array[] = [];
  for (const e of sorted) {
    blocks.push(header(e.path, e.data.length), e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) blocks.push(new Uint8Array(pad));
  }
  blocks.push(new Uint8Array(1024)); // end of archive
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const tar = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    tar.set(b, off);
    off += b.length;
  }
  const gz = gzipSync(tar, { level: 9 });
  // RFC 1952 header: mtime (bytes 4-7) = 0, OS (byte 9) = 3 (Unix), whatever the platform wrote
  const out = new Uint8Array(gz);
  out.fill(0, 4, 8);
  out[9] = 3;
  return out;
}
