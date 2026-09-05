"use client";

import { useEffect, useState } from "react";

type Capture = {
  id: number;
  captured_at: string;
  method: string;
  slug: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  body_truncated: boolean;
};

const METHOD_COLORS: Record<string, string> = {
  GET: "#60a5fa",
  POST: "#34d399",
  PUT: "#fbbf24",
  PATCH: "#fbbf24",
  DELETE: "#f87171",
  HEAD: "#a78bfa",
  OPTIONS: "#94a3b8",
};

export default function InboxPage() {
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (!alive) return;
      if (paused) {
        timer = setTimeout(tick, 1000);
        return;
      }
      try {
        const res = await fetch("/api/inbox", { cache: "no-store" });
        if (!res.ok) {
          if (res.status === 404) {
            setError(
              "inbox disabled — set ENABLE_DEV_INBOX=1 to enable the dev capture buffer",
            );
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as { data: Capture[] };
        if (alive) {
          setCaptures(json.data);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) timer = setTimeout(tick, 1000);
      }
    };

    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [paused]);

  const clearAll = async () => {
    await fetch("/api/inbox", { method: "DELETE" });
    setCaptures([]);
  };

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "2rem 1.5rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: "0.5rem",
        }}
      >
        <h1 style={{ fontSize: "1.25rem", margin: 0 }}>inbox</h1>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <span style={{ color: "#8f8f8f", fontSize: "0.875rem" }}>
            {captures.length} {captures.length === 1 ? "capture" : "captures"}
          </span>
          <button
            onClick={() => setPaused((p) => !p)}
            style={btnStyle}
            type="button"
          >
            {paused ? "▶ resume" : "⏸ pause"}
          </button>
          <button onClick={clearAll} style={btnStyle} type="button">
            clear
          </button>
        </div>
      </div>

      <p style={{ color: "#8f8f8f", marginTop: 0, fontSize: "0.875rem" }}>
        Point any mantis webhook at{" "}
        <code style={codeStyle}>{`{base-url}/inbox/<any-slug>`}</code> and
        captures will appear here live.
      </p>

      {error && (
        <div
          style={{
            background: "#7f1d1d",
            color: "#fecaca",
            padding: "0.75rem",
            borderRadius: 6,
            marginBottom: "1rem",
            fontSize: "0.875rem",
          }}
        >
          {error}
        </div>
      )}

      {captures.length === 0 && !error && (
        <div style={{ color: "#808080", textAlign: "center", padding: "3rem 0" }}>
          waiting for captures…
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        {captures.map((c) => (
          <CaptureCard key={c.id} capture={c} />
        ))}
      </div>
    </main>
  );
}

function CaptureCard({ capture }: { capture: Capture }) {
  const color = METHOD_COLORS[capture.method] ?? "#a3a3a3";
  return (
    <details style={cardStyle}>
      <summary
        style={{
          display: "flex",
          gap: "0.75rem",
          alignItems: "center",
          cursor: "pointer",
          padding: "0.625rem 0.875rem",
          listStyle: "none",
        }}
      >
        <span
          style={{
            color,
            fontWeight: 600,
            minWidth: "3.5rem",
            display: "inline-block",
          }}
        >
          {capture.method}
        </span>
        <span style={{ color: "#e5e5e5", flex: 1 }}>{capture.url}</span>
        <span style={{ color: "#8f8f8f", fontSize: "0.75rem" }}>
          {relative(capture.captured_at)}
        </span>
      </summary>
      <div
        style={{
          padding: "0 0.875rem 0.875rem",
          borderTop: "1px solid #262626",
          marginTop: "0.25rem",
        }}
      >
        <Section title="headers">
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <tbody>
              {Object.entries(capture.headers).map(([k, v]) => (
                <tr key={k}>
                  <td
                    style={{
                      color: "#a3a3a3",
                      padding: "0.125rem 0.75rem 0.125rem 0",
                      verticalAlign: "top",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {k}
                  </td>
                  <td
                    style={{
                      wordBreak: "break-all",
                      padding: "0.125rem 0",
                    }}
                  >
                    {v}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
        <Section title={capture.body_truncated ? "body (truncated)" : "body"}>
          <pre style={preStyle}>{formatBody(capture.body, capture.headers)}</pre>
        </Section>
      </div>
    </details>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: "0.75rem" }}>
      <div
        style={{
          color: "#8f8f8f",
          fontSize: "0.75rem",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: "0.25rem",
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function formatBody(body: string, headers: Record<string, string>): string {
  if (!body) return "(empty)";
  const ct = headers["content-type"] ?? "";
  if (ct.includes("application/json")) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
  return body;
}

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 1000) return "just now";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return new Date(iso).toLocaleString();
}

const btnStyle: React.CSSProperties = {
  background: "#262626",
  color: "#e5e5e5",
  border: "1px solid #404040",
  padding: "0.25rem 0.625rem",
  borderRadius: 4,
  fontSize: "0.75rem",
  cursor: "pointer",
  fontFamily: "inherit",
};

const codeStyle: React.CSSProperties = {
  background: "#171717",
  padding: "0.125rem 0.375rem",
  borderRadius: 3,
  color: "#fbbf24",
};

const cardStyle: React.CSSProperties = {
  background: "#171717",
  border: "1px solid #262626",
  borderRadius: 6,
  overflow: "hidden",
};

const preStyle: React.CSSProperties = {
  background: "#0a0a0a",
  border: "1px solid #262626",
  borderRadius: 4,
  padding: "0.75rem",
  margin: 0,
  fontSize: "0.8125rem",
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  color: "#e5e5e5",
};
