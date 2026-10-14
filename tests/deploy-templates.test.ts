import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Guards on the CI workflows and deployment templates. They are config, not
// code, so nothing else would notice if one of these properties regressed.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(ROOT, ".github/workflows");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "mantis-workflow-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * The `run:` bodies of a workflow file, de-indented. A small indentation
 * scanner rather than a YAML parser (none is a dependency here): a block
 * scalar ends at the first non-blank line indented no deeper than its key.
 */
function runBodies(text: string): string[] {
  const lines = text.split("\n");
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(- )?run:\s*(.*)$/.exec(lines[i]!);
    if (!match) continue;
    const keyIndent = match[1]!.length + (match[2] ? 2 : 0);
    const inline = match[3]!;
    if (inline && !/^[|>][+-]?\s*$/.test(inline)) {
      bodies.push(inline);
      continue;
    }
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() !== "" && line.length - line.trimStart().length <= keyIndent) break;
      block.push(line);
    }
    const indent = Math.min(
      ...block.filter((l) => l.trim() !== "").map((l) => l.length - l.trimStart().length),
    );
    bodies.push(block.map((l) => l.slice(indent)).join("\n"));
  }
  return bodies;
}

function bash(script: string, cwd: string, env: Record<string, string>) {
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    cwd,
    encoding: "utf8",
    // A clean environment: only what the step itself would be given.
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("GitHub workflows", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

  it("never interpolate ${{ }} expressions into a run: script", () => {
    // GitHub substitutes the expression text before the shell parses the
    // script, so a tag name, branch name, input or step output placed there
    // becomes shell syntax. Values must arrive through `env:`.
    expect(files.length).toBeGreaterThan(0);
    let scripts = 0;
    for (const file of files) {
      for (const body of runBodies(readFileSync(join(WORKFLOWS, file), "utf8"))) {
        scripts++;
        expect(body, `${file}: ${body.split("\n")[0]}`).not.toContain("${{");
      }
    }
    expect(scripts).toBeGreaterThan(10);
  });

  describe("cli-release.yml version handling", { timeout: 60_000 }, () => {
    const bodies = runBodies(read(".github/workflows/cli-release.yml"));
    const resolveStep = bodies.find((b) => b.includes("Three entry points"))!;
    const pinStep = bodies.find((b) => b.includes("export const CLI_VERSION"))!;

    function runResolve(env: { INPUT_TAG?: string; REF: string; REF_NAME: string }) {
      const dir = scratch();
      const out = join(dir, "github-output");
      writeFileSync(out, "");
      const result = bash(resolveStep, dir, { INPUT_TAG: "", ...env, GITHUB_OUTPUT: out });
      return { ...result, outputs: readFileSync(out, "utf8"), dir };
    }

    it("accepts a plain MAJOR.MINOR.PATCH tag", () => {
      const r = runResolve({ REF: "refs/tags/cli-v1.2.3", REF_NAME: "cli-v1.2.3" });
      expect(r.status).toBe(0);
      expect(r.outputs).toContain("version=1.2.3\n");
      expect(r.outputs).toContain("tag=cli-v1.2.3\n");
    });

    it.each([
      ["a tag name carrying shell syntax", { REF: 'refs/tags/cli-v9.9.9";echo${IFS}X>marker;true"', REF_NAME: 'cli-v9.9.9";echo${IFS}X>marker;true"' }],
      ["a dispatch input carrying shell syntax", { INPUT_TAG: 'cli-v9.9.9"; echo X > marker; true "', REF: "refs/tags/cli-v0.2.2", REF_NAME: "cli-v0.2.2" }],
      ["a dispatch input carrying TypeScript", { INPUT_TAG: 'cli-v9.9.9"; globalThis.x = "y', REF: "refs/tags/cli-v0.2.2", REF_NAME: "cli-v0.2.2" }],
      ["a multi-line dispatch input", { INPUT_TAG: "cli-v1.2.3\n::error::spoofed", REF: "refs/tags/cli-v0.2.2", REF_NAME: "cli-v0.2.2" }],
      ["a sed metacharacter", { INPUT_TAG: "cli-v1.2.3/e", REF: "refs/tags/cli-v0.2.2", REF_NAME: "cli-v0.2.2" }],
      ["a pre-release suffix", { REF: "refs/tags/cli-v1.2.3-beta.1", REF_NAME: "cli-v1.2.3-beta.1" }],
    ])("rejects %s before writing any output", (_label, env) => {
      const r = runResolve(env);
      expect(r.status).toBe(1);
      expect(r.outputs).toBe("");
      expect(existsSync(join(r.dir, "marker"))).toBe(false);
    });

    it("re-checks the version before writing it into program source", () => {
      const dir = scratch();
      mkdirSync(join(dir, "cli/src"), { recursive: true });
      const bad = bash(pinStep, dir, { RELEASE_VERSION: '9.9.9"; echo X > marker; true "' });
      expect(bad.status).toBe(1);
      expect(existsSync(join(dir, "cli/src/version.ts"))).toBe(false);
      expect(existsSync(join(dir, "marker"))).toBe(false);

      const good = bash(pinStep, dir, { RELEASE_VERSION: "1.2.3" });
      expect(good.status).toBe(0);
      expect(readFileSync(join(dir, "cli/src/version.ts"), "utf8")).toBe(
        'export const CLI_VERSION = "1.2.3";\n',
      );
    });
  });

  it("fly-deploy.yml only ever deploys main, through a GitHub environment", () => {
    const text = read(".github/workflows/fly-deploy.yml");
    // Every trigger, including workflow_dispatch from another ref, is gated.
    expect(text).toMatch(/^\s+if: .*github\.ref == 'refs\/heads\/main'/m);
    // The environment is what lets FLY_API_TOKEN be an environment secret
    // with a deployment-branch rule instead of a repository-wide secret.
    expect(text).toMatch(/^\s+environment: production$/m);
    expect(text).toMatch(/^\s+ref: \$\{\{ github\.sha \}\}$/m);
    expect(text).toContain("persist-credentials: false");
  });
});

