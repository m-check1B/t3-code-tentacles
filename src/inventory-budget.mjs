import { boundForPublish, MAX_PUBLISH_BYTES } from "./capabilities.mjs";

const INVENTORY_FIELDS = ["skillInventory", "pluginInventory", "capabilityInventory"];
const NATIVE_FIELDS = ["skillInventory", "pluginInventory"];
const FRAME_BYTES = 1024 * 1024;
// Reserve the rpc.result envelope, including the longest admitted request id.
const ENVELOPE_BYTES = 1024;
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

// Explicit null means unavailable, never an observed empty list. This is also
// the last-resort relay fallback when a caller supplies oversized metadata.
export function withoutDoctorInventories(reply) {
  const fields = INVENTORY_FIELDS.filter((field) => Object.hasOwn(reply, field));
  if (!fields.some((field) => reply[field] !== null)) return null;
  return { ...reply, ...Object.fromEntries(fields.map((field) => [field, null])) };
}

// Every optional inventory shares one UTF-8 allowance. Trim copies so a small
// relay frame cannot poison the cached observation or another doctor's reply.
export function boundDoctorInventories(reply, frameBytes = FRAME_BYTES) {
  const fields = INVENTORY_FIELDS.filter((field) => Object.hasOwn(reply, field));
  if (!fields.length) return reply;
  const result = { ...reply };
  const core = { ...reply, ...Object.fromEntries(fields.map((field) => [field, null])) };
  const budget = Math.max(0, Math.min(MAX_PUBLISH_BYTES, frameBytes - ENVELOPE_BYTES - bytes(core)));
  const native = {};
  const lists = [];
  for (const field of NATIVE_FIELDS.filter((field) => fields.includes(field))) {
    const block = reply[field];
    native[field] = block && { ...block, labs: block.labs.map((row) => {
      const key = field === "skillInventory" ? "skills" : "plugins";
      const copy = { ...row, [key]: [...row[key]] };
      lists.push({ row: copy, key });
      return copy;
    }) };
  }
  while (bytes(native) > budget) {
    const largest = lists.filter(({ row, key }) => row[key].length)
      .sort((a, b) => bytes(b.row[b.key]) - bytes(a.row[a.key]))[0];
    if (!largest) {
      for (const field of Object.keys(native)) native[field] = null;
      break;
    }
    const { row, key } = largest;
    row[key] = row[key].slice(0, Math.floor(row[key].length / 2));
    // count and digest still describe the full accepted source; dropped counts
    // rejected source entries, while truncated describes omitted wire entries.
    row.truncated = true;
  }
  Object.assign(result, native);
  if (fields.includes("capabilityInventory")) {
    const room = budget - bytes(native) - bytes({ capabilityInventory: null });
    result.capabilityInventory = reply.capabilityInventory ? boundForPublish(reply.capabilityInventory, Math.max(0, room)) : null;
  }
  // Metadata alone may not fit a caller's unusually small frame.
  const optional = Object.fromEntries(fields.map((field) => [field, result[field]]));
  if (bytes(optional) > budget) return withoutDoctorInventories(result) ?? result;
  return result;
}
