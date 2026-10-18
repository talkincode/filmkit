// Token scrubbing for everything captured from `colab` (PLAN §6.4 + M0 amendment A5).
// Every captured stdout/stderr passes through redact() BEFORE it is logged, stored in a
// ledger/transcript, or put into an error message. M0 F4 showed that a failed `colab upload`
// prints the full runtime URL including `colab-runtime-proxy-token=<JWT>`.
//
// Order matters: the URL-parameter patterns run first and swallow the whole value (JWTs
// contain dots), then the free-standing token shapes catch what is left.

export const REDACTED = "[REDACTED]";

interface Rule {
  re: RegExp;
  /** Replacement; a function keeps the key part of `key=value` patterns readable. */
  to: string | ((...m: string[]) => string);
}

// Value characters of a URL/query token: everything up to a separator.
const VALUE = String.raw`[^&\s"'<>)\]]+`;

const RULES: Rule[] = [
  { re: new RegExp(String.raw`(colab-runtime-proxy-token)=${VALUE}`, "gi"), to: (_m, k) => `${k}=${REDACTED}` },
  { re: new RegExp(String.raw`([?&](?:token|access_token|authuser_token))=${VALUE}`, "gi"), to: (_m, k) => `${k}=${REDACTED}` },
  { re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, to: REDACTED }, // JWT
  { re: /ya29\.[\w-]+/g, to: REDACTED }, // Google OAuth access token
  { re: /Bearer\s+\S+/gi, to: `Bearer ${REDACTED}` },
  { re: /hf_[A-Za-z0-9]{30,}/g, to: REDACTED }, // Hugging Face token
  { re: /("(?:access|refresh)_token"\s*:\s*)"[^"]+"/g, to: (_m, k) => `${k}"${REDACTED}"` },
  { re: /AIza[\w-]{35}/g, to: REDACTED }, // Google API key
];

export function redact(text: string): string {
  let out = text;
  for (const { re, to } of RULES) out = out.replace(re, to as never);
  return out;
}

/** Redact every string inside a parsed JSON value (keys untouched); returns a new value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  return value;
}