describe("deployment templates", () => {
  it("docker-compose passes the Cloudflare tunnel token by environment, not argv", () => {
    const compose = read("docker-compose.yml");
    const command = /^\s+command: (tunnel .*)$/m.exec(compose)?.[1];
    // Process arguments are readable by every local account on the host.
    expect(command).toBe("tunnel --no-autoupdate run");
    expect(compose).toMatch(/^\s+TUNNEL_TOKEN: \$\{CLOUDFLARE_TUNNEL_TOKEN:-\}$/m);
  });

  it("pins the trusted client-IP header wherever proxy headers can be trusted", () => {
    // Without a pin mantis prefers CF-Connecting-IP, which none of these
    // ingresses strip — a client could forge its recorded IP.
    expect(read("docker-compose.yml")).toMatch(
      /^\s+TRUSTED_IP_HEADER: \$\{TRUSTED_IP_HEADER:-x-forwarded-for\}$/m,
    );

    const fly = read("deploy/fly.toml.example");
    expect(fly).toMatch(/^\s*TRUST_PROXY_HEADERS = "1"$/m);
    expect(fly).toMatch(/^\s*TRUSTED_IP_HEADER = "x-forwarded-for"$/m);

    const render = read("deploy/render.yaml.example");
    expect(render).toMatch(/- key: TRUST_PROXY_HEADERS\n\s+value: "1"/);
    expect(render).toMatch(/- key: TRUSTED_IP_HEADER\n\s+value: x-forwarded-for/);
  });

  it("checks a committed fly.toml for the pin on both Fly deploy paths", () => {
    const preflight = runBodies(read(".github/workflows/fly-deploy.yml")).find((b) =>
      b.includes("TRUST_PROXY_HEADERS"),
    );
    expect(preflight).toContain("grep -q 'TRUSTED_IP_HEADER' fly.toml");
    expect(read("deploy/fly-launch.sh")).toContain('grep -q "TRUSTED_IP_HEADER" fly.toml');
  });
});
