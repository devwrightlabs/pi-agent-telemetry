/**
 * @file pi-pct-privacy-guard.ts
 * @description PCT (Pi Core Team) compliance wrapper.
 * Before any log leaves the device, this module strictly scrubs Personally
 * Identifiable Information (PII) and raw wallet addresses to adhere to Pi
 * Core Team ecosystem privacy rules.
 *
 * All scrubbing happens synchronously in-memory. No data is persisted or
 * transmitted by this module itself.
 */

import type { PctPrivacyResult, ScrubRecord } from "../types/telemetry.js";

// ---------------------------------------------------------------------------
// Internal Regex Patterns
// ---------------------------------------------------------------------------

/**
 * Pattern for Pi wallet addresses (starts with "G", 56 base32 chars, Stellar format).
 * Matches both mainnet and testnet addresses.
 */
const WALLET_ADDRESS_RE =
  /\bG[A-Z2-7]{55}\b/g;

/** Common email address pattern. */
const EMAIL_RE =
  /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;

/** E.164 international phone number pattern. */
const PHONE_RE =
  /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;

/** IPv4 address pattern. */
const IPV4_RE =
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/** UUID v4 pattern (used as user/session IDs in some Pi SDK calls). */
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

/** OAuth / JWT bearer token pattern. */
const BEARER_TOKEN_RE =
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

/** Generic API key / secret pattern (key=value). */
const API_KEY_RE =
  /(?:api[_\-]?key|secret|token|password|passwd|pwd|auth)\s*[:=]\s*['"]?[A-Za-z0-9\-._~+/]{8,}['"]?/gi;

// ---------------------------------------------------------------------------
// Crypto Utilities (Web Crypto API — available in WebView environments)
// ---------------------------------------------------------------------------

/**
 * Computes a SHA-256 hex digest of the given string.
 * Falls back to a deterministic non-cryptographic hash if Web Crypto is
 * unavailable (e.g., non-secure contexts in very old WebViews).
 *
 * @param value - The string to hash.
 * @returns A lowercase hex string.
 */
async function sha256Hex(value: string): Promise<string> {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(value);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // Fallback: djb2 hash (non-cryptographic, deterministic)
    let h = 5381;
    for (let i = 0; i < value.length; i++) {
      h = ((h << 5) + h) ^ (value.charCodeAt(i) & 0xff);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }
}

// ---------------------------------------------------------------------------
// Field-Level Scrubbers
// ---------------------------------------------------------------------------

/** Replaces a matched PII token with a labelled redaction marker. */
function redact(label: string): string {
  return `[REDACTED:${label}]`;
}

/**
 * Scrubs PII from a single string value.
 *
 * @param value - The string to scrub.
 * @returns Object containing the scrubbed string and an array of match labels.
 */
function scrubString(value: string): { scrubbed: string; labels: string[] } {
  const labels: string[] = [];
  let result = value;

  const apply = (re: RegExp, label: string): void => {
    const matches = result.match(re);
    if (matches && matches.length > 0) {
      labels.push(label);
      result = result.replace(re, redact(label));
    }
  };

  // Order matters: more specific patterns first.
  apply(BEARER_TOKEN_RE, "BEARER_TOKEN");
  apply(API_KEY_RE, "API_KEY");
  apply(WALLET_ADDRESS_RE, "PI_WALLET");
  apply(EMAIL_RE, "EMAIL");
  apply(PHONE_RE, "PHONE");
  apply(UUID_RE, "UUID");
  apply(IPV4_RE, "IPV4");

  return { scrubbed: result, labels };
}

// ---------------------------------------------------------------------------
// Payload-Level Sanitizer
// ---------------------------------------------------------------------------

type SafePayloadValue = string | number | boolean | null;
type SafePayload = Record<string, SafePayloadValue>;

/**
 * Recursively scrubs a plain payload object of all PII.
 * Numeric and boolean values are passed through unchanged.
 * String values are pattern-matched and redacted.
 *
 * @param payload - The raw payload object.
 * @returns The sanitized payload and an array of scrub records.
 */
async function scrubPayload(
  payload: SafePayload
): Promise<{ sanitized: SafePayload; records: ScrubRecord[] }> {
  const sanitized: SafePayload = {};
  const records: ScrubRecord[] = [];

  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string") {
      const { scrubbed, labels } = scrubString(value);
      if (labels.length > 0) {
        const valueHash = await sha256Hex(value);
        for (const label of labels) {
          records.push({
            fieldName: key,
            strategy: "redact",
            valueHash,
          });
          // Suppress unused variable warning — label is used for documentation
          void label;
        }
        sanitized[key] = scrubbed;
      } else {
        sanitized[key] = value;
      }
    } else {
      sanitized[key] = value;
    }
  }

  return { sanitized, records };
}

