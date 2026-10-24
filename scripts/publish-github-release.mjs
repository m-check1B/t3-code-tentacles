import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { RELEASE_API, RELEASE_REPOSITORY, RELEASE_SERVER } from "../src/updater/release-source.mjs";

function gh(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { ...options, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("publication failed")));
  });
}

export async function publishRelease({ environment = process.env, cwd = process.cwd(), runGh = gh } = {}) {
  const tag = environment.GITHUB_REF_NAME;
  const filename = environment.BRIDGE_PACKAGE_FILE;
  const metadata = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  if ((environment.GITHUB_SERVER_URL ?? RELEASE_SERVER) !== RELEASE_SERVER
    || (environment.GITHUB_API_URL ?? RELEASE_API) !== RELEASE_API
    || environment.GITHUB_REPOSITORY !== RELEASE_REPOSITORY
    || (environment.GH_HOST && environment.GH_HOST !== "github.com")
    || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? "")
    || tag !== `v${metadata.version}` || metadata.name !== "tentacles"
    || filename !== `tentacles-${metadata.version}.tgz`) throw new Error("Invalid canonical GitHub release configuration");
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
    await runGh(["release", "create", tag, filename, `${filename}.sha256`,
      "--repo", `${RELEASE_SERVER}/${RELEASE_REPOSITORY}`, "--verify-tag", "--title", tag, "--notes-file", notesFile],
    { cwd, env: environment });
    return { tag, packageFile: filename, sha256: digest };
  } catch { throw new Error("GitHub release publication failed"); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await publishRelease())); }
  catch { console.error("GitHub release publication failed; no response body or credential is logged"); process.exitCode = 1; }
}
