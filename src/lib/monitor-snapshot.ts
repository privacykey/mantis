export type MonitorSnapshot = {
  state: "off" | "ok" | "tripped";
  trippedAt: string | null;
  mode: "off" | "latch" | "window";
  windowSeconds: number;
};

/** Reject failure/malformed responses instead of treating them as healthy. */
export function parseMonitorSnapshot(input: unknown): MonitorSnapshot | null {
  if (!input || typeof input !== "object") return null;
  const data = input as Record<string, unknown>;
  if (!["off", "ok", "tripped"].includes(String(data.state)) ||
      !["off", "latch", "window"].includes(String(data.mode)) ||
      typeof data.window_seconds !== "number" || !Number.isInteger(data.window_seconds) ||
      data.window_seconds < 30 || data.window_seconds > 86_400 ||
      (data.tripped_at !== null && (typeof data.tripped_at !== "string" || !Number.isFinite(Date.parse(data.tripped_at)))) ||
      (data.state === "tripped" && data.tripped_at === null)) return null;
  return { state: data.state as MonitorSnapshot["state"], trippedAt: data.tripped_at as string | null,
    mode: data.mode as MonitorSnapshot["mode"], windowSeconds: data.window_seconds };
}
