// One compiled release source; neither a server hint nor an environment value
// can redirect a device to a different host or repository.
export const RELEASE_REPOSITORY = "m-check1B/t3-code-tentacles-private";
export const RELEASE_SERVER = "https://github.com";
export const RELEASE_API = "https://api.github.com";
export const RELEASE_DOWNLOAD = `${RELEASE_SERVER}/${RELEASE_REPOSITORY}/releases/download`;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function requireReleaseBase(base) {
  if (base !== RELEASE_DOWNLOAD) throw new Error("Invalid canonical GitHub release source");
  return base;
}

export function releaseAssetUrl(tag, filename) {
  if (!((tag === "tentacles-manifest" && filename === "tentacles-manifest.json")
    || (typeof tag === "string" && tag.startsWith("v") && VERSION.test(tag.slice(1))
      && filename === `tentacles-${tag.slice(1)}.tgz`))) throw new Error("Invalid GitHub release asset");
  return `${RELEASE_DOWNLOAD}/${tag}/${filename}`;
}
