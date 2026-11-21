import assert from "node:assert/strict";
import test from "node:test";
import { doctor } from "../src/bridge.mjs";
import { ANTIGRAVITY_SETUP_URL, t3SupportsAntigravity } from "../src/antigravity.mjs";
import { labName } from "../src/lab-names.mjs";
import { ORIGINATE_LABS, labKind, resolveModelSelection } from "../src/model-selection.mjs";

const fetchImpl = async () => { throw new Error("Synthetic Hermes is absent"); };
const MODELS = [
  { slug: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", isDefault: true },
  { slug: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
];

function client({ provider, enabled = true, version = "0.0.45" } = {}) {
  return {
    snapshot: async () => ({ projects: [], threads: [] }),
    getSettings: async () => ({ providers: { antigravity: { enabled } } }),
    rpc: async () => ({
      environment: { serverVersion: version },
      providers: provider ? [{ instanceId: "antigravity", driver: "antigravity", models: MODELS, ...provider }] : [],
    }),
  };
}

async function antigravityRow(options) {
  return (await doctor(client(options), { fetchImpl })).labs.find((lab) => lab.instanceId === "antigravity");
}

test("antigravity is an advertised native lab with its public name", () => {
  assert.equal(ORIGINATE_LABS.includes("antigravity"), true);
  assert.equal(labKind("antigravity"), "native");
  assert.equal(labName("antigravity"), "Antigravity (Gemini)");
  // No effort knob is invented: the thinking level is part of the model slug.
  assert.deepEqual(resolveModelSelection({ instanceId: "antigravity", model: "gemini-3.8-flash-high", budget: "high" }),
    { instanceId: "antigravity", model: "gemini-3.8-flash-high" });
});

test("signed-in antigravity is ready with the live default model", async () => {
  const row = await antigravityRow({ provider: { status: "ready", installed: true, auth: { status: "authenticated" } } });
  assert.equal(row.ready, true);
  assert.equal(row.code, null);
  assert.equal(row.signedIn, true);
  assert.equal(row.defaultModel, "gemini-3.8-flash-high");
  // KRA-9785: originate has no antigravity default, so the T3 default needs --model.
  assert.match(row.defaultSource, /^t3-/);
  assert.equal(row.action, `T3 ${row.defaultSource === "t3-marked" ? "marks" : "declares"} gemini-3.8-flash-high as the antigravity default, but originate without --model has no default for it; pass --model gemini-3.8-flash-high`);
});

test("installed antigravity with unchecked sign-in stays not ready despite cached models", async () => {
  const row = await antigravityRow({ provider: { status: "warning", installed: true, auth: { status: "unknown" } } });
  assert.equal(row.ready, false);
  assert.equal(row.code, "sign_in_unchecked");
  assert.equal(row.signedIn, null);
  assert.equal(row.status, "installed");
});

test("fresh install with no models yet asks for the Google sign-in", async () => {
  const c = client({ provider: { status: "warning", installed: true, auth: { status: "unknown" } } });
  const base = c.rpc;
  c.rpc = async () => { const config = await base(); config.providers[0].models = []; return config; };
  const row = (await doctor(c, { fetchImpl })).labs.find((lab) => lab.instanceId === "antigravity");
  assert.equal(row.ready, false);
  assert.equal(row.code, "sign_in_unchecked");
  assert.match(row.action, /Sign in with Google in T3 Code, or refresh/);
});

test("signed-out antigravity points to T3's own Google sign-in", async () => {
  const row = await antigravityRow({ provider: { status: "warning", installed: true, auth: { status: "unauthenticated" } } });
  assert.equal(row.ready, false);
  assert.equal(row.code, "not_signed_in");
  assert.equal(row.signedIn, false);
  assert.equal(row.setupUrl, ANTIGRAVITY_SETUP_URL);
  assert.match(row.action, /Sign in with Google in T3 Code/);
});

test("missing agent points to Install Antigravity even when T3 settings list the instance", async () => {
  const row = await antigravityRow({ provider: { status: "warning", installed: false, auth: { status: "unknown" } } });
  assert.equal(row.ready, false);
  assert.equal(row.installed, false);
  assert.equal(row.code, "not_installed");
  assert.match(row.action, /Install Antigravity in T3 Code/);
});

test("disabled antigravity asks to enable it in T3", async () => {
  const row = await antigravityRow({ enabled: false, provider: { status: "disabled", installed: false, auth: { status: "unknown" } } });
  assert.equal(row.code, "disabled");
  assert.match(row.action, /Enable Antigravity in T3 Code/);
});

test("T3 older than 0.0.43 asks for a T3 update instead of an install", async () => {
  const row = await antigravityRow({ version: "0.0.42" });
  assert.equal(row.ready, false);
  assert.equal(row.code, "t3_update_required");
  assert.match(row.action, /Update T3 Code to 0\.0\.43/);
  assert.equal(t3SupportsAntigravity("0.0.46-nightly.20261008.2833"), true);
  assert.equal(t3SupportsAntigravity("garbage"), null);
});

test("an agent error is reported as a provider error, never as ready", async () => {
  const row = await antigravityRow({ provider: { status: "error", installed: true, auth: { status: "authenticated" } } });
  assert.equal(row.ready, false);
  assert.equal(row.code, "provider_error");
});


test("unknown or absent authentication never becomes ready, including upstream ready", async () => {
  for (const auth of [undefined, {}, { status: "unknown" }, { status: "future-auth" }]) {
    const row = await antigravityRow({ provider: { status: "ready", installed: true, auth } });
    assert.equal(row.ready, false);
    assert.equal(row.signedIn, null);
    assert.equal(row.code, "sign_in_unchecked");
  }
});

test("authenticated lab still requires explicit ready, installed and a live model", async () => {
  for (const status of [undefined, "warning", "future-status"]) {
    const row = await antigravityRow({ provider: { status, installed: true, auth: { status: "authenticated" } } });
    assert.equal(row.ready, false);
    assert.equal(row.signedIn, true);
  }
  const row = await antigravityRow({ provider: { status: "ready", installed: "true", auth: { status: "authenticated" } } });
  assert.equal(row.installed, false);
  assert.equal(row.ready, false);
});

test("Antigravity never invents a default model from a fixed fallback", async () => {
  const c = client({ provider: { status: "ready", installed: true, auth: { status: "authenticated" } } });
  const rpc = c.rpc;
  c.rpc = async () => {
    const config = await rpc();
    config.providers[0].models = MODELS.map(({ isDefault, ...model }) => model);
    return config;
  };
  const row = (await doctor(c, { fetchImpl })).labs.find((lab) => lab.instanceId === "antigravity");
  assert.equal(row.defaultModel, null);
  assert.equal(row.ready, false);
  assert.equal(row.code, "default_model_unavailable");
});

// KRA-10863: T3 0.1.11's two repairable managed-runtime messages get their own code and fix.
const PREDATES = "Antigravity 1.20.3 predates the Antigravity CLI and no longer works with this T3 Code release. Update it in Antigravity setup.";
const CHANGED = "The managed Antigravity runtime changed on disk. Reinstall it in Antigravity setup.";
// B3 P3-2 on #100: a withdrawn managed release, same fix (AntigravityInstallation.ts:659 at v0.1.11).
const WITHDRAWN = "Antigravity 1.5.9 no longer works with this T3 Code release. Update it in Antigravity setup.";
for (const [message, installed, code, fix] of [
  [PREDATES, true, "runtime_update_required", /update it in T3 Code's Antigravity setup/],
  [WITHDRAWN, true, "runtime_update_required", /update it in T3 Code's Antigravity setup/],
  // T3 reports this one as a missing installation; it is still a repair, not an install.
  [CHANGED, false, "runtime_changed", /reinstall it in T3 Code's Antigravity setup/],
]) {
  test(`T3's repairable runtime message becomes ${code} with T3's setup link, never echoed`, async () => {
    for (const auth of ["authenticated", "unauthenticated", "unknown"]) {
      const row = await antigravityRow({ provider: { status: "error", installed, auth: { status: auth }, message: ` ${message} ` } });
      assert.equal(row.ready, false);
      assert.equal(row.code, code);
      assert.match(row.action, fix);
      assert.equal(row.action.endsWith(ANTIGRAVITY_SETUP_URL), true);
      assert.equal(JSON.stringify(row).includes(message), false);
    }
  });
}

test("a near miss of a repairable message stays a plain provider error", async () => {
  for (const message of [`${CHANGED} SECRET-CANARY`, PREDATES.replace("1.20.3", "1.20.3 /tmp/x"), CHANGED.toLowerCase(), WITHDRAWN.replace("1.5.9", "1.5.9 SECRET-CANARY")]) {
    const row = await antigravityRow({ provider: { status: "error", installed: true, auth: { status: "authenticated" }, message } });
    assert.equal(row.code, "provider_error");
    assert.equal(JSON.stringify(row).includes("SECRET-CANARY"), false);
  }
  const missing = await antigravityRow({ provider: { status: "error", installed: false, auth: { status: "unknown" }, message: `${CHANGED}x` } });
  assert.equal(missing.code, "not_installed");
});

test("after the runtime update, a signed-out Antigravity reaches not_signed_in", async () => {
  // T3 0.1.11 after a repair: installed, the Google session gone.
  const row = await antigravityRow({ provider: { status: "warning", installed: true, auth: { status: "unauthenticated" }, message: "Sign in with Google to use Antigravity." } });
  assert.equal(row.code, "not_signed_in");
  assert.equal(row.signedIn, false);
  assert.match(row.action, /^Sign in with Google in T3 Code: /);
});
