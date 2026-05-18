"use client";

/**
 * @file DevrightDashboardOverlay.tsx
 * @description Developer-only real-time telemetry overlay widget.
 *
 * Renders an always-on-top overlay panel inside the Pi Network webview
 * in NON-production environments. The panel displays:
 *   - Live JavaScript heap memory usage (with color-coded bar)
 *   - Battery level and charging status
 *   - API latency (P95) for the most-called endpoint
 *   - Live console errors captured in the current session
 *   - Quick flush button
 *
 * Styling uses the Devright Labs enterprise design system:
 *   - Background:  #0A0A0F
 *   - Accent:      #F0C040
 *   - Success:     #22C55E
 *   - Warning:     #F97316
 *   - Danger:      #EF4444
 *   - Text:        #E2E8F0
 *   - Muted:       #64748B
 *
 * IMPORTANT: This component should be conditionally rendered only in
 * development/staging. Gate it behind `process.env.NODE_ENV !== "production"`.
 *
 * @example
 * ```tsx
 * {process.env.NODE_ENV !== "production" && <DevrightDashboardOverlay />}
 * ```
 */

import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import { useTelemetry } from "./useTelemetry.js";
import { useTelemetryContext } from "./TelemetryProvider.js";
import type { TelemetryEvent, HeatmapEntry } from "../types/telemetry.js";

// ---------------------------------------------------------------------------
// Design Tokens
// ---------------------------------------------------------------------------

const DS = {
  bg: "#0A0A0F",
  bgPanel: "#12121A",
  bgCard: "#1A1A26",
  accent: "#F0C040",
  success: "#22C55E",
  warning: "#F97316",
  danger: "#EF4444",
  text: "#E2E8F0",
  muted: "#64748B",
  border: "#2A2A3E",
  font: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
} as const;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Progress bar used for memory and battery visualizations. */
function ProgressBar({
  value,
  max,
  colorFn,
}: {
  value: number;
  max: number;
  colorFn: (ratio: number) => string;
}): React.ReactElement {
  const ratio = max > 0 ? Math.min(value / max, 1) : 0;
  const color = colorFn(ratio);
  return (
    <div
      style={{
        background: DS.bgCard,
        borderRadius: 3,
        height: 6,
        overflow: "hidden",
        marginTop: 4,
      }}
    >
      <div
        style={{
          width: `${Math.round(ratio * 100)}%`,
          height: "100%",
          background: color,
          borderRadius: 3,
          transition: "width 0.4s ease",
        }}
      />
    </div>
  );
}

/** Returns a color based on a 0–1 ratio (green → orange → red). */
function ratioColor(ratio: number): string {
  if (ratio < 0.6) return DS.success;
  if (ratio < 0.85) return DS.warning;
  return DS.danger;
}

/** A single metric card row. */
function MetricRow({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "3px 0",
      }}
    >
      <span style={{ color: DS.muted, fontSize: 10, fontFamily: DS.font }}>
        {label}
      </span>
      <span
        style={{
          color: accent ? DS.accent : DS.text,
          fontSize: 11,
          fontFamily: DS.font,
          fontWeight: accent ? 700 : 400,
        }}
      >
        {value}
      </span>
    </div>
  );
}

