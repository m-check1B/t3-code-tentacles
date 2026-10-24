import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { releaseAssetUrl, RELEASE_SERVER, RELEASE_REPOSITORY } from "../../src/updater/release-source.mjs";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** GitHub is the only live provenance backend; tests use isolated fixtures. */
export function createGithubBackends({ spawnImpl = spawn, workDir, runChild, refuse, protectedBranch }) {
  workDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-signer-"));
  const mirror = path.join(workDir, "mirror.git");
  const git = (args) => runChild(spawnImpl, "git", ["--git-dir", mirror, ...args]);
  let fetched = false;
  return {
    workDir,
    async syncMirror() {
      if (!fs.existsSync(mirror)) await runChild(spawnImpl, "git", ["init", "--bare", "--quiet", mirror]);
      await git(["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "fetch", "--quiet", "--prune", `${RELEASE_SERVER}/${RELEASE_REPOSITORY}.git`, `+refs/heads/${protectedBranch}:refs/heads/${protectedBranch}`]);
      fetched = true;
    },
    async isAncestor(commit) {
      if (!fetched) refuse("mirror_not_synced");
      try { await git(["merge-base", "--is-ancestor", commit, `refs/heads/${protectedBranch}`]); return true; } catch { return false; }
    },
    async showFile(commit, file) { return (await git(["show", `${commit}:${file}`])).toString("utf8"); },
    async rebuildSha256(commit) {
      const build = fs.mkdtempSync(path.join(workDir, "rebuild-"));
      try {
        const archive = await git(["archive", "--format=tar", commit]);
        await runChild(spawnImpl, "tar", ["-x", "-f", "-", "-C", build], { input: archive });
        const name = (await runChild(spawnImpl, "npm", ["pack", "--ignore-scripts", "--silent"], { cwd: build })).toString("utf8").trim().split("\n").pop();
        if (!/^tentacles-[0-9A-Za-z.-]+\.tgz$/.test(name)) refuse("rebuild_failed");
        return sha256(fs.readFileSync(path.join(build, name)));
      } finally { fs.rmSync(build, { recursive: true, force: true }); }
    },
    async api(suffix) {
      const bytes = await runChild(spawnImpl, "gh", ["api", "--hostname", "github.com", `repos/${RELEASE_REPOSITORY}${suffix}`]);
      try { return JSON.parse(bytes.toString("utf8")); } catch { refuse("github_response_invalid"); }
    },
    async list(suffix, field = null) {
      const bytes = await runChild(spawnImpl, "gh", ["api", "--hostname", "github.com", "--paginate", "--slurp", `repos/${RELEASE_REPOSITORY}${suffix}`]);
      let pages;
      try { pages = JSON.parse(bytes.toString("utf8")); } catch { refuse("github_response_invalid"); }
      if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(field ? page?.[field] : page))) refuse("github_response_invalid");
      return pages.flatMap((page) => field ? page[field] : page);
    },
    async releaseAssetSha256(version) {
      const release = await this.api(`/releases/tags/v${version}`);
      if (!Number.isSafeInteger(release?.id) || release.id <= 0 || release.tag_name !== `v${version}` || release.draft !== false) refuse("release_asset_unavailable", version);
      const assets = await this.list(`/releases/${release.id}/assets?per_page=100`);
      const matching = assets.filter((asset) => asset?.name === `tentacles-${version}.tgz`);
      if (matching.length !== 1 || !Number.isSafeInteger(matching[0].id) || matching[0].id <= 0
        || matching[0].browser_download_url !== releaseAssetUrl(`v${version}`, `tentacles-${version}.tgz`)) refuse("release_asset_unavailable", version);
      const bytes = await runChild(spawnImpl, "gh", ["api", "--hostname", "github.com", "-H", "Accept: application/octet-stream", `repos/${RELEASE_REPOSITORY}/releases/assets/${matching[0].id}`]);
      return sha256(bytes);
    },
  };
}

