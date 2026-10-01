import { beforeEach, describe, expect, it, vi } from "vitest";
const fixtures = vi.hoisted(() => ({ context: vi.fn(), load: vi.fn(), write: vi.fn(), access: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/session", () => ({ getDashboardSession: fixtures.context, getSessionApiKey: vi.fn() }));
vi.mock("@/db/client", () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ limit: fixtures.load }) }) }),
  update: () => ({ set: (value: unknown) => ({ where: () => fixtures.write(value) }) }),
} }));
vi.mock("@/lib/auth", () => ({ canAccessKey: fixtures.access }));
vi.mock("@/lib/audit", () => ({ audit: fixtures.audit }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => ({ get: () => null }) }));
import { resetMonitorAction, setMonitorAction } from "@/app/(app)/keys/actions";

const scope = "a".repeat(64), id = "00000000-0000-4000-8000-000000000001";
function form(scopeValue: string | null = scope, windowInput = "120") {
  const data = new FormData(); data.set("id", id); data.set("monitor_mode", "window"); data.set("monitor_window_seconds", windowInput);
  if (scopeValue !== null) data.set("monitor_draft_scope", scopeValue);
  return data;
}
beforeEach(() => {
  vi.clearAllMocks();
  fixtures.context.mockResolvedValue({ apiKey: { id: "actor" }, draftScope: scope });
  fixtures.load.mockResolvedValue([{ id, createdByApiKeyId: "actor" }]);
  fixtures.access.mockReturnValue(true); fixtures.write.mockResolvedValue(undefined);
});

describe("monitor draft submission boundaries", () => {
  it.each([null, "b".repeat(64)])("rejects a missing or changed sign-in scope before save or reset", async (otherScope) => {
    expect((await setMonitorAction({}, form(otherScope))).error).toContain("sign-in changed");
    expect((await resetMonitorAction({}, form(otherScope))).error).toContain("sign-in changed");
    expect(fixtures.load).not.toHaveBeenCalled(); expect(fixtures.write).not.toHaveBeenCalled(); expect(fixtures.audit).not.toHaveBeenCalled();
  });
  it("applies only an explicitly submitted valid draft in the current session", async () => {
    expect(await setMonitorAction({}, form())).toEqual({ saved: true });
    expect(fixtures.write).toHaveBeenCalledExactlyOnceWith({ monitorMode: "window", monitorWindowSeconds: 120 });
  });
  it.each(["", "0", "120.5", "100000"])("keeps unfinished/invalid window input %j from mutating saved settings", async (windowInput) => {
    expect((await setMonitorAction({}, form(scope, windowInput))).error).toContain("30–86400");
    expect(fixtures.write).not.toHaveBeenCalled();
  });
  it("handles valid numeric-input exponent notation consistently", async () => {
    expect(await setMonitorAction({}, form(scope, "1e2"))).toEqual({ saved: true });
    expect(fixtures.write).toHaveBeenCalledWith({ monitorMode: "window", monitorWindowSeconds: 100 });
  });
  it("retains ownership checks after the scope matches", async () => {
    fixtures.access.mockReturnValue(false);
    expect((await setMonitorAction({}, form())).error).toBe("invalid key id");
    expect(fixtures.write).not.toHaveBeenCalled();
  });
  it("keeps dependency errors generic and does not mutate after authentication fails", async () => {
    fixtures.context.mockRejectedValue(new Error("private database credential"));
    const result = await setMonitorAction({}, form());
    expect(result.error).toContain("changes are still in the form");
    expect(result.error).not.toContain("private"); expect(fixtures.write).not.toHaveBeenCalled();
  });

  it("marks a database write failure as uncertain, unlike pre-write validation failures", async () => {
    fixtures.write.mockRejectedValueOnce(new Error("connection lost after submission"));
    expect(await setMonitorAction({}, form())).toMatchObject({ saveOutcomeUnknown: true });
    fixtures.write.mockClear();
    const invalid = await setMonitorAction({}, form(scope, "120.5"));
    expect(invalid.saveOutcomeUnknown).toBeUndefined();
    expect(fixtures.write).not.toHaveBeenCalled();
  });
});