/** Section header inside the overlay panel. */
function SectionHeader({ title }: { title: string }): React.ReactElement {
  return (
    <div
      style={{
        fontSize: 9,
        letterSpacing: "0.12em",
        color: DS.accent,
        fontFamily: DS.font,
        fontWeight: 700,
        textTransform: "uppercase",
        marginTop: 10,
        marginBottom: 4,
        borderBottom: `1px solid ${DS.border}`,
        paddingBottom: 3,
      }}
    >
      {title}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * Developer-only real-time telemetry overlay.
 * Renders a draggable, collapsible panel in the bottom-right corner of the
 * viewport. Should only be rendered in non-production environments.
 *
 * @example
 * ```tsx
 * {process.env.NODE_ENV !== "production" && <DevrightDashboardOverlay />}
 * ```
 */
export function DevrightDashboardOverlay(): React.ReactElement | null {
  const { log, health, flush } = useTelemetry();
  const { engine } = useTelemetryContext();

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isFlushing, setIsFlushing] = useState(false);
  const [recentErrors, setRecentErrors] = useState<TelemetryEvent[]>([]);
  const [topEndpoints, setTopEndpoints] = useState<HeatmapEntry[]>([]);
  const [position, setPosition] = useState({ x: 16, y: 16 });
  const isDragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  // -------------------------------------------------------------------------
  // Poll engine data
  // -------------------------------------------------------------------------

  useEffect(() => {
    function poll(): void {
      const errors = engine
        .getRecentEvents({ limit: 5, level: "error" })
        .slice() as TelemetryEvent[];
      setRecentErrors(errors.reverse());

      const heatmap = engine
        .getNetworkHeatmap({ topN: 3 })
        .slice() as HeatmapEntry[];
      setTopEndpoints(heatmap);
    }

    poll();
    const id = setInterval(poll, 3_000);
    return () => clearInterval(id);
  }, [engine]);

  // -------------------------------------------------------------------------
  // Drag support
  // -------------------------------------------------------------------------

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>): void => {
      isDragging.current = true;
      dragOffset.current = {
        x: e.clientX - position.x,
        y: e.clientY - position.y,
      };
      e.preventDefault();
    },
    [position]
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent): void => {
      if (!isDragging.current) return;
      setPosition({
        x: e.clientX - dragOffset.current.x,
        y: e.clientY - dragOffset.current.y,
      });
    };
    const onMouseUp = (): void => {
      isDragging.current = false;
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // -------------------------------------------------------------------------
  // Flush handler
  // -------------------------------------------------------------------------

  const handleFlush = async (): Promise<void> => {
    setIsFlushing(true);
    try {
      await flush();
      log.info("[Dashboard] Manual flush triggered by developer overlay");
    } finally {
      setIsFlushing(false);
    }
  };

  // -------------------------------------------------------------------------
  // Derived display values
  // -------------------------------------------------------------------------

  const memUsedMb = health.memory
    ? Math.round(health.memory.jsHeapUsedBytes / 1_048_576)
    : null;
  const memLimitMb = health.memory
    ? Math.round(health.memory.jsHeapLimitBytes / 1_048_576)
    : null;
  const memRatio = health.memory?.heapUsageRatio ?? 0;

  const batteryPct = health.battery
    ? Math.round(health.battery.level * 100)
    : null;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div
      style={{
        position: "fixed",
        bottom: position.y,
        right: position.x,
        zIndex: 99999,
        width: isCollapsed ? 140 : 280,
        background: DS.bg,
        border: `1px solid ${DS.border}`,
        borderRadius: 8,
        boxShadow: "0 4px 24px rgba(0,0,0,0.8)",
        fontFamily: DS.font,
        userSelect: "none",
        transition: "width 0.2s ease",
      }}
    >
      {/* ----------------------------------------------------------------- */}
      {/* Header / Drag Handle                                               */}
      {/* ----------------------------------------------------------------- */}
      <div
        onMouseDown={handleMouseDown}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 10px",
          cursor: "grab",
          borderBottom: isCollapsed ? "none" : `1px solid ${DS.border}`,
          borderRadius: isCollapsed ? 8 : "8px 8px 0 0",
          background: DS.bgPanel,
        }}
      >
        <span
          style={{
            color: DS.accent,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.1em",
          }}
        >
          ◈ DEVRIGHT
        </span>
        <button
          onClick={() => setIsCollapsed((c) => !c)}
          style={{
            background: "none",
            border: "none",
            color: DS.muted,
            fontSize: 12,
            cursor: "pointer",
            padding: "0 2px",
            lineHeight: 1,
          }}
          aria-label={isCollapsed ? "Expand overlay" : "Collapse overlay"}
        >
          {isCollapsed ? "▲" : "▼"}
        </button>
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Body                                                               */}
      {/* ----------------------------------------------------------------- */}
      {!isCollapsed && (
        <div style={{ padding: "8px 10px 10px" }}>
          {/* Memory Section */}
          <SectionHeader title="Memory" />
          {health.memory !== null ? (
            <>
              <MetricRow
                label="JS Heap"
                value={`${memUsedMb} / ${memLimitMb} MB`}
                accent={memRatio >= 0.85}
              />
              <ProgressBar
                value={memRatio}
                max={1}
                colorFn={ratioColor}
              />
              <MetricRow
                label="Usage"
                value={`${Math.round(memRatio * 100)}%`}
              />
            </>
          ) : (
            <MetricRow label="Status" value="N/A (no performance.memory)" />
          )}

          {/* Battery Section */}
          <SectionHeader title="Battery" />
          {health.battery !== null ? (
            <>
              <MetricRow
                label="Level"
                value={`${batteryPct}%${health.battery.charging ? " ⚡" : ""}`}
                accent={!health.battery.charging && (batteryPct ?? 100) < 20}
              />
              <ProgressBar
                value={batteryPct ?? 0}
                max={100}
                colorFn={(r) => {
                  if (r > 0.5) return DS.success;
                  if (r > 0.2) return DS.warning;
                  return DS.danger;
                }}
              />
              {health.battery.dischargingTimeSeconds !== null && (
                <MetricRow
                  label="Est. remaining"
                  value={`${Math.round(health.battery.dischargingTimeSeconds / 60)} min`}
                />
              )}
            </>
          ) : (
            <MetricRow label="Status" value="N/A (Battery API unavailable)" />
          )}

          {/* Network Section */}
          <SectionHeader title="Network (top failures)" />
          {topEndpoints.length > 0 ? (
            topEndpoints.map((ep) => (
              <MetricRow
                key={ep.endpoint}
                label={ep.endpoint.slice(-28)}
                value={`${Math.round(ep.failureRate * 100)}% fail · p95:${ep.p95LatencyMs}ms`}
                accent={ep.failureRate > 0.1}
              />
            ))
          ) : (
            <MetricRow label="Status" value="No requests intercepted yet" />
          )}

          {/* Recent Errors Section */}
          <SectionHeader title="Recent errors" />
          {recentErrors.length > 0 ? (
            recentErrors.slice(0, 3).map((ev) => (
              <div
                key={ev.id}
                style={{
                  fontSize: 9,
                  color: DS.danger,
                  fontFamily: DS.font,
                  padding: "2px 0",
                  borderBottom: `1px solid ${DS.border}`,
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  textOverflow: "ellipsis",
                }}
              >
                {ev.message.slice(0, 52)}
              </div>
            ))
          ) : (
            <MetricRow label="Status" value="No errors captured ✓" />
          )}

          {/* Flush Button */}
          <button
            onClick={() => void handleFlush()}
            disabled={isFlushing}
            style={{
              marginTop: 10,
              width: "100%",
              padding: "6px 0",
              background: isFlushing ? DS.muted : DS.accent,
              color: DS.bg,
              border: "none",
              borderRadius: 5,
              fontFamily: DS.font,
              fontSize: 10,
              fontWeight: 700,
              cursor: isFlushing ? "not-allowed" : "pointer",
              letterSpacing: "0.08em",
              transition: "background 0.2s ease",
            }}
          >
            {isFlushing ? "FLUSHING…" : "⬆ FLUSH QUEUE"}
          </button>
        </div>
      )}
    </div>
  );
}
