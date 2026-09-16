# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project does

CLI tool (`ss`) for A/B test development at a marketing agency. It starts a local proxy that mirrors any live client website at `localhost:3000`, automatically injecting the developer's local JS/CSS into every page. A persistent `@playwright/cli` session runs against the proxy so an AI coding agent (Claude Code, Cursor, Copilot) can inspect the DOM (`ss snapshot` → YAML on disk) and drive the page (`ss click`, `ss fill`, `ss goto`) as it iterates on the test.

## Commands

```bash
node bin/ss.mjs new <test-name>       # scaffold a new test folder
node bin/ss.mjs connect <url>         # start proxy + watcher + CLI session, opens browser
node bin/ss.mjs snapshot              # AI: write DOM YAML to disk, print path
node bin/ss.mjs click <ref>           # AI: click by snapshot ref
node bin/ss.mjs fill <ref> <text>     # AI: fill input by snapshot ref
node bin/ss.mjs browser <...args>     # AI: raw passthrough to playwright-cli
node bin/ss.mjs build                 # bundle all tests to dist/ (minified)
npm run build                         # alias for ss build
```

After `npm link` or global install, use `ss` instead of `node bin/ss.mjs`.

## Architecture

```
bin/ss.mjs          CLI entry point (Commander subcommands, playwright-cli wrappers)
src/proxy.mjs       Express proxy server — mirrors live site, strips CSP, injects bundle
src/builder.mjs     esbuild watcher/bundler — outputs to dist/bundle.js
src/capture.mjs     One-shot viewport screenshots + page.md pointer
src/pw-fetcher.mjs  Stealth Playwright fetcher for Cloudflare-protected sites
src/scaffold.mjs    Copies tests/_template/ to a new test folder
tests/_template/    Boilerplate for new tests (IIFE pattern, CSS import)
dist/               Build output (gitignored)
.ss-config.json     Stores active test, target URL, cliSession between sessions (gitignored)
```

### How script injection works

The proxy intercepts HTML responses, strips `Content-Security-Policy` headers, and injects two things before `</body>`:
1. `<script src="/__ss__/bundle.js">` — the compiled test code (served from the same proxy, no CORS issue)
2. A livereload polling script that fetches `/__ss__/.reload` every second and refreshes the page when the timestamp changes (written by esbuild's `onEnd` plugin after each rebuild)

### CSS handling

Tests import CSS (`import './index.css'`) which is transformed by a custom esbuild plugin (`cssInjectorPlugin` in `src/builder.mjs`) into JS that injects a `<style>` tag — so the final output is always a single self-contained `.js` file.

### AI-agent flow (`@playwright/cli`)

`ss connect` boots a named CLI session (`ss-<projectBasename>`) via `playwright-cli -s=<name> open http://localhost:<port><targetPath> --persistent`. The session lives as a detached process pointed at the proxy, so it sees the injected variation. The AI iterates:

1. `ss snapshot` — writes an accessibility-tree YAML file, prints its path. Agent reads it on demand — snapshots do not accumulate in the model's context window.
2. Reference the `ref` IDs to call `ss click <ref>`, `ss fill <ref> <text>`, `ss goto <path>`, or `ss browser <...args>` for raw CLI subcommands (`state-save`, `type`, etc.).
3. Edit `tests/<name>/v1/variation.js` — esbuild rebuilds, proxy livereloads.
4. `ss snapshot` again to confirm the DOM change.

On `SIGINT`, `ss connect` runs `playwright-cli -s=<name> close` to tear the session down.

### Cloudflare bypass

`src/pw-fetcher.mjs` uses `playwright-extra` + stealth to fetch HTML through a real Chrome instance when bot protection is detected on the target. Cookies clear the challenge once and are reused for the session. The CLI browser talks to `localhost` only, so it needs no CF handling.

## Environment

No API keys required. The AI runs in the developer's IDE (Claude Code, Cursor, etc.) and drives the browser through `ss` wrapper commands.

## Key dependencies

- `express` + `http-proxy-middleware` — proxy server
- `esbuild` — bundler with watch mode
- `playwright` + `playwright-extra` + stealth plugin — Cloudflare bypass fetcher
- `@playwright/cli` — coding-agent browser interface (session, snapshot, click, fill)
- `commander` — CLI subcommand parsing
