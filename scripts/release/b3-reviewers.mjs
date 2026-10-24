// Forgejo account ids AND logins, reviewed with the signer. This initially
// delegates B3 receipt authority only to the Founder account. A writer using
// that account cannot approve its own PR or commit. Additional independent
// reviewer accounts require a reviewed source change; no env/CLI override.
export const B3_REVIEWERS = Object.freeze([
  Object.freeze({ id: 1, login: "matej" }),
]);
