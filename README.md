# start-scripting

Local dev tool for building A/B tests on live websites. Write test code in your IDE, see it run on the live site instantly.

## How it works

1. `ss connect <url>` starts a proxy at `localhost:3000` that mirrors any live site
2. Your local JS/CSS is automatically injected into every page
3. Save a file → page rebuilds and refreshes instantly
4. Page context (full-page screenshots at desktop/tablet/mobile + HTML + CSS) is saved to `ss-context/` so you can prompt your AI assistant (Copilot, Cursor, Claude, etc.) to generate test code

## Install

Requires [Node.js](https://nodejs.org) v18+.

```bash
git clone https://github.com/garrett-a/start-scripting.git ~/.ss
cd ~/.ss
npm install
npm link
```

This installs the `ss` command globally. The first time you run `ss connect`, Chromium will be downloaded automatically (~100MB, one time).

## Quickstart

```bash
# Navigate to any project
cd ~/projects/client-site/

# Connect to a live site (auto-creates the test folder)
ss connect https://client-site.com --test homepage-hero

# localhost:3000 opens in your browser, mirroring the live site
# Edit tests/homepage-hero/v1/variation.js — the page refreshes on every save
```

## AI-assisted development

When `ss connect` runs, it saves context files to `ss-context/`:

- `desktop.png` — full-page screenshot at 1440px
- `tablet.png` — full-page screenshot at 768px
- `mobile.png` — full-page screenshot at 375px
- `page.md` — HTML structure + CSS design tokens

Run `ss capture` at any time to refresh these files. Open `ss-context/page.md` in your IDE and ask your AI assistant:

> "Based on ss-context/page.md, add a sticky announcement bar at the top that matches the site's colors"

Paste the generated code into `v1/variation.js` → the proxy rebuilds → the change appears on the live site.

## Commands

```
ss connect <url>               Start proxy + watcher for a live site
ss connect <url> --test <name> Connect with a specific test name
ss connect <url> --port <n>    Run on a custom port (default: 3000)

ss new <test-name>             Create a new test folder manually
ss variation                   Create a new variation for the active test
ss capture [url]               Re-capture page context (screenshots + HTML)
ss list                        Show all tests and which is active
ss build                       Bundle all tests to dist/ for deployment

ss man                         Show the full command reference
```

## Test structure

Each test lives in `tests/<name>/`:

```
tests/
  my-test/
    v1/
      variation.js ← write your code here (no wrapper needed)
      index.css    ← styles (auto-injected as a <style> tag)
      index.html   ← optional HTML injected before </body>
```

`variation.js` is plain JavaScript — no function wrapper needed. The DOM is ready when it runs.

```js
// variation.js example
const hero = document.querySelector('.hero h1');
if (hero) hero.textContent = 'New Headline';
```

## Variations

Run `ss variation` to create a new variation (v2, v3, ...) copied from the current one. The proxy switches to the new variation immediately.

```bash
ss variation
# → creates tests/my-test/v2/, switches active variation to v2
# → edit tests/my-test/v2/variation.js
```

## Optional HTML injection

Add any HTML to `tests/<name>/<variation>/index.html` and it will be injected before `</body>` on every proxied page. Useful for modals, overlays, or any markup your test needs:

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

Paste the contents of `dist/my-test.js` into your A/B testing platform (Optimizely, VWO, Convert, etc.) or load it via a `<script>` tag.

## Testing locally (contributing)

To work on `ss` itself without reinstalling after every change:

```bash
# 1. Clone the repo
git clone https://github.com/garrett-a/start-scripting.git ~/projects/ss
cd ~/projects/ss
npm install

# 2. Link it globally so the `ss` command runs your local copy
npm link

# 3. Make a throwaway project to test against
mkdir /tmp/ss-test && cd /tmp/ss-test

# 4. Run commands directly from your clone — changes take effect immediately
ss new my-test
ss connect https://example.com --test my-test
```

Because `npm link` points the global `ss` binary at your clone, any edits to files in `src/` or `bin/` are picked up the next time you run a command — no reinstall needed.

To unlink when you're done:

```bash
npm unlink -g start-scripting
```

## Updating

```bash
cd ~/.ss && git pull && npm install
```
