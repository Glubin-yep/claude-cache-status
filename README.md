# cache-status

A Claude Code mod: a band above the prompt showing prompt-cache hits and TTL, context window, Claude rate limits, Codex rate limits and cost. `/cache` toggles between full and compact view.

## Codex limits

If the [Codex CLI](https://github.com/openai/codex) is installed, the band also shows its 5-hour and weekly limits. Codex writes a rate-limit snapshot to its session logs (`~/.codex/sessions/`, or `$CODEX_HOME/sessions`) on every turn; the mod reads the newest one once a minute. A window whose reset time has passed shows 0% until Codex writes a new snapshot. Large logs are tail-read through `pwsh`/`powershell` on Windows or `sh` elsewhere. Without Codex, those cells are left out.

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
