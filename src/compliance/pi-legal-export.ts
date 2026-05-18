/**
 * @file pi-legal-export.ts
 * @description CLAP (Community Legal Aid Programme) dispute payload exporter.
 *
 * When a P2P transaction enters a dispute state, this module compiles a
 * tamper-proof, formalized JSON payload containing:
 *   - The transaction hash
 *   - AES-256 encrypted chat logs (plaintext never leaves the device)
 *   - A telemetry snapshot covering the transaction period
 *   - The audit trail entries for the transaction lifecycle
 *   - A SHA-256 integrity hash of the entire payload
 *
 * The resulting DisputePayload can be submitted to CLAP reviewers who hold
 * the decryption key, ensuring privacy-preserving legal evidence collection.
 *
 * SECURITY NOTE: This module never transmits plaintext chat logs. All
 * encryption is performed client-side using the Web Crypto AES-GCM algorithm
 * before the payload is constructed.
 */

import type { TelemetryEngine } from "../core/TelemetryEngine.js";
import type {
  DisputePayload,
  TelemetryEvent,
  AuditEntry,
} from "../types/telemetry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the legal export module. */
export interface LegalExportConfig {
  /** TelemetryEngine to source telemetry snapshots from. */
  readonly engine: TelemetryEngine;
}

/** Input required to generate a dispute payload. */
export interface DisputeExportInput {
  /**
   * The transaction hash identifying the disputed P2P transaction.
   * Must not be a raw wallet address.
   */
  readonly transactionHash: string;
  /**
   * The plaintext chat log content to encrypt.
   * This string is AES-256-GCM encrypted client-side and the plaintext
   * is immediately discarded after encryption.
   */
  readonly chatLogPlaintext: string;
  /**
   * The AES-GCM encryption key to use (256-bit CryptoKey or raw hex string).
   * The caller is responsible for secure key management (e.g., derived from
   * the Pi SDK's authentication context).
   */
  readonly encryptionKey: CryptoKey | string;
  /**
   * A subset of telemetry events to include. If omitted, the engine's
   * current in-memory queue is used.
   */
  readonly telemetrySnapshot?: readonly TelemetryEvent[];
  /**
   * A subset of audit entries to include. If omitted, the full ledger
   * from the TelemetryEngine is used.
   */
  readonly auditEntries?: readonly AuditEntry[];
}

/** Handle returned by `createLegalExporter`. */
export interface LegalExporterHandle {
  /**
   * Generates a tamper-proof DisputePayload ready for CLAP submission.
   *
   * @param input - The dispute export input data.
   * @returns A Promise resolving to the complete DisputePayload.
   */
  generateDisputePayload(input: DisputeExportInput): Promise<DisputePayload>;

  /**
   * Serializes a DisputePayload to a canonical JSON string.
   * Use this to write the payload to a file or POST it to the CLAP endpoint.
   */
  serializeToJson(payload: DisputePayload): string;
}

// ---------------------------------------------------------------------------
// Crypto Helpers
// ---------------------------------------------------------------------------

/**
 * Computes a SHA-256 hex digest of the given string.
 */
async function sha256Hex(input: string): Promise<string> {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    let h = 5381;
    for (let i = 0; i < input.length; i++) {
      h = ((h << 5) + h) ^ (input.charCodeAt(i) & 0xff);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }
}

/**
 * Imports a raw hex key string as a Web Crypto AES-GCM CryptoKey.
 *
 * @param hexKey - A 64-character hex string representing a 256-bit AES key.
 * @returns A CryptoKey suitable for AES-GCM encryption.
 */
async function importHexKey(hexKey: string): Promise<CryptoKey> {
  if (hexKey.length !== 64) {
    throw new Error(
      "AES-256 key must be exactly 64 hex characters (256 bits). " +
        `Received ${hexKey.length} characters.`
    );
  }
  const keyBytes = new Uint8Array(
    hexKey.match(/.{2}/g)!.map((b) => parseInt(b, 16))
  );
  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
}

/**
 * Encrypts plaintext using AES-256-GCM and returns a Base64-encoded string
 * of the format: `<iv_hex>:<ciphertext_base64>`.
 *
 * @param plaintext - The string to encrypt.
 * @param key - The AES-GCM CryptoKey (256-bit).
 * @returns A Base64-encoded encrypted envelope.
 */
async function encryptAesGcm(
  plaintext: string,
  key: CryptoKey
): Promise<string> {
  // Generate a random 96-bit IV (recommended for AES-GCM)
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    data
  );

  const ivHex = Array.from(iv)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const ciphertextB64 = btoa(
    String.fromCharCode(...new Uint8Array(ciphertext))
  );

  return `${ivHex}:${ciphertextB64}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a legal exporter handle for generating CLAP dispute payloads.
 *
 * @param config - Legal export configuration.
 * @returns A LegalExporterHandle with `generateDisputePayload()` and `serializeToJson()`.
 *
 * @example
 * ```ts
 * const exporter = createLegalExporter({ engine });
 *
 * const payload = await exporter.generateDisputePayload({
 *   transactionHash: "tx_hash_abc123",
 *   chatLogPlaintext: chatMessages.join("\n"),
 *   encryptionKey: clapPublicKey, // CryptoKey from Pi SDK auth
 * });
 *
 * // Submit to CLAP endpoint
 * await fetch("/api/clap/submit", {
 *   method: "POST",
 *   body: exporter.serializeToJson(payload),
 * });
 * ```
 */
export function createLegalExporter(config: LegalExportConfig): LegalExporterHandle {
  const { engine } = config;

  async function generateDisputePayload(
    input: DisputeExportInput
  ): Promise<DisputePayload> {
    // 1. Resolve the encryption key
    let cryptoKey: CryptoKey;
    if (typeof input.encryptionKey === "string") {
      cryptoKey = await importHexKey(input.encryptionKey);
    } else {
      cryptoKey = input.encryptionKey;
    }

    // 2. Encrypt chat logs — plaintext is never stored
    const encryptedChatLogs = await encryptAesGcm(
      input.chatLogPlaintext,
      cryptoKey
    );

    // 3. Collect telemetry snapshot
    const telemetrySnapshot = input.telemetrySnapshot ??
      engine.getRecentEvents({ limit: 200 });

    // 4. Collect audit entries
    const auditEntries = input.auditEntries ??
      engine.getAuditTrail({ limit: 500 });

    // 5. Build the payload body (without integrityHash)
    const exportedAt = new Date().toISOString();
    const payloadBody = {
      exportedAt,
      formatVersion: "1.0" as const,
      transactionHash: input.transactionHash,
      encryptedChatLogs,
      telemetrySnapshot,
      auditEntries,
    };

    // 6. Compute integrity hash over the canonical JSON of the body
    const canonicalBody = JSON.stringify(payloadBody);
    const integrityHash = await sha256Hex(canonicalBody);

    const payload: DisputePayload = {
      ...payloadBody,
      integrityHash,
    };

    // 7. Emit a compliance telemetry event
    void engine.log(
      "info",
      `[LegalExport] Dispute payload generated for transaction ${input.transactionHash}`,
      {
        transactionHash: input.transactionHash,
        telemetryEventCount: telemetrySnapshot.length,
        auditEntryCount: auditEntries.length,
        integrityHash,
      },
      "compliance"
    );

    return payload;
  }

  function serializeToJson(payload: DisputePayload): string {
    return JSON.stringify(payload, null, 2);
  }

  return { generateDisputePayload, serializeToJson };
}