// ---------------------------------------------------------------------------
// Message Scrubber
// ---------------------------------------------------------------------------

/**
 * Scrubs a log message string of inline PII tokens.
 *
 * @param message - The raw log message.
 * @returns The scrubbed message and any scrub records.
 */
async function scrubMessage(
  message: string
): Promise<{ sanitized: string; records: ScrubRecord[] }> {
  const { scrubbed, labels } = scrubString(message);
  const records: ScrubRecord[] = [];
  if (labels.length > 0) {
    const valueHash = await sha256Hex(message);
    records.push({
      fieldName: "message",
      strategy: "redact",
      valueHash,
    });
  }
  return { sanitized: scrubbed, records };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Represents the minimal shape of a telemetry event needed by the guard.
 * This avoids a circular dependency with the full TelemetryEvent type.
 */
export interface GuardInput {
  readonly message: string;
  readonly payload: SafePayload;
}

/**
 * Runs the PCT privacy guard over a telemetry event's message and payload.
 * All PII (emails, phone numbers, Pi wallet addresses, tokens, IPs) is
 * scrubbed before the event is queued for transmission.
 *
 * @param input - The raw message and payload from the caller.
 * @returns A PctPrivacyResult containing the sanitized data and audit records.
 *
 * @example
 * ```ts
 * const result = await runPctPrivacyGuard({
 *   message: "User GABC123... purchased item",
 *   payload: { email: "user@example.com", amount: 3.14 },
 * });
 * // result.sanitized.message → "User [REDACTED:PI_WALLET] purchased item"
 * // result.sanitized.payload → { email: "[REDACTED:EMAIL]", amount: 3.14 }
 * ```
 */
export async function runPctPrivacyGuard(
  input: GuardInput
): Promise<PctPrivacyResult<GuardInput>> {
  const allRecords: ScrubRecord[] = [];

  const { sanitized: sanitizedMessage, records: msgRecords } =
    await scrubMessage(input.message);
  allRecords.push(...msgRecords);

  const { sanitized: sanitizedPayload, records: payloadRecords } =
    await scrubPayload(input.payload);
  allRecords.push(...payloadRecords);

  return {
    sanitized: {
      message: sanitizedMessage,
      payload: sanitizedPayload,
    },
    scrubRecords: allRecords,
    wasDirty: allRecords.length > 0,
  };
}

/**
 * Synchronous variant for contexts where async is not feasible.
 * Uses regex replacement directly without computing value hashes.
 *
 * @param message - The raw log message.
 * @returns The scrubbed message string.
 */
export function scrubMessageSync(message: string): string {
  return scrubString(message).scrubbed;
}

/**
 * Synchronous payload scrubber — no hash computation.
 *
 * @param payload - The raw payload object.
 * @returns The sanitized payload.
 */
export function scrubPayloadSync(payload: SafePayload): SafePayload {
  const sanitized: SafePayload = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string") {
      sanitized[key] = scrubString(value).scrubbed;
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
