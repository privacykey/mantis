import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(flyToml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mantis-fly-launch-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "deploy"), { recursive: true });
  mkdirSync(join(dir, "docker"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });

  copyFileSync(
    join(PROJECT_ROOT, "deploy/fly-launch.sh"),
    join(dir, "deploy/fly-launch.sh"),
  );
  copyFileSync(
    join(PROJECT_ROOT, "deploy/fly.toml.example"),
    join(dir, "deploy/fly.toml.example"),
  );
  writeFileSync(join(dir, "docker/Dockerfile"), "FROM scratch\n");
  if (flyToml !== undefined) writeFileSync(join(dir, "fly.toml"), flyToml);

  const flyctl = join(dir, "bin/flyctl");
  writeFileSync(
    flyctl,
    `#!/bin/sh
case "$1" in
  auth) echo "test@example.com" ;;
  version) echo "flyctl test" ;;
  status) exit 0 ;;
  secrets) echo "MANTIS_API_KEY_PEPPER test-digest" ;;
  deploy) exit 0 ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(flyctl, 0o755);
  return dir;
}

function config(publicBaseUrl?: string, includeProxy = true): string {
  const publicLine =
    publicBaseUrl === undefined
      ? ""
      : `  PUBLIC_BASE_URL = "${publicBaseUrl}"\n`;
  const proxyLine = includeProxy ? '  TRUST_PROXY_HEADERS = "1"\n' : "";
  return `app = "my-mantis"
primary_region = "iad"

[env]
${publicLine}${proxyLine}`;
}

function launch(dir: string) {
  const result = spawnSync(
    "bash",
    ["deploy/fly-launch.sh", "--app", "my-mantis", "--db", "none", "--yes"],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}${result.stderr}`,
  };
}

describe("deploy/fly-launch.sh PUBLIC_BASE_URL validation", () => {
  it("accepts the canonical URL for --app", () => {
    const result = launch(fixture(config("https://my-mantis.fly.dev")));

    expect(result.status).toBe(0);
    expect(result.output).toContain("mantis is live:  https://my-mantis.fly.dev");
  });

  it("rejects a different fly.dev app", () => {
    const result = launch(fixture(config("https://other-mantis.fly.dev")));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PUBLIC_BASE_URL points at a different Fly app");
    expect(result.stderr).toContain("expected:   https://my-mantis.fly.dev");
  });

  it("rejects a missing PUBLIC_BASE_URL", () => {
    const result = launch(fixture(config(undefined)));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has no quoted PUBLIC_BASE_URL");
  });

  it("rejects a non-HTTPS PUBLIC_BASE_URL", () => {
    const result = launch(fixture(config("http://my-mantis.fly.dev")));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be an absolute https:// URL");
  });

  it("allows an intentional custom HTTPS domain", () => {
    const result = launch(fixture(config("https://mantis.example.com")));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "custom PUBLIC_BASE_URL: https://mantis.example.com",
    );
  });

  it("keeps a missing proxy-header setting as a warning", () => {
    const result = launch(
      fixture(config("https://my-mantis.fly.dev", false)),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("has no TRUST_PROXY_HEADERS");
  });

  it("generates and validates the canonical URL on first launch", () => {
    const dir = fixture();
    const result = launch(dir);

    expect(result.status).toBe(0);
    expect(readFileSync(join(dir, "fly.toml"), "utf8")).toContain(
      'PUBLIC_BASE_URL = "https://my-mantis.fly.dev"',
    );
  });
});
