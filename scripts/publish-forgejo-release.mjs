import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export async function publishRelease({ environment = process.env, fetchImpl = globalThis.fetch, readFileImpl = fs.readFileSync } = {}) {
  const api = new URL(environment.FORGEJO_API_URL || environment.GITHUB_API_URL);
  const server = new URL(environment.FORGEJO_SERVER_URL || environment.GITHUB_SERVER_URL);
  const repository = environment.FORGEJO_REPOSITORY || environment.GITHUB_REPOSITORY;
  const tag = environment.FORGEJO_REF_NAME || environment.GITHUB_REF_NAME;
  const token = environment.BRIDGE_RELEASE_TOKEN;
  const filename = environment.BRIDGE_PACKAGE_FILE;
  if (!["http:", "https:"].includes(api.protocol) || api.origin !== server.origin || api.pathname.replace(/\/$/, "") !== "/api/v1"
    || api.username || api.password || api.search || api.hash
    || repository !== "matej/t3-code-tentacles" || !/^v\d+\.\d+\.\d+$/.test(tag || "")
    || !token || filename !== `tentacles-${tag.slice(1)}.tgz` || path.basename(filename) !== filename) {
    throw new Error("Invalid canonical Forgejo release configuration");
  }
  const packageData = readFileImpl(filename);
  const checksumData = readFileImpl(`${filename}.sha256`);
  const digest = createHash("sha256").update(packageData).digest("hex");
  if (checksumData.toString().trim() !== `${digest}  ${filename}`) throw new Error("Release checksum mismatch");
  const root = `${api.origin}/api/v1/repos/${repository}`;
  const request = async (suffix, options = {}, allowMissing = false) => {
    const response = await fetchImpl(`${root}${suffix}`, {
      ...options, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `token ${token}`, ...options.headers },
    });
    if (allowMissing && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Forgejo release request failed (${response.status})`); }
    return response.json();
  };
  let release = await request(`/releases/tags/${tag}`, {}, true);
  if (!release) release = await request("/releases", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tag_name: tag, name: tag, draft: false, prerelease: false,
      body: "KRA-6432: verified session termination, action help, resilient Node resolution, explicit command receipts and safe T3 reauthentication. Mini remains held. See CHANGELOG.md at this tag." }),
  });
  if (!Number.isSafeInteger(release.id) || release.id <= 0) throw new Error("Invalid Forgejo release identifier");
  for (const [name, data] of [[filename, packageData], [`${filename}.sha256`, checksumData]]) {
    // Never overwrite an existing immutable release asset implicitly.
    if (release.assets?.some(asset => asset.name === name)) throw new Error("Release asset already exists; inspect before retrying publication");
    const body = new FormData();
    body.append("attachment", new Blob([data]), name);
    await request(`/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, { method: "POST", body });
  }
  return { tag, packageFile: filename, sha256: digest, releaseId: release.id };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await publishRelease())); }
  catch { console.error("Forgejo release publication failed; no response body or credential is logged"); process.exitCode = 1; }
}
