import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildDeviceBundle, bundleRootName } from "@mantis/core/device-bundle";
import { deviceMemo, getDeviceProfile } from "@mantis/core/device-profiles";
import { buildInstaller, type InstallType } from "@mantis/core/installers";

// The Windows alarms are Task Scheduler XML handed to `schtasks /create /xml`.
// None of this can be imported on a real Windows host from here, so these
// tests pin down what can be checked by specification: the file is well-formed
// XML whose declaration agrees with the bytes every writer emits, and it uses
// only element names (and the child order) of the Task Scheduler 1.2 schema.

const WINDOWS_TYPES = ["windows-logon", "windows-wake", "windows-network"] as const;

const input = {
  url: "https://mantis.example.com/c/AbCdEf2345?a=1&b='2'",
  keyId: "3f7c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8",
  memo: "pc01 — alarm",
};

type XmlNode = {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(s: string, where: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(s)) {
    throw new Error(`bare "&" in ${where}`);
  }
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (_, ref: string) => {
    if (ref.startsWith("#x")) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith("#")) return String.fromCodePoint(parseInt(ref.slice(1), 10));
    return ENTITIES[ref]!;
  });
}

/**
 * A strict well-formedness check for the subset of XML these templates use:
 * an optional declaration, then elements, attributes, text and the five
 * predefined entities. Anything else (comments, CDATA, DOCTYPE, a stray "<" or
 * "&", mismatched or unclosed tags, a second root) is an error.
 */
