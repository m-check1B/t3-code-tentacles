// T3 binds its port before its auth service is ready: a cold start answers the
// websocket ticket with 503. Wait for a real answer with backoff (default ~60 s).
export async function waitForTicket(baseUrl, bearer, { deadlineMs = 60_000, firstWaitMs = 250, maxWaitMs = 4000 } = {}) {
  const seen = [];
  const readyBy = Date.now() + deadlineMs;
  for (let wait = firstWaitMs; ; wait = Math.min(wait * 2, maxWaitMs)) {
    const status = await fetch(`${baseUrl}/api/auth/websocket-ticket`, { method: "POST", headers: { authorization: `Bearer ${bearer}` } })
      .then((response) => response.status, () => null);
    seen.push(status);
    if ((status !== null && status !== 503) || Date.now() >= readyBy) return { status, attempts: seen.length, notReady: seen.filter((s) => s !== 200).length };
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
