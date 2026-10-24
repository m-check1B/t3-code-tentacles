import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { RELEASE_API, RELEASE_REPOSITORY, RELEASE_SERVER } from "../src/updater/release-source.mjs";
import { MANIFEST_TAG } from "../src/updater/pinned.mjs";
import { assertPinnedKeys } from "./release/assert-pinned-keys.mjs";

function gh(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { ...options, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("publication failed")));
  });
}

function releasePlan({ environment, cwd, assets, publicKeys, log }) {
  const tag = environment.GITHUB_REF_NAME;
  const filename = environment.BRIDGE_PACKAGE_FILE;
  const metadata = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  if ((environment.GITHUB_SERVER_URL ?? RELEASE_SERVER) !== RELEASE_SERVER
    || (environment.GITHUB_API_URL ?? RELEASE_API) !== RELEASE_API
    || environment.GITHUB_REPOSITORY !== RELEASE_REPOSITORY
    || (environment.GH_HOST && environment.GH_HOST !== "github.com")
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version ?? "")
    || (tag !== MANIFEST_TAG && tag !== `v${metadata.version}`) || metadata.name !== "tentacles"
    || filename !== `tentacles-${metadata.version}.tgz`) throw new Error("Invalid canonical GitHub release configuration");
  const packageAssets = [filename, `${filename}.sha256`];
  if (assets !== undefined && !Array.isArray(assets)) throw new Error("Invalid release assets");
  const uploadAssets = Object.freeze([...(assets ?? packageAssets)]);
  // Only this exact package/checksum pair is exempt. Every other asset, even
  // an unfamiliar feed or detached-signature name, requires the unchanged gate.
  if (tag === MANIFEST_TAG || uploadAssets.length !== 2 || !packageAssets.every(asset => uploadAssets.includes(asset))) {
    assertPinnedKeys(publicKeys);
    log("pinned-keys gate: required, 2 configured (KRA-8371)");
  } else {
    log("pinned-keys gate: skipped, release publishes no signed manifest, feed or signature (KRA-8371)");
  }
  if (uploadAssets.length === 0 || new Set(uploadAssets).size !== uploadAssets.length
    || uploadAssets.some(asset => typeof asset !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset))) throw new Error("Invalid release assets");
  return { tag, filename, metadata, uploadAssets };
}

export async function publishRelease({ environment = process.env, cwd = process.cwd(), runGh = gh, assets, publicKeys, log = console.error } = {}) {
  const { tag, filename, metadata, uploadAssets } = releasePlan({ environment, cwd, assets, publicKeys, log });
  const payload = fs.readFileSync(path.join(cwd, filename));
  const checksum = fs.readFileSync(path.join(cwd, `${filename}.sha256`), "utf8");
  const digest = createHash("sha256").update(payload).digest("hex");
  if (checksum.trim() !== `${digest}  ${filename}`) throw new Error("Release checksum mismatch");
  const changelog = fs.readFileSync(path.join(cwd, "CHANGELOG.md"), "utf8");
  const sections = changelog.split(/(?=^## \[)/m);
  const notes = sections.find((section) => section.startsWith(`## [${metadata.version}]`));
  if (!notes?.trim()) throw new Error("Missing version entry in CHANGELOG.md");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-release-notes-"));
  const notesFile = path.join(temporary, "notes.md");
  try {
    fs.writeFileSync(notesFile, notes, { mode: 0o600 });
    // --verify-tag forbids gh from creating a missing tag. Existing releases
    // fail rather than overwriting their assets. Authentication stays in gh.
    await runGh(["release", "create", tag, ...uploadAssets,
      "--repo", `${RELEASE_SERVER}/${RELEASE_REPOSITORY}`, "--verify-tag", "--title", tag, "--notes-file", notesFile],
    { cwd, env: environment });
    return { tag, packageFile: filename, sha256: digest };
  } catch { throw new Error("GitHub release publication failed"); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--check-pinned-keys") {
      releasePlan({ environment: process.env, cwd: process.cwd(), log: console.log });
    } else if (args.length === 0) console.log(JSON.stringify(await publishRelease()));
    else throw new Error("Invalid publication arguments");
  }
  catch { console.error("GitHub release publication failed; no response body or credential is logged"); process.exitCode = 1; }
}
