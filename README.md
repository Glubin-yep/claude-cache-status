# cache-status

A Claude Code mod: a band above the prompt showing prompt-cache hits and TTL, context window, rate limits and cost. `/cache` toggles between full and compact view.

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
