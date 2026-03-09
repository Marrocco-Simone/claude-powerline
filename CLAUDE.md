# Claude Code Instructions

This is a fork of [Owloops/claude-powerline](https://github.com/Owloops/claude-powerline) with an additional **rate limits segment** feature.

## Rate Limits Segment

The `rateLimits` segment displays Claude's 5-hour session and 7-day weekly usage percentages.

### Implementation Reference

This feature was implemented by referencing [CodexBar](https://github.com/codexbar/codexbar)'s Claude OAuth implementation. Key source files:

- **OAuth Usage Fetcher**: `Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthUsageFetcher.swift`
  - API endpoint: `https://api.anthropic.com/api/oauth/usage`
  - Beta header: `anthropic-beta: oauth-2025-04-20`
  - User-Agent: Must use `claude-code/<version>` format

- **OAuth Credentials**: `Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthCredentials.swift`
  - Credentials path: `~/.claude/.credentials.json` (key: `claudeAiOauth`)
  - Keychain service: `Claude Code-credentials`
  - Token refresh endpoint: `https://platform.claude.com/v1/oauth/token`
  - OAuth client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`

- **Version Detection**: `Sources/CodexBarCore/Providers/ProviderVersionDetector.swift`
  - Runs `claude --version` to get version for User-Agent

### Updating This Feature

When CodexBar updates their Claude OAuth implementation, check:

1. **API changes**: Look at `ClaudeOAuthUsageFetcher.swift` for endpoint or header changes
2. **Credential format changes**: Check `ClaudeOAuthCredentials.swift` for new fields
3. **Token refresh logic**: Check for changes to the OAuth flow

### Local Implementation

Our implementation is in `src/segments/rateLimits.ts`:
- `RateLimitsProvider.fetchFromOAuthAPI()` - Main API call
- `RateLimitsProvider.loadAccessTokenWithRefresh()` - Token loading with auto-refresh
- `RateLimitsProvider.refreshAccessToken()` - Token refresh logic
- `RateLimitsProvider.detectClaudeVersion()` - Version detection for User-Agent

## Development

```bash
# Type check
bun run types

# Build
bun run build

# Lint
bun run lint
```
