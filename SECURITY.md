# Security

Never post API keys, employee records, payroll files or OAuth state in an issue,
pull request, screenshot or log. Report a suspected vulnerability privately to
the repository owner through GitHub's private vulnerability reporting when it is
enabled; otherwise request a private contact without including sensitive details.

## Trust boundaries

- The MCP access token and the Buk API key are separate credentials.
- The Buk key is sent only in the `auth_token` header to a validated Buk tenant.
- Redirects are rejected. The model cannot choose an arbitrary destination URL.
- The official schema determines allowed operations and their parameters.
- Stdio and bearer deployments are isolated per tenant. OAuth binds every access
  token to one encrypted credential record and creates a new API client per request.
- OAuth uses PKCE, exact allowlisted redirect URIs, CSRF protection, short-lived
  access tokens and rotating refresh tokens. Protect and back up the master key
  separately from the encrypted data directory.
- Writes are disabled by default and unavailable in shared OAuth mode. A separate
  isolated deployment can enable them with `BUK_ALLOW_WRITES=true`.
- Buk permissions still apply. Create a dedicated key with the intended company,
  module and sensitive-data permissions; access is not expanded by this server.
- API results can contain untrusted text. Never treat record contents as
  instructions to the assistant.

The code has automated security regression tests, but that is not an independent
security audit. The included encrypted file store supports one server process;
see deployment guidance before operating a shared service.

The public repository and CI contain only synthetic fixtures and public source
data. Live verification reports must omit names, IDs, amounts, URLs identifying
customers, credentials and raw responses.
