import {
  CONFIG_PATH,
  type CliDefaults,
  getDefaults,
  setDefaults,
} from "../lib/config.js";
import { c, emit, fail } from "../lib/out.js";

// The settable default keys and their allowed values. Each maps to a field on
// the config `defaults` block, applied below explicit flags at startup.
const SETTINGS = {
  output: { values: ["table", "json", "wide"], desc: "default output mode" },
  color: { values: ["auto", "always", "never"], desc: "when to colorize output" },
} as const satisfies Record<string, { values: readonly string[]; desc: string }>;

type SettingKey = keyof typeof SETTINGS;

function isKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key);
}

function requireKey(key: string): SettingKey {
  if (!isKey(key)) {
    fail(
      `unknown config key '${key}'. Valid keys: ${Object.keys(SETTINGS).join(", ")}`,
    );
  }
  return key;
}

export async function configListCmd(): Promise<void> {
  const defaults = await getDefaults();
  emit(() => {
    process.stdout.write(`${c.dim("config:")} ${CONFIG_PATH}\n`);
    for (const key of Object.keys(SETTINGS) as SettingKey[]) {
      const value = defaults[key];
      process.stdout.write(
        `  ${key.padEnd(8)} ${value ? c.cyan(value) : c.dim("(unset)")}  ${c.dim(SETTINGS[key].desc)}\n`,
      );
    }
  }, { path: CONFIG_PATH, defaults });
}

export async function configGetCmd(key: string): Promise<void> {
  const k = requireKey(key);
  const value = (await getDefaults())[k];
  // Bare value on stdout so `$(mantis config get output)` works.
  emit(() => process.stdout.write((value ?? "") + "\n"), { [k]: value ?? null });
}

export async function configSetCmd(key: string, value: string): Promise<void> {
  const k = requireKey(key);
  const allowed = SETTINGS[k].values;
  if (!(allowed as readonly string[]).includes(value)) {
    fail(`'${value}' is not valid for ${k}. Choose one of: ${allowed.join(", ")}`);
  }
  await setDefaults({ [k]: value } as CliDefaults);
  emit(
    () => process.stderr.write(`${c.green("✓")} set ${k} = ${c.cyan(value)}\n`),
    { [k]: value },
  );
}

export async function configUnsetCmd(key: string): Promise<void> {
  const k = requireKey(key);
  await setDefaults({ [k]: undefined } as CliDefaults);
  emit(
    () => process.stderr.write(`${c.green("✓")} unset ${k}\n`),
    { [k]: null },
  );
}

export function configPathCmd(): void {
  emit(() => process.stdout.write(CONFIG_PATH + "\n"), { path: CONFIG_PATH });
}
