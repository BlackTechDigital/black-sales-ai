import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtemp,
  writeFile,
  mkdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildSiteArtifact,
  createArtifactZip,
  bytesSha256,
  canonicalJSON,
} from "../server/studio-site-artifact";
import {
  createSiteZip,
  EXPORT_FILE_NAMES,
  MAX_EXPORT_FILE_BYTES,
  crc32,
  validateExportName,
} from "../server/studio-zip";
import {
  renderSitePreview,
  renderSiteVisual,
} from "../server/studio-preview-renderer";
import { previewFixture } from "./fixtures/studio-preview";
const exec = promisify(execFile),
  folders: string[] = [];
const source = {
  id: "11111111-1111-4111-8111-111111111111",
  job_id: "22222222-2222-4222-8222-222222222222",
  number: 1,
  brief_version_id: "33333333-3333-4333-8333-333333333333",
  brief_hash: "a".repeat(64),
  document_hash: "b".repeat(64),
  created_at: "2026-10-31T12:00:00Z",
};
async function unpack() {
  const artifact = await buildSiteArtifact(previewFixture(), source),
    folder = await mkdtemp(join(tmpdir(), "black-sales-export-"));
  folders.push(folder);
  await mkdir(join(folder, "scripts"));
  for (const [name, data] of artifact.files)
    await writeFile(join(folder, name), data);
  return { artifact, folder };
}
afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});
describe("deterministic reviewed-site artifact and bounded ZIP", () => {
  it("reuses exactly the preview visual source, with no browser JavaScript or hidden external destinations", async () => {
    const doc = previewFixture(),
      artifact = await buildSiteArtifact(doc, source),
      decoder = new TextDecoder();
    const html = decoder.decode(artifact.files.get("index.html")),
      css = decoder.decode(artifact.files.get("styles.css"));
    expect(html.match(/<body[\s\S]*<\/body>/)?.[0]).toBe(
      renderSiteVisual(doc).body,
    );
    expect(html.match(/<body[\s\S]*<\/body>/)?.[0]).toBe(
      renderSitePreview(doc).html.match(/<body[\s\S]*<\/body>/)?.[0],
    );
    expect(css).toBe(renderSiteVisual(doc).css);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("https://example.com");
    expect(html).not.toContain("mailto:");
    expect(html).toContain('href="./styles.css"');
    expect([...artifact.files.keys()].sort()).toEqual(
      [...EXPORT_FILE_NAMES].sort(),
    );
    const text = [...artifact.files.values()]
      .map((v) => decoder.decode(v))
      .join("\n");
    for (const value of [
      "Contato privado sintético",
      "Nota privada sintética",
      source.job_id,
      source.brief_version_id,
      source.brief_hash,
      "SUPABASE_",
      "STUDIO_AI_API_KEY",
    ])
      expect(text).not.toContain(value);
  });
  it("produces byte-identical ZIPs across repeated renders, independent of runtime timestamps", async () => {
    const a = await buildSiteArtifact(previewFixture(), source),
      b = await buildSiteArtifact(previewFixture(), {
        ...source,
        created_at: "2027-01-01T00:00:00Z",
      });
    const x = await createArtifactZip(a),
      y = await createArtifactZip(b);
    expect(x.archiveHash).toBe(y.archiveHash);
    expect(x.zip).toEqual(y.zip);
    expect(a.artifactHash).toBe(b.artifactHash);
    const changed = previewFixture();
    changed.pages[0].sections[0].heading = "Outra composição sintética";
    expect((await buildSiteArtifact(changed, source)).artifactHash).not.toBe(
      a.artifactHash,
    );
  });
  it("records canonical SHA-256 and byte lengths for every non-manifest file without self-reference", async () => {
    const a = await buildSiteArtifact(previewFixture(), source),
      manifest = JSON.parse(
        new TextDecoder().decode(a.files.get("manifest.json")),
      );
    const { artifact_sha256, ...descriptor } = manifest;
    expect(artifact_sha256).toBe(
      await bytesSha256(new TextEncoder().encode(canonicalJSON(descriptor))),
    );
    expect(manifest.files).toHaveLength(EXPORT_FILE_NAMES.length - 1);
    for (const entry of manifest.files) {
      const bytes = a.files.get(entry.path)!;
      expect(entry.bytes).toBe(bytes.length);
      expect(entry.sha256).toBe(await bytesSha256(bytes));
    }
    expect(manifest.runtime).toEqual({
      node: "24.19.0",
      npm: "11.9.0",
      third_party_dependencies: [],
    });
    expect(
      JSON.parse(new TextDecoder().decode(a.files.get("package.json"))),
    ).toMatchObject({
      engines: { node: "24.19.0" },
      dependencies: {},
      devDependencies: {},
    });
  });
  it("creates a standard ZIP accepted by Python's independent zipfile/CRC implementation", async () => {
    const { artifact, folder } = await unpack(),
      archive = await createArtifactZip(artifact),
      file = join(folder, "test.zip");
    await writeFile(file, archive.zip);
    const checked = await exec("python3", [
      "-c",
      `import sys,json,zipfile,stat
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 for item in z.infolist():
  assert item.compress_type==zipfile.ZIP_STORED
  assert item.date_time==(1980,1,1,0,0,0)
  assert stat.S_ISREG(item.external_attr>>16)
  assert not ((item.external_attr>>16)&0o111)
 print(json.dumps(z.namelist()))`,
      file,
    ]);
    expect(JSON.parse(checked.stdout)).toEqual([...EXPORT_FILE_NAMES].sort());
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it.each([
    "../index.html",
    "/index.html",
    "C:\\index.html",
    "scripts\\serve.mjs",
    "scripts/../index.html",
    "index.html\0",
    "%2e%2e/index.html",
    "CON",
    "index.HTML",
    ".git/config",
  ])("rejects unsafe/uncontrolled archive path %s", (path) => {
    expect(() => validateExportName(path)).toThrow();
  });
  it("rejects incomplete inventories and bounded file/archive sizes", async () => {
    const { files } = await buildSiteArtifact(previewFixture(), source);
    const missing = new Map(files);
    missing.delete("styles.css");
    expect(() => createSiteZip(missing)).toThrow();
    const huge = new Map(files);
    huge.set("index.html", new Uint8Array(MAX_EXPORT_FILE_BYTES + 1));
    expect(() => createSiteZip(huge)).toThrow();
    const total = new Map(files);
    for (const name of ["index.html", "styles.css", "README.md"])
      total.set(name, new Uint8Array(MAX_EXPORT_FILE_BYTES));
    expect(() => createSiteZip(total)).toThrow();
  });
  it("runs the exported verifier locally without npm install and detects tampering", async () => {
    const { folder } = await unpack();
    const script = await readFile(join(folder, "scripts/verify.mjs"), "utf8");
    expect(script).toContain(["import", "meta", "url"].join("."));
    expect(script).not.toContain("file:///workspace");
    const ok = await exec(process.execPath, [
      join(folder, "scripts/verify.mjs"),
    ]);
    expect(ok.stdout).toContain("conferidos");
    await writeFile(join(folder, "styles.css"), "ALTERED");
    await expect(
      exec(process.execPath, [join(folder, "scripts/verify.mjs")]),
    ).rejects.toThrow();
  });
  it("rejects unexpected files and symlinks in the extracted local project", async () => {
    const { folder } = await unpack();
    await writeFile(join(folder, "unexpected.js"), "not allowed");
    await expect(
      exec(process.execPath, [join(folder, "scripts/verify.mjs")]),
    ).rejects.toThrow();
    await rm(join(folder, "unexpected.js"));
    await rm(join(folder, "styles.css"));
    await symlink(join(folder, "README.md"), join(folder, "styles.css"));
    await expect(
      exec(process.execPath, [join(folder, "scripts/verify.mjs")]),
    ).rejects.toThrow();
  });
  it("keeps the npm lock and runtime configuration controlled and dependency-free", async () => {
    const { folder } = await unpack();
    const lock = JSON.parse(
      await readFile(join(folder, "package-lock.json"), "utf8"),
    );
    expect(Object.keys(lock.packages)).toEqual([""]);
    expect(lock.lockfileVersion).toBe(3);
  });
});
