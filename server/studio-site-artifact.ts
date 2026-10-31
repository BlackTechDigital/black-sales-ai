import type { SiteDocument } from "../shared/studio-sites";
import {
  siteVersionSummarySchema,
  type SiteVersionSummary,
} from "../shared/studio-generation";
import { renderSiteVisual, siteVisualHash } from "./studio-preview-renderer";
import { bytesSha256, textSha256 } from "./studio-digests";
export { bytesSha256 } from "./studio-digests";
import { createSiteZip, MAX_EXPORT_FILE_BYTES } from "./studio-zip";
import { SITE_EXPORT_MAX_BYTES } from "../shared/studio-export";
import {
  VERIFY_SCRIPT,
  SERVE_SCRIPT,
  EXPORT_README,
} from "./studio-export-tools";

export const EXPORT_PROFILE = "studio-static-v1";
export const canonicalJSON = (value: unknown): string => {
  if (Array.isArray(value))
    return "[" + value.map(canonicalJSON).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            canonicalJSON((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
};
export async function buildSiteArtifact(
  document: SiteDocument,
  source: SiteVersionSummary,
) {
  const version = siteVersionSummarySchema.parse(source),
    visual = renderSiteVisual(document);
  const cssHash = await textSha256(visual.css),
    integrity = btoa(
      String.fromCharCode(...cssHash.match(/../g)!.map((h) => parseInt(h, 16))),
    );
  const html =
    visual.head +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'self'; style-src-attr 'none'; img-src 'none'; font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; media-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="./styles.css" integrity="sha256-${integrity}" crossorigin="anonymous"></head>` +
    visual.body +
    "</html>";
  const pkg = {
    name: "black-sales-static-site",
    version: "1.0.0",
    private: true,
    type: "module",
    engines: { node: "24.19.0" },
    packageManager: "npm@11.9.0",
    scripts: {
      start: "node scripts/serve.mjs",
      verify: "node scripts/verify.mjs",
    },
    dependencies: {},
    devDependencies: {},
  };
  const lock = {
    name: pkg.name,
    version: pkg.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: pkg.name, version: pkg.version, engines: pkg.engines },
    },
  };
  const encoder = new TextEncoder(),
    files = new Map<string, Uint8Array>();
  for (const [name, text] of Object.entries({
    ".node-version": "24.19.0\n",
    "README.md": EXPORT_README,
    "index.html": html,
    "package.json": canonicalJSON(pkg) + "\n",
    "package-lock.json": canonicalJSON(lock) + "\n",
    "scripts/serve.mjs": SERVE_SCRIPT,
    "scripts/verify.mjs": VERIFY_SCRIPT,
    "styles.css": visual.css,
  }))
    files.set(name, encoder.encode(text));
  const entries = [];
  for (const [path, bytes] of [...files].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (bytes.byteLength > MAX_EXPORT_FILE_BYTES)
      throw new Error("Export file size limit");
    entries.push({
      path,
      bytes: bytes.byteLength,
      sha256: await bytesSha256(bytes),
    });
  }
  const descriptor = {
    schema_version: 1,
    profile: EXPORT_PROFILE,
    visual_sha256: await siteVisualHash(visual),
    source: {
      site_version_id: version.id,
      number: version.number,
      document_hash: version.document_hash,
    },
    runtime: { node: "24.19.0", npm: "11.9.0", third_party_dependencies: [] },
    files: entries,
  };
  const artifactHash = await textSha256(canonicalJSON(descriptor));
  files.set(
    "manifest.json",
    encoder.encode(
      canonicalJSON({ ...descriptor, artifact_sha256: artifactHash }) + "\n",
    ),
  );
  if (
    [...files.values()].reduce((n, v) => n + v.byteLength, 0) >
    SITE_EXPORT_MAX_BYTES
  )
    throw new Error("Export total limit");
  return {
    files,
    artifactHash,
    visualHash: descriptor.visual_sha256,
    source: version,
  };
}
export async function createArtifactZip(
  artifact: Awaited<ReturnType<typeof buildSiteArtifact>>,
) {
  const zip = createSiteZip(artifact.files);
  return { zip, archiveHash: await bytesSha256(zip) };
}
