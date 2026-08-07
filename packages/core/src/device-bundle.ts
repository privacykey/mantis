import JSZip from "jszip";
import type { DeviceBundleInput } from "./device-bundle-files.js";
import { buildDeviceBundleFiles } from "./device-bundle-files.js";

// The file-map logic lives in ./device-bundle-files so the CLI can import it
// without dragging jszip into its standalone binaries; this module adds only
// the zip the server serves as a download. Re-export the rest so server-side
// importers keep a single entry point.
export * from "./device-bundle-files.js";

export async function buildDeviceBundle(
  input: DeviceBundleInput,
): Promise<Buffer> {
  const bundle = buildDeviceBundleFiles(input);
  const zip = new JSZip();
  const dir = zip.folder(bundle.root);
  if (!dir) throw new Error("failed to create bundle root");

  for (const [path, content] of Object.entries(bundle.files)) {
    // 0o755 on the scripts so they're runnable straight out of the archive on
    // any extractor that preserves the mode (unzip, Finder, Nautilus).
    const executable =
      path === bundle.installScript || path === bundle.uninstallScript;
    dir.file(path, content, executable ? { unixPermissions: 0o755 } : {});
  }

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: input.os === "windows" ? "DOS" : "UNIX",
  });
}