function parseXml(src: string): { declaration: Record<string, string> | null; root: XmlNode } {
  let pos = 0;
  let declaration: Record<string, string> | null = null;

  const attrs = (s: string, where: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const re = /\s+([A-Za-z_][\w.-]*)=(?:"([^"<]*)"|'([^'<]*)')/gy;
    let end = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      if (m[1]! in out) throw new Error(`duplicate attribute ${m[1]} in ${where}`);
      out[m[1]!] = decodeEntities(m[2] ?? m[3] ?? "", where);
      end = re.lastIndex;
    }
    if (s.slice(end).trim() !== "") throw new Error(`malformed attributes in ${where}`);
    return out;
  };

  const decl = /^<\?xml((?:\s+[A-Za-z]+=(?:"[^"]*"|'[^']*'))*)\s*\?>/.exec(src);
  if (decl) {
    declaration = attrs(decl[1]!, "the XML declaration");
    pos = decl[0].length;
  } else if (src.startsWith("<?")) {
    throw new Error("malformed XML declaration");
  }

  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const tag = /<(\/?)([A-Za-z_][\w.-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>/y;
  while (pos < src.length) {
    const top = stack[stack.length - 1]!;
    const lt = src.indexOf("<", pos);
    const text = src.slice(pos, lt < 0 ? src.length : lt);
    if (text.includes("]]>")) throw new Error("]]> in text");
    if (stack.length === 1) {
      if (text.trim() !== "") throw new Error("text outside the root element");
    } else {
      top.text += decodeEntities(text, `<${top.name}>`);
    }
    if (lt < 0) break;
    tag.lastIndex = lt;
    const m = tag.exec(src);
    if (!m) throw new Error(`malformed markup at offset ${lt}: ${src.slice(lt, lt + 40)}`);
    pos = tag.lastIndex;
    const [, closing, name, rawAttrs, selfClosing] = m;
    if (closing) {
      if (rawAttrs!.trim() !== "" || selfClosing) throw new Error(`malformed </${name}>`);
      if (stack.length === 1 || top.name !== name) {
        throw new Error(`</${name}> does not close <${top.name}>`);
      }
      stack.pop();
      continue;
    }
    if (stack.length === 1 && root.children.length > 0) throw new Error("second root element");
    const node: XmlNode = { name: name!, attrs: attrs(rawAttrs!, `<${name}>`), children: [], text: "" };
    top.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`unclosed <${stack[stack.length - 1]!.name}>`);
  if (root.children.length !== 1) throw new Error("no root element");
  return { declaration, root: root.children[0]! };
}

const child = (n: XmlNode, name: string) => n.children.find((c) => c.name === name);
const names = (n: XmlNode) => n.children.map((c) => c.name);

/**
 * Task Scheduler schema 1.2 (namespace …/windows/2004/02/mit/task): the
 * elements each parent may contain. Elements introduced by later schema
 * versions (1.3+: UseUnifiedSchedulingEngine, DisallowStartOnRemoteAppSession,
 * ProcessTokenSidType, RequiredPrivileges, …) are deliberately absent — the
 * templates declare version="1.2".
 */
const TRIGGER_BASE = ["Enabled", "StartBoundary", "EndBoundary", "Repetition", "ExecutionTimeLimit"];
const SCHEMA: Record<string, string[]> = {
  Task: ["RegistrationInfo", "Triggers", "Principals", "Settings", "Data", "Actions"],
  RegistrationInfo: [
    "URI", "SecurityDescriptor", "Source", "Date", "Author", "Version", "Description", "Documentation",
  ],
  Triggers: [
    "BootTrigger", "RegistrationTrigger", "IdleTrigger", "TimeTrigger", "EventTrigger",
    "LogonTrigger", "SessionStateChangeTrigger", "CalendarTrigger",
  ],
  LogonTrigger: [...TRIGGER_BASE, "UserId", "Delay"],
  EventTrigger: [
    ...TRIGGER_BASE, "Subscription", "Delay", "PeriodOfOccurrence", "NumberOfOccurrences",
    "MatchingElement", "ValueQueries",
  ],
  Principals: ["Principal"],
  Principal: ["UserId", "LogonType", "GroupId", "DisplayName", "RunLevel"],
  Settings: [
    "AllowStartOnDemand", "RestartOnFailure", "MultipleInstancesPolicy",
    "DisallowStartIfOnBatteries", "StopIfGoingOnBatteries", "AllowHardTerminate",
    "StartWhenAvailable", "NetworkProfileName", "RunOnlyIfNetworkAvailable", "WakeToRun",
    "Enabled", "Hidden", "DeleteExpiredTaskAfter", "IdleSettings", "NetworkSettings",
    "ExecutionTimeLimit", "Priority", "RunOnlyIfIdle",
  ],
  Actions: ["Exec", "ComHandler", "SendEmail", "ShowMessage"],
  Exec: ["Command", "Arguments", "WorkingDirectory"],
};
/** Elements whose content is text, not further elements. */
const LEAVES = new Set([
  "Author", "Description", "Enabled", "Subscription", "UserId", "GroupId", "RunLevel",
  "MultipleInstancesPolicy", "DisallowStartIfOnBatteries", "StopIfGoingOnBatteries", "Hidden",
  "ExecutionTimeLimit", "Command", "Arguments",
]);
const BOOLEANS = [
  "Enabled", "DisallowStartIfOnBatteries", "StopIfGoingOnBatteries", "Hidden",
];

function assertSchemaNames(node: XmlNode, path: string): void {
  if (LEAVES.has(node.name)) {
    expect(node.children, `${path} must not contain elements`).toEqual([]);
    return;
  }
  const allowed = SCHEMA[node.name];
  expect(allowed, `${path} is not an element this test knows from the task schema`).toBeTruthy();
  for (const c of node.children) {
    expect(allowed, `<${c.name}> is not a child of <${node.name}> in the task schema`).toContain(c.name);
    assertSchemaNames(c, `${path}/${c.name}`);
  }
}

function task(type: InstallType) {
  const installer = buildInstaller(type, input);
  return { installer, ...parseXml(installer.content) };
}

/** Seconds in the PTnHnMnS durations these templates use. */
function seconds(duration: string): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration);
  expect(m, `unexpected duration ${duration}`).toBeTruthy();
  return Number(m![1] ?? 0) * 3600 + Number(m![2] ?? 0) * 60 + Number(m![3] ?? 0);
}

describe("the test's XML checker", () => {
  it("accepts well-formed XML and rejects the usual breakage", () => {
    expect(parseXml(`<?xml version="1.0"?>\n<a x="1"><b>t &amp; u</b><c/></a>\n`).root.children).toHaveLength(2);
    for (const bad of [
      `<a><b></a></b>`,
      `<a>`,
      `<a></a><b></b>`,
      `<a>x & y</a>`,
      `<a x=1></a>`,
      `<a x="<"></a>`,
      `text<a></a>`,
      `<a><!-- c --></a>`,
      `<?xml version="1.0"?<a></a>`,
    ]) {
      expect(() => parseXml(bad), bad).toThrow();
    }
  });
});

describe.each(WINDOWS_TYPES)("%s task XML", (type) => {
  it("is well-formed and declares no encoding its bytes could contradict", () => {
    const { installer, declaration } = task(type);
    // No encoding pseudo-attribute: the file is then UTF-8 by default (or
    // UTF-16 if a tool re-saves it with a BOM), which is what every writer —
    // writeFile, a Response body, the zip — produces from this string.
    expect(declaration).toEqual({ version: "1.0" });
    expect(installer.content.startsWith('<?xml version="1.0"?>\n')).toBe(true);
    expect(installer.content).not.toMatch(/encoding\s*=/i);
    expect(installer.content).not.toContain("UTF-16");

    const bytes = Buffer.from(installer.content, "utf8");
    // No BOM, no NULs: plain UTF-8 that round-trips to the same text.
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("<?xml");
    expect(bytes.includes(0)).toBe(false);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(installer.content);
    // For an ASCII URL the whole file is ASCII, so it reads the same under
    // UTF-8, any ANSI code page, or widened to UTF-16 by the importing tool.
    expect(installer.content).toMatch(/^[\x0a\x20-\x7e]*$/);
  });

  it("uses only Task Scheduler 1.2 element names, in export order", () => {
    const { root } = task(type);
    expect(root.name).toBe("Task");
    expect(root.attrs).toEqual({
      version: "1.2",
      xmlns: "http://schemas.microsoft.com/windows/2004/02/mit/task",
    });
    expect(names(root)).toEqual([
      "RegistrationInfo",
      "Triggers",
      "Principals",
      "Settings",
      "Actions",
    ]);
    assertSchemaNames(root, "Task");

    // The schema declares these children with xs:all (any order), but the
    // templates keep the order Task Scheduler itself writes on export, so
    // they would also satisfy an importer that expects a sequence.
    const inExportOrder = (parent: XmlNode, order: string[]) => {
      const idx = names(parent).map((n) => order.indexOf(n));
      expect(idx, `<${parent.name}> children`).toEqual([...idx].sort((a, b) => a - b));
      expect(idx).not.toContain(-1);
    };
    inExportOrder(child(root, "Settings")!, [
      "MultipleInstancesPolicy", "DisallowStartIfOnBatteries", "StopIfGoingOnBatteries",
      "AllowHardTerminate", "StartWhenAvailable", "RunOnlyIfNetworkAvailable", "IdleSettings",
      "AllowStartOnDemand", "Enabled", "Hidden", "RunOnlyIfIdle", "WakeToRun",
      "ExecutionTimeLimit", "Priority",
    ]);
    inExportOrder(child(root, "Principals")!.children[0]!, [
      "UserId", "LogonType", "GroupId", "RunLevel",
    ]);
    inExportOrder(child(root, "Triggers")!.children[0]!, ["Enabled", "Subscription", "Delay"]);
    inExportOrder(child(child(root, "Actions")!, "Exec")!, ["Command", "Arguments", "WorkingDirectory"]);

    // The cmdlet switch names are not schema elements.
    const { installer } = task(type);
    expect(installer.content).not.toMatch(/AllowStartIfOnBatteries|DontStopIfGoingOnBatteries/);
  });

  it("keeps running on battery, with schema-typed values", () => {
    const settings = child(task(type).root, "Settings")!;
    expect(child(settings, "DisallowStartIfOnBatteries")!.text).toBe("false");
    expect(child(settings, "StopIfGoingOnBatteries")!.text).toBe("false");
    for (const b of BOOLEANS) {
      const el = child(settings, b);
      if (el) expect(el.text, b).toMatch(/^(true|false)$/);
    }
    const policy = child(settings, "MultipleInstancesPolicy");
    if (policy) expect(policy.text).toMatch(/^(Parallel|Queue|IgnoreNew|StopExisting)$/);
    expect(seconds(child(settings, "ExecutionTimeLimit")!.text)).toBeGreaterThan(0);
  });

  it("binds the action to an explicit principal", () => {
    const { root } = task(type);
    const principals = child(root, "Principals")!;
    expect(names(principals)).toEqual(["Principal"]);
    const principal = principals.children[0]!;
    expect(child(root, "Actions")!.attrs.Context).toBe(principal.attrs.id);
    expect(child(principal, "RunLevel")!.text).toBe("LeastPrivilege");

    const bound = principal.children.filter((c) => c.name === "UserId" || c.name === "GroupId");
    expect(bound, "exactly one of UserId / GroupId").toHaveLength(1);
    // No stored credential: neither principal needs a LogonType or password.
    expect(child(principal, "LogonType")).toBeUndefined();
  });

  it("round-trips the trigger URL through XML escaping", () => {
    const exec = child(child(task(type).root, "Actions")!, "Exec")!;
    expect(child(exec, "Command")!.text).toBe("powershell.exe");
    // The URL has a quote in it; PowerShell doubles it inside '…'.
    expect(child(exec, "Arguments")!.text).toContain(
      "-Uri 'https://mantis.example.com/c/AbCdEf2345?a=1&b=''2'''",
    );
  });
});

describe("windows task principals", () => {
  it("logon runs as BUILTIN\\Users, in the session of whoever logs on", () => {
    const { root, installer } = task("windows-logon");
    const principal = child(root, "Principals")!.children[0]!;
    expect(child(principal, "GroupId")!.text).toBe("S-1-5-32-545");
    expect(child(principal, "UserId")).toBeUndefined();
    // An any-user trigger: no UserId narrowing it to one account.
    const trigger = child(child(root, "Triggers")!, "LogonTrigger")!;
    expect(names(trigger)).toEqual(["Enabled"]);
    // The action reports the account it runs as — the one that logged on.
    expect(installer.content).toContain("$env:USERNAME");
    // Two people logging on moments apart are two events.
    expect(child(child(root, "Settings")!, "MultipleInstancesPolicy")!.text).toBe("Parallel");
  });

  it.each(["windows-wake", "windows-network"] as const)(
    "%s runs as LOCAL SERVICE, with nobody logged on",
    (type) => {
      const { root, installer } = task(type);
      const principal = child(root, "Principals")!.children[0]!;
      expect(child(principal, "UserId")!.text).toBe("S-1-5-19");
      expect(child(principal, "GroupId")).toBeUndefined();
      // A service account is not a person; don't report it as the user.
      expect(installer.content).not.toContain("X-Mantis-User");
      expect(installer.content).toContain("$env:COMPUTERNAME");
    },
  );
});

describe("windows-wake retry", () => {
  it("retries a bounded number of times and fits inside the time limit", () => {
    const { root } = task("windows-wake");
    const args = child(child(child(root, "Actions")!, "Exec")!, "Arguments")!.text;
    const loop = /foreach \(\$wait in ([\d,]+)\) \{ Start-Sleep -Seconds \$wait; try \{ .*-TimeoutSec (\d+) \| Out-Null; break \} catch \{\} \}/.exec(args);
    expect(loop, args).toBeTruthy();
    const waits = loop![1]!.split(",").map(Number);
    expect(waits).toEqual([0, 5, 10, 15, 20]);
    // A literal list, not a while/until: the loop cannot run away.
    expect(args).not.toMatch(/\b(while|until|for)\s*\(/);
    const worstCase = waits.reduce((a, b) => a + b, 0) + waits.length * Number(loop![2]);
    const limit = seconds(child(child(root, "Settings")!, "ExecutionTimeLimit")!.text);
    expect(limit).toBeGreaterThan(worstCase);
    // The whole command sits inside -Command "…": it must not contain a quote.
    const command = /-Command "(.*)"$/.exec(args);
    expect(command, args).toBeTruthy();
    expect(command![1]).not.toContain('"');
  });

  it("leaves the steady-state alarms as a single attempt", () => {
    for (const type of ["windows-logon", "windows-network"] as const) {
      const { root } = task(type);
      const args = child(child(child(root, "Actions")!, "Exec")!, "Arguments")!.text;
      expect(args, type).not.toMatch(/foreach|Start-Sleep/);
      expect(child(child(root, "Settings")!, "ExecutionTimeLimit")!.text).toBe("PT30S");
    }
  });
});

describe("windows device bundle", () => {
  it("ships each task XML byte-for-byte as UTF-8 with no BOM", async () => {
    const vectors = getDeviceProfile("windows").vectors.map((vector, i) => {
      const keyId = `${input.keyId.slice(0, 35)}${i}`;
      const memo = deviceMemo("pc01", vector);
      return {
        vector,
        key: { id: keyId, publicId: `pub${i}`, memo },
        installer: buildInstaller(vector.installType, { url: input.url, keyId, memo }),
      };
    });
    const zip = await JSZip.loadAsync(
      await buildDeviceBundle({ deviceName: "pc01", os: "windows", vectors }),
    );
    const root = bundleRootName("pc01", "windows");
    for (const bv of vectors) {
      const entry = zip.file(`${root}/vectors/${bv.vector.slug}/${bv.installer.filename}`);
      expect(entry, bv.installer.filename).toBeTruthy();
      const bytes = Buffer.from(await entry!.async("uint8array"));
      expect(bytes.equals(Buffer.from(bv.installer.content, "utf8"))).toBe(true);
      expect(bytes.subarray(0, 21).toString("latin1")).toBe('<?xml version="1.0"?>');
      expect(() => parseXml(bytes.toString("utf8"))).not.toThrow();
    }
  });
});
