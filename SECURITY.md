# Security Policy

## Supported versions

Security fixes are applied to the latest released version. Version 0.1.0 is the
currently supported line.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not
open a public issue containing a working exploit, bearer token, private path,
provider configuration, or user prompt.

Include the affected version, impact, minimal reproduction, and any proposed
mitigation. You should receive an acknowledgement within five business days.

## Local trust model

This bridge is intended for one user's local machine. It accepts only loopback
T3/Hermes origins, reads a private T3 bearer from an owner-controlled `0600`
regular file, rejects redirects, and refuses to replace or remove a provider it
does not own. The macOS service and documented command/skill links also fail
closed on ownership collisions. It does not make T3 Code or Hermes remotely
accessible.

Treat Hermes profiles as privileged local processes: the bridge does not reduce
or expand the filesystem, shell, network, or tool permissions already granted to
the selected profile.
