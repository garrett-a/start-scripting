# start-scripting

Local dev tool for building A/B tests on live websites. Write test code in your IDE, see it run on the live site instantly, and let your AI agent drive the mirrored page directly through the terminal.

## How it works

1. `ss connect <url>` starts a proxy at `localhost:3000` that mirrors any live site (including Cloudflare-protected ones).
2. Your local JS/CSS is auto-injected into every page. Save → rebuild → refresh.
3. `ss connect` also boots a persistent `@playwright/cli` browser session pointed at the proxy, so your AI agent can inspect and drive the page from the command line.
4. Three viewport screenshots (`desktop.png`/`tablet.png`/`mobile.png`) are captured on connect for visual reference.

## Install

Requires [Node.js](https://nodejs.org) v18+.

```bash
git clone https://github.com/garrett-a/start-scripting.git ~/.ss
cd ~/.ss
npm install
npm link
```

This installs the `ss` command globally. The first time you run `ss connect`, Chromium will be downloaded automatically (~100MB, one-time).

## Quickstart

```bash
cd ~/projects/client-site/

ss connect https://client-site.com --test homepage-hero
# → probes for bot protection
# → starts proxy at localhost:3000
# → captures screenshots to ss-context/
# → boots the CLI browser session
# → prompts: "Take a snapshot now for AI DOM inspection? [Y/n]"
# → opens the site in your browser and starts esbuild in watch mode
```

Edit `tests/homepage-hero/v1/variation.js` — the page refreshes on every save.

## AI-assisted development

The tool is designed around a coding-agent-in-terminal workflow (Claude Code, Cursor, Copilot, etc.). Instead of dumping a static HTML dump into a context file, the agent drives a live browser session with these wrappers:

```
ss snapshot           Write an accessibility-tree YAML snapshot to disk. Prints the file path.
ss click <ref>        Click by ref from the latest snapshot.
ss fill <ref> <text>  Fill an input by ref.
ss goto <path>        Navigate the CLI browser to a new path on the proxy.
ss browser <...args>  Raw passthrough to playwright-cli (type, hover, select, press, eval, ...).
ss dash               Open the live CLI session dashboard.
```

`ss connect` prints a **kickoff prompt** on completion. Paste it into your agent, fill in what you're building, and go:

> Read the latest file in `.playwright-cli/page-*.yml` to see the DOM. My variation code goes in `tests/homepage-hero/v1/variation.js` and CSS in `index.css` next to it. From here, I want to \[build a sticky announcement bar\].

The loop the agent uses is `snapshot → find ref → act → snapshot → verify`. Refs are ephemeral (they change every snapshot), so the agent always snapshots fresh before acting.

**A few flags worth knowing:**

- `ss connect <url> -s` — skip the prompt and always snapshot after boot.
- `ss connect <url> --no-snapshot` — skip the prompt and never snapshot.
- Non-TTY invocations (`nohup`, CI, piped) skip the prompt silently.

**Can the agent run `ss capture` or `ss variation`?** Yes — every `ss` subcommand is available to the agent. Common ones the agent might reach for:

- `ss capture` — regenerate screenshots after the site content changed.
- `ss variation` — spin up a fresh `v2` and switch to it before proposing an alternative.
- `ss browser eval "() => document.title"` — evaluate arbitrary JS on the CLI page.

## Commands

```
ss connect <url>                     Start proxy + watcher + CLI session
  --test, -t <name>                    Test to use (auto-created if missing)
  --port, -p <n>                       Port to run on (default: 3000)
  --snapshot, -s                       Skip the prompt and auto-snapshot after boot
  --no-snapshot                        Skip the prompt entirely

ss new <test-name>                   Scaffold a new test folder
ss variation                         Create a new variation for the active test
ss capture [url]                     Re-capture screenshots + page.md
ss list                              Show all tests and which is active
ss build                             Bundle every test to dist/ for deployment

ss snapshot                          AI: write DOM YAML to disk, print path
ss click <ref>                       AI: click by snapshot ref
ss fill <ref> <text>                 AI: fill an input by snapshot ref
ss goto <path>                       AI: navigate the CLI browser
ss browser <...args>                 AI: raw playwright-cli passthrough
ss dash                              Open the live-session dashboard

ss man                               Full inline reference
```

## Test structure

Each test lives in `tests/<name>/`:

```
tests/
  my-test/
    v1/
      variation.js  ← write your code here (no wrapper needed)
      index.css     ← styles (auto-injected as a <style> tag)
      index.html    ← optional HTML injected before </body>
```

`variation.js` is plain JavaScript — no function wrapper. The DOM is ready when it runs.

```js
// variation.js example
const hero = document.querySelector('.hero h1');
if (hero) hero.textContent = 'New Headline';
```

## Variations

Run `ss variation` to create a new variation (v2, v3, ...) copied from the current one. The proxy switches to it immediately.

```bash
ss variation
# → creates tests/my-test/v2/, switches active variation to v2
# → edit tests/my-test/v2/variation.js
```

The proxied page also shows a small variation-switcher widget in the corner when more than one variation exists.

## Optional HTML injection

Add markup to `tests/<name>/<variation>/index.html` and it's injected before `</body>` on every proxied page — useful for modals, overlays, or any structural markup your test needs:

```html
<!-- tests/my-test/v1/index.html -->
<div id="ss-modal" style="display:none">
  <h2>Special Offer</h2>
</div>
```

Leave the file empty (or delete it) if your test doesn't need extra HTML.

## Deploying a test

```bash
ss build
# → dist/my-test.js (minified, self-contained)
```

Paste `dist/my-test.js` into your A/B testing platform (Optimizely, VWO, Convert) or load it via a `<script>` tag.

## Cloudflare / bot-protected sites

`ss connect` probes for bot protection (checks `cf-mitigated`, `cf-ray`, and response status). If detected, it launches a stealth Playwright browser to clear the challenge, then serves every request — HTML *and* sub-resources — through the CF-cleared browser context so the mirrored page renders same-origin from `localhost:3000` (no CORS, no CSP breakage).

If Cloudflare requires human verification (Turnstile, CAPTCHA), a small headed window opens for you to solve it once. The cookies are then reused for the rest of the session.

## Testing locally (contributing)

```bash
git clone https://github.com/garrett-a/start-scripting.git ~/projects/ss
cd ~/projects/ss
npm install
npm link

mkdir /tmp/ss-test && cd /tmp/ss-test
ss new my-test
ss connect https://example.com --test my-test
```

`npm link` points the global `ss` binary at your clone, so edits to `src/` or `bin/` take effect on the next invocation — no reinstall.

Unlink when done:

```bash
npm unlink -g start-scripting
```

## Updating

```bash
cd ~/.ss && git pull && npm install
```
