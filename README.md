# cache-status

A Claude Code mod: a band above the prompt showing prompt-cache hits and TTL, context window, Claude rate limits, Codex rate limits and cost. `/cache` toggles between full and compact view.

## Codex limits

If [Codex](https://github.com/openai/codex) is installed and signed in with ChatGPT, the band also shows its 5-hour and weekly limits, once a minute.

- **From the server.** The mod asks `https://chatgpt.com/backend-api/wham/usage`, the endpoint the Codex app itself uses, with the login Codex keeps in `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`). These limits are account-wide, so they include use in the cloud, in ChatGPT and on other devices. The token is only read and sent to chatgpt.com; the mod never stores, logs or refreshes it (Codex refreshes it itself). The endpoint is undocumented and may change.
- **From the logs, as a fallback.** When the request fails (no ChatGPT login, an expired token, a changed API), the mod reads the newest rate-limit snapshot Codex wrote to its session logs (`~/.codex/sessions/`). Those only see use on this computer, and a window whose reset time has passed shows 0% until Codex writes a new snapshot. Large logs are tail-read through `pwsh`/`powershell` on Windows or `sh` elsewhere.

Without Codex, those cells are left out.

## Install

```
/plugin install cache-status --marketplace Glubin-yep/claude-cache-status
```

Answer `y` to add the marketplace, then pick a scope.

To load it in every session of a repository (including cloud sessions), add to that repository's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "claude-cache-status": { "source": { "source": "github", "repo": "Glubin-yep/claude-cache-status" } }
  },
  "enabledPlugins": { "cache-status@claude-cache-status": true }
}
```
