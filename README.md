# Patchback

Adds a **"Report a problem"** button to your site, and files reports **automatically** when a request fails (400+) or an uncaught error is thrown, no click needed. Reports arrive with the page, console errors, failed requests and recent clicks, get triaged by **Jev** (frontend / backend, severity, difficulty) and become GitHub issues. For frontend bugs Patchback posts a proposed fix; a teammate adds the `autofix` label to open a PR.

<p align="center"><img src="./docs/images/widget-overview.png" alt="The Patchback widget on desktop and mobile" width="900"></p>

The widget follows the page: Turkish pages get Turkish, everything else English, and a dark page gets the dark theme.

<p align="center"><img src="./docs/images/widget-form-en-dark.png" alt="Report form in English on a dark page" width="700"></p>

## Install

```bash
npx patchback init      # Next.js App Router: endpoint, button, config, workflow — one command
```

<p align="center"><img src="./docs/images/term-init.png" alt="npx patchback init" width="760"></p>
<p align="center"><sub>Keys and tokens show as • while you paste them and are written only to <code>.env.local</code>.</sub></p>

Without a GitHub token, reports show up in your dev server's terminal:

<p align="center"><img src="./docs/images/term-dev.png" alt="Reports printed in the dev server terminal" width="760"></p>

Works with any model provider (Gemini, Claude, OpenAI, OpenRouter, Ollama, or any OpenAI-compatible endpoint) as `provider:model`. No database or dashboard: GitHub is the infrastructure.

**📖 Full documentation (Turkish): [README_TR.md](./README_TR.md)**

## License

MIT
