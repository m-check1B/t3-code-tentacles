export function requireFreshFlags({ freshProviderContext, fixedTitle }) {
  for (const [name, value] of Object.entries({ freshProviderContext, fixedTitle })) {
    if (value !== undefined && typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  }
}

export function freshContextProviders(capabilities) {
  const providers = capabilities?.talkFreshProviderContextProviders;
  return capabilities?.talkTurnResult === "v1" && capabilities?.talkFreshProviderContext === "v1"
    && Array.isArray(providers) && providers.length > 0 && providers.length <= 32
    && providers.every((entry) => typeof entry === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(entry))
    && new Set(providers).size === providers.length ? providers : [];
}

export async function requireFreshProviderContext(client, { freshProviderContext, fixedTitle, instanceId }) {
  requireFreshFlags({ freshProviderContext, fixedTitle });
  if (freshProviderContext !== true && fixedTitle !== true) return;
  if (typeof instanceId !== "string" || !instanceId) throw new Error("Fresh provider context requires an explicit provider instance");
  if (typeof client.protocol === "function") await client.protocol();
  const capabilities = await client.request("/api/orchestration/turn-result");
  if (!freshContextProviders(capabilities).includes(instanceId)) throw new Error("Fresh provider context is unavailable for this provider");
}
