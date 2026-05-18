/**
 * @file pi-audit-trail.ts
 * @description Immutable client-side audit trail for critical state changes.
 *
 * Creates a hash-chained ledger of all critical state changes independent of
 * the server backend. Each entry is linked to the previous via its SHA-256
 * hash, making the chain tamper-evident: modifying any historical entry
 * invalidates all subsequent entries' `previousEntryHash` fields.
 *
 * Auditable events include: authentication grants, payment approvals,
 * wallet links, KYC decisions, and configuration changes.
 */

import type { TelemetryEngine } from "../core/TelemetryEngine.js";
import type {
  AuditEntry,
  AuditEventType,
} from "../types/telemetry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the audit trail module. */
export interface AuditTrailConfig {
  /** TelemetryEngine to persist entries through. */
  readonly engine: TelemetryEngine;
  /**
   * Maximum number of entries to retain in the in-memory ledger.
   * Oldest entries are evicted when the cap is exceeded. Defaults to 1_000.
   */
  readonly maxEntries?: number;
}

/** Input for recording a new audit event. */
export interface AuditEventInput {
  /** The type of auditable state change. */
  readonly eventType: AuditEventType;
  /**
   * An anonymous actor identifier (e.g., a hash of the user's session ID).
   * Never use raw user IDs or wallet addresses.
   */
  readonly actorId: string;
  /** The resource being acted upon (e.g., "payment:tx_abc", "wallet:G...hash"). */
  readonly resourceId: string;
  /**
   * A string representation of the state BEFORE this change.
   * Will be SHA-256 hashed before storage.
   */
  readonly previousState: string;
  /**
   * A string representation of the state AFTER this change.
   * Will be SHA-256 hashed before storage.
   */
  readonly newState: string;
}

/** Handle returned by `createAuditTrail`. */
export interface AuditTrailHandle {
  /**
   * Records a new audit event and appends it to the immutable ledger.
   *
   * @param input - The audit event data.
   * @returns A Promise that resolves to the created AuditEntry.
   */
  record(input: AuditEventInput): Promise<AuditEntry>;

  /** Returns all ledger entries in chronological order. */
  getLedger(): readonly AuditEntry[];

  /**
   * Verifies the integrity of the entire audit chain.
   * Returns true if all `previousEntryHash` values are consistent.
   *
   * @returns An object with `valid: boolean` and `firstInvalidIndex: number | null`.
   */
  verifyChain(): Promise<{ valid: boolean; firstInvalidIndex: number | null }>;
}

// ---------------------------------------------------------------------------
// Crypto Helpers
// ---------------------------------------------------------------------------

/**
 * Computes a SHA-256 hex digest using the Web Crypto API.
 * Falls back to a simple deterministic hash on failure.
 *
 * @param input - The string to hash.
 * @returns A lowercase hex string.
 */
async function sha256Hex(input: string): Promise<string> {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // Fallback: djb2
    let h = 5381;
    for (let i = 0; i < input.length; i++) {
      h = ((h << 5) + h) ^ (input.charCodeAt(i) & 0xff);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }
}

/** UUID v4 generator. */
function uuidV4(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback using crypto.getRandomValues (cryptographically secure)
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error(
    "[pi-agent-telemetry] crypto.getRandomValues is required for audit trail ID generation " +
    "but is not available. Ensure the app runs in a secure context (HTTPS)."
  );
}

/**
 * Computes the canonical entry hash for an AuditEntry by hashing all fields
 * except `entryHash` itself.
 *
 * @param entry - The partial entry (without entryHash).
 * @returns The SHA-256 hex digest of the canonical representation.
 */
async function computeEntryHash(
  entry: Omit<AuditEntry, "entryHash">
): Promise<string> {
  const canonical = JSON.stringify({
    id: entry.id,
    timestamp: entry.timestamp,
    eventType: entry.eventType,
    actorId: entry.actorId,
    resourceId: entry.resourceId,
    previousStateHash: entry.previousStateHash,
    newStateHash: entry.newStateHash,
    previousEntryHash: entry.previousEntryHash,
  });
  return sha256Hex(canonical);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Sentinel hash used for the very first entry in the chain (no predecessor). */
const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Creates an immutable client-side audit trail instance.
 *
 * @param config - Audit trail configuration.
 * @returns An AuditTrailHandle with `record()`, `getLedger()`, and `verifyChain()`.
 *
 * @example
 * ```ts
 * const audit = createAuditTrail({ engine });
 *
 * await audit.record({
 *   eventType: "PAYMENT_APPROVE",
 *   actorId: "session_hash_abc",
 *   resourceId: "payment:tx_xyz",
 *   previousState: JSON.stringify({ status: "pending" }),
 *   newState: JSON.stringify({ status: "approved" }),
 * });
 * ```
 */
export function createAuditTrail(config: AuditTrailConfig): AuditTrailHandle {
  const { engine, maxEntries = 1_000 } = config;
  const ledger: AuditEntry[] = [];

  async function record(input: AuditEventInput): Promise<AuditEntry> {
    const previousEntry = ledger[ledger.length - 1];
    const previousEntryHash = previousEntry?.entryHash ?? GENESIS_HASH;

    const previousStateHash = await sha256Hex(input.previousState);
    const newStateHash = await sha256Hex(input.newState);

    const partial: Omit<AuditEntry, "entryHash"> = {
      id: uuidV4(),
      timestamp: new Date().toISOString(),
      eventType: input.eventType,
      actorId: input.actorId,
      resourceId: input.resourceId,
      previousStateHash,
      newStateHash,
      previousEntryHash,
    };

    const entryHash = await computeEntryHash(partial);
    const entry: AuditEntry = { ...partial, entryHash };

    ledger.push(entry);

    // Evict oldest entries if over cap
    while (ledger.length > maxEntries) {
      ledger.shift();
    }

    // Persist to the engine
    engine.addAuditEntry(entry);

    // Emit a telemetry event for the audit record
    void engine.log(
      "info",
      `[AuditTrail] ${input.eventType} recorded for resource ${input.resourceId}`,
      {
        eventType: input.eventType,
        actorId: input.actorId,
        resourceId: input.resourceId,
        entryHash,
      },
      "audit"
    );

    return entry;
  }

  function getLedger(): readonly AuditEntry[] {
    return [...ledger];
  }

  async function verifyChain(): Promise<{
    valid: boolean;
    firstInvalidIndex: number | null;
  }> {
    for (let i = 0; i < ledger.length; i++) {
      const entry = ledger[i]!;

      // Verify the entry's own hash
      const partial: Omit<AuditEntry, "entryHash"> = {
        id: entry.id,
        timestamp: entry.timestamp,
        eventType: entry.eventType,
        actorId: entry.actorId,
        resourceId: entry.resourceId,
        previousStateHash: entry.previousStateHash,
        newStateHash: entry.newStateHash,
        previousEntryHash: entry.previousEntryHash,
      };
      const expected = await computeEntryHash(partial);
      if (expected !== entry.entryHash) {
        return { valid: false, firstInvalidIndex: i };
      }

      // Verify the chain link
      const expectedPrevHash =
        i === 0 ? GENESIS_HASH : (ledger[i - 1]?.entryHash ?? GENESIS_HASH);
      if (entry.previousEntryHash !== expectedPrevHash) {
        return { valid: false, firstInvalidIndex: i };
      }
    }

    return { valid: true, firstInvalidIndex: null };
  }

  return { record, getLedger, verifyChain };
}
