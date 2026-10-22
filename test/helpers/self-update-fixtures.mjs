// KRA-8371 test fixtures: EPHEMERAL Ed25519 keys generated per test run, a
// minimal ustar writer, and a synthetic release server. Neutral names only.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { gzipSync } from "node:zlib";
import { ENVELOPE_SCHEMA, keyId } from "../../src/updater/manifest.mjs";

export function ephemeralKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return { publicKey, privateKey, raw: raw.toString("base64"), id: keyId(raw) };
}

export function signEnvelope(manifest, key) {
  const payload = Buffer.from(JSON.stringify(manifest));
  return Buffer.from(JSON.stringify({
    schema: ENVELOPE_SCHEMA,
    payload: payload.toString("base64"),
    signatures: [{ keyId: key.id, sig: sign(null, payload, key.privateKey).toString("base64") }],
  }));
}

function field(header, offset, length, value) {
  header.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}

export function tarEntry({ name, type = "0", data = Buffer.alloc(0), linkname = "", mode = 0o644 }) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = Buffer.alloc(512, 0);
  field(header, 0, 100, name);
  field(header, 100, 8, `${mode.toString(8).padStart(7, "0")}\0`);
  field(header, 108, 8, "0000000\0");
  field(header, 116, 8, "0000000\0");
  field(header, 124, 12, `${body.length.toString(8).padStart(11, "0")}\0`);
  field(header, 136, 12, "00000000000\0");
  header.fill(0x20, 148, 156);
  field(header, 156, 1, type);
  field(header, 157, 100, linkname);
  field(header, 257, 6, "ustar\0");
  field(header, 263, 2, "00");
  let sum = 0;
  for (const byte of header) sum += byte;
  field(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
  return Buffer.concat([header, body, padding]);
}

export function tgz(entries) {
  return gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024, 0)]));
}

export function packageTgz(version, extra = []) {
  return tgz([
    { name: "package/", type: "5", mode: 0o755 },
    { name: "package/package.json", data: JSON.stringify({ name: "tentacles", version }) },
    { name: "package/bin/", type: "5", mode: 0o755 },
    { name: "package/bin/t3-agent-bridge", data: "#!/bin/sh\nexit 0\n", mode: 0o755 },
    ...extra,
  ]);
}

export const RPC = ["seats", "originate", "continue", "doctor-status", "turn-result", "thread-events", "thread-artifact"];

export function entryFor(version, bytes, overrides = {}) {
  return {
    version,
    commit: createHash("sha1").update(version).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    legacyRpc: RPC,
    t3Contract: "t3-0.0.42",
    minDesktop: null,
    minApi: null,
    needs: [],
    changelog: `Synthetic build ${version}`,
    ...overrides,
  };
}

export function manifestOf({ serial = 2, expires, versions, securityFloor, recommended }) {
  return { schema: "tentacles-manifest/v1", serial, expires, versions, securityFloor, recommended };
}

/** A fetch that serves only what the test registered; everything else is 404. */
export function releaseServer(baseUrl) {
  const routes = new Map();
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (!routes.has(url)) return new Response("missing", { status: 404 });
    return new Response(routes.get(url));
  };
  return {
    fetchImpl,
    requests,
    manifest(bytes) { routes.set(`${baseUrl}/tentacles-manifest/tentacles-manifest.json`, bytes); },
    artifact(version, bytes) { routes.set(`${baseUrl}/v${version}/tentacles-${version}.tgz`, bytes); },
  };
}
