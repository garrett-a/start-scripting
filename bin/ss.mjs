#!/usr/bin/env node
/**
 * bin/ss.mjs — CLI entry point
 *
 * Commander works like a menu: you define commands and options, then call
 * program.parse() at the end to read the actual arguments from the terminal
 * and run the matching command.
 */

import { program } from 'commander';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, cpSync } from 'fs';
import { join, dirname, basename } from 'path';
import { exec, spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

// Config and tests live in the current working directory (the user's project)
const CONFIG_FILE = join(process.cwd(), '.ss-config.json');

// TOOL_DIR: the ss install location — where node_modules/.bin/playwright-cli lives
const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_BIN = join(TOOL_DIR, 'node_modules', '.bin', 'playwright-cli');

// ─── Playwright CLI helpers ───────────────────────────────────────────────────

function cliSessionName() {
  const cfg = loadConfig();
  if (cfg.cliSession) return cfg.cliSession;
  return `ss-${basename(process.cwd()) || 'project'}`;
}

/**
 * Run a playwright-cli subcommand scoped to the project's session.
 * Streams stdout/stderr straight through so the caller (AI or user) sees
 * the raw CLI output — including the YAML snapshot path.
 *
 * @param {string[]} args - CLI args after the session flag (e.g. ['snapshot'])
 * @param {object}   [opts]
 * @param {boolean}  [opts.raw] - Skip the -s=<session> prefix (for `list`, `show`, etc.)
 * @returns {number} exit code
 */
function runCli(args, { raw = false } = {}) {
  if (!existsSync(CLI_BIN)) {
    console.error(`✖ playwright-cli not installed at ${CLI_BIN}`);
    console.error(`  Run \`npm install\` inside the ss tool directory (${TOOL_DIR}).`);
    return 1;
  }
  const session = cliSessionName();
  const fullArgs = raw ? args : [`-s=${session}`, ...args];
  const res = spawnSync(CLI_BIN, fullArgs, {
    stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_CLI_SESSION: session },
  });
  return res.status ?? 1;
}

/**
 * Boot a persistent CLI session pointed at the proxy URL.
 * Non-blocking — the CLI daemonizes the browser process. Returns a teardown
 * function the SIGINT handler can call.
 *
 * @param {string} proxyUrl - The full URL (localhost + path) the session opens
 * @returns {() => void} teardown
 */
function bootCliSession(proxyUrl) {
  if (!existsSync(CLI_BIN)) {
    console.warn(`  ⚠ playwright-cli not found — AI DOM inspection disabled.`);
    console.warn(`    Run \`npm install\` in ${TOOL_DIR} to enable \`ss snapshot\`.`);
    return () => {};
  }
  const session = cliSessionName();
  console.log(`  Booting playwright-cli session: ${session}`);
  const child = spawn(
    CLI_BIN,
    [`-s=${session}`, 'open', proxyUrl, '--persistent'],
    { stdio: 'ignore', detached: true, env: { ...process.env, PLAYWRIGHT_CLI_SESSION: session } },
  );
  child.unref();

  const cfg = loadConfig();
  saveConfig({ ...cfg, cliSession: session });

  return () => {
    try {
      spawnSync(CLI_BIN, [`-s=${session}`, 'close'], { stdio: 'ignore', timeout: 5000 });
    } catch {}
  };
}

/**
 * Prompt yes/no on the terminal, defaulting to yes. Returns false immediately
 * if neither stdin nor stdout is a TTY (piped, nohup, CI) so `ss connect`
 * doesn't hang. `process.stdin.isTTY` is only set when stdin is a real
 * terminal — for socket-attached environments it's undefined (falsy), so
 * we also check stdout.isTTY as a fallback signal that a terminal is present.
 */
function promptYes(question) {
  const hasTty = process.stdin.isTTY || process.stdout.isTTY;
  if (!hasTty) return Promise.resolve(false);
  return new Promise((resolve) => {
    // Blank line first so the prompt isn't lost in boot noise.
    process.stdout.write('\n');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [Y/n] `, (ans) => {
      rl.close();
      const a = (ans || '').trim().toLowerCase();
      resolve(a === '' || a === 'y' || a === 'yes');
    });
  });
}

/**
 * Give the CLI daemon a moment to open the browser + finish initial navigation
 * before we ask it for a snapshot. The CLI reports "browser not open" if we
 * fire snapshot before `open` completes.
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Config helpers ───────────────────────────────────────────────────────────
// .ss-config.json remembers your active test and target URL between sessions
// so you don't have to type them every time.

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(data) {
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

// ─── CLI setup ────────────────────────────────────────────────────────────────

program
  .name('ss')
  .description('A/B test local dev tool — develop on live sites from your IDE')
  .version('1.0.0');

// ─── ss new <test-name> ───────────────────────────────────────────────────────

program
  .command('new <test-name>')
  .description('Scaffold a new A/B test folder from the template')
  .action(async (testName) => {
    const { scaffoldTest } = await import('../src/scaffold.mjs');
    scaffoldTest(testName);

    const config = loadConfig();
    saveConfig({ ...config, activeTest: testName, activeVariation: 'v1' });
  });

// ─── ss connect <url> ─────────────────────────────────────────────────────────

program
  .command('connect <url>')
  .description('Start proxy + watcher, capture page context, and open the site in your browser')
  .option('-t, --test <name>', 'Test name to use (defaults to last used test)')
  .option('-p, --port <number>', 'Port to run on', '3000')
  .option('-s, --snapshot', 'Skip the prompt and take a snapshot right after connect')
  .option('--no-snapshot', 'Skip the prompt and do not take a snapshot')
  .action(async (url, options) => {
    const config = loadConfig();
    const testName = options.test || config.activeTest;

    if (!testName) {
      console.error('✖ No test specified.');
      console.error('  Run "ss new <test-name>" first, or use: ss connect <url> --test <name>');
      process.exit(1);
    }

    const port = parseInt(options.port, 10);

    // Auto-prepend https:// if no protocol provided (e.g. "opb.org" → "https://opb.org")
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }

    // Detect bot protection (Cloudflare, etc.) with a quick headless probe.
    // Cloudflare doesn't always render its challenge on the initial navigation
    // — sometimes it just returns 403/503 with cf-mitigated + cf-ray headers
    // and lets JS on the page finish the challenge later. So check the
    // response object too, not just the rendered body.
    let usePW = false;
    try {
      const { chromium } = await import('playwright');
      console.log('\n  Checking for bot protection...');
      const probe = await chromium.launch({ headless: true });
      const ctx = await probe.newContext();
      const pg = await ctx.newPage();
      const response = await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise(r => setTimeout(r, 3000));
      const bodyText = await pg.evaluate(() => document.body.innerText);
      const respStatus = response?.status() ?? 200;
      const respHeaders = response?.headers() ?? {};
      const cfMitigated = 'cf-mitigated' in respHeaders;
      const cfRay = 'cf-ray' in respHeaders;
      const cfServer = /cloudflare/i.test(respHeaders['server'] || '');
      const blockedStatus = respStatus === 403 || respStatus === 503;
      const challengeText = /security verification|checking your browser|just a moment/i.test(bodyText);
      usePW = challengeText || cfMitigated || (blockedStatus && (cfRay || cfServer));

      if (!usePW) {
        // No challenge — check for redirects (e.g. opb.org → www.opb.org)
        const finalUrl = new URL(pg.url());
        const canonical = `${finalUrl.protocol}//${finalUrl.host}`;
        if (canonical !== new URL(url).origin) {
          console.log(`  ↳ ${url} redirects to ${canonical} — using that instead`);
          url = canonical;
        }
        console.log('  ✔ No bot protection detected');
      } else {
        const reason = challengeText ? 'challenge text'
          : cfMitigated ? 'cf-mitigated header'
          : `HTTP ${respStatus} with CF markers`;
        console.log(`  ⚠ Bot protection detected (${reason}) — will use Playwright bypass`);
      }
      await probe.close();
    } catch (err) {
      // Timeouts usually mean bot protection is stalling the page load
      usePW = true;
      console.warn(`  ⚠ Probe failed: ${err.message} — assuming bot protection, using Playwright bypass`);
    }

    // Follow redirects for non-CF sites (CF sites handle this in Chrome)
    if (!usePW) {
      try {
        const res = await fetch(url, { method: 'GET', redirect: 'follow' });
        const resolved = new URL(res.url);
        const canonical = `${resolved.protocol}//${resolved.host}`;
        if (canonical !== new URL(url).origin) {
          console.log(`  ↳ ${url} redirects to ${canonical} — using that instead`);
          url = canonical;
        }
      } catch {}
    }

    // Auto-create the test folder if it doesn't exist yet
    const testDir = join(process.cwd(), 'tests', testName);
    if (!existsSync(testDir)) {
      const { scaffoldTest } = await import('../src/scaffold.mjs');
      scaffoldTest(testName);
    }

    // Split URL into origin (for proxy target) and path (for browser + capture)
    const parsedUrl = new URL(url);
    const targetOrigin = parsedUrl.origin;
    const targetPath = parsedUrl.pathname + parsedUrl.search;

    const activeVariation = config.activeVariation || 'v1';
    saveConfig({ ...config, activeTest: testName, activeVariation, targetUrl: url });

    console.log(`\n  Active test      : tests/${testName}/`);
    console.log(`  Active variation : ${activeVariation}`);
    console.log(`  Target URL       : ${url}`);

    const { startBuilder } = await import('../src/builder.mjs');
    const { startProxy } = await import('../src/proxy.mjs');
    const { capturePageContext } = await import('../src/capture.mjs');

    if (usePW) {
      // ── Playwright proxy mode (Cloudflare bypass) ──────────────────────
      // Uses a stealth Playwright browser as the fetch backend for the proxy.
      // The user still works at localhost:3000 in their own browser.
      const { PwFetcher } = await import('../src/pw-fetcher.mjs');
      const pwFetcher = new PwFetcher();

      console.log('  Launching stealth browser to bypass Cloudflare...');
      await pwFetcher.init(url);

      // Pass CF cookies to capture so screenshots work on protected sites
      const cookies = await pwFetcher.getCookies();

      await Promise.all([
        startBuilder(testName),
        startProxy(targetOrigin, port, { pwFetcher }),
        capturePageContext(url, testName, { cookies }),
      ]);

      var proxyUrl = `http://localhost:${port}${targetPath}`;
      var extraCleanup = async () => { await pwFetcher.close(); };
      console.log(`  Edit tests/${testName}/${activeVariation}/variation.js to write your test.`);

    } else {
      // ── Standard proxy mode ──────────────────────────────────────────────
      await Promise.all([
        startBuilder(testName),
        startProxy(targetOrigin, port),
        capturePageContext(url, testName),
      ]);

      var proxyUrl = `http://localhost:${port}${targetPath}`;
      var extraCleanup = async () => {};
      console.log(`  Edit tests/${testName}/${activeVariation}/variation.js to write your test.`);
    }

    // Snapshot decision: --snapshot / --no-snapshot skip the prompt,
    // otherwise ask. Prompt runs BEFORE browser-open and CLI-boot so the
    // readline prompt isn't clobbered by proxy [PW] GET log lines on the
    // same TTY row. Non-TTY (piped, nohup, CI) skips silently.
    let takeSnapshot;
    if (options.snapshot === true) takeSnapshot = true;
    else if (options.snapshot === false) takeSnapshot = false;
    else takeSnapshot = await promptYes('  Take a snapshot now for AI DOM inspection?');

    // Boot the CLI daemon + open the user's browser now that the prompt
    // (if any) is done.
    const cliTeardown = bootCliSession(proxyUrl);
    const cleanup = async () => {
      cliTeardown();
      await extraCleanup();
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('SIGHUP', cleanup);

    const openCmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${openCmd} ${proxyUrl}`);

    if (takeSnapshot) {
      // Let the CLI daemon finish opening + navigating before we ask for
      // a snapshot — otherwise it reports "browser not open" or hits a
      // load-event timeout. 6s covers most SPAs; slow-loading sites may
      // need `ss snapshot` re-run manually.
      await sleep(6000);
      runCli(['snapshot']);
    } else {
      console.log('  AI DOM inspection: `ss snapshot` (writes YAML to disk)');
    }

    // Kickoff prompt — a paste-ready line the user can drop into their AI
    // agent to start iterating on the test.
    console.log('');
    console.log('  ── Kickoff prompt for your AI ──────────────────────────────────');
    const promptFile = takeSnapshot
      ? 'the latest file in `.playwright-cli/page-*.yml`'
      : '`.playwright-cli/` (run `ss snapshot` first if empty)';
    console.log(
      `  Read ${promptFile} to see the DOM. My variation code goes in ` +
      `\`tests/${testName}/${activeVariation}/variation.js\` and CSS in ` +
      `\`index.css\` next to it. From here, I want to [what you're building].`,
    );
    console.log('  Use `ss snapshot` / `ss click <ref>` / `ss fill <ref> <text>` to interact.');
    console.log('  ────────────────────────────────────────────────────────────────');
    console.log('');
    console.log('  Press Ctrl+C to stop.\n');
    process.stdin.resume();
  });

// ─── ss list ──────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List all tests in the current project')
  .action(() => {
    const testsDir = join(process.cwd(), 'tests');
    const config = loadConfig();

    if (!existsSync(testsDir)) {
      console.log('No tests/ folder found. Run "ss connect <url> --test <name>" to create one.');
      return;
    }

    const tests = readdirSync(testsDir).filter((name) => {
      if (name === '_template') return false;
      return statSync(join(testsDir, name)).isDirectory();
    });

    if (tests.length === 0) {
      console.log('No tests yet. Run "ss connect <url> --test <name>" to create one.');
      return;
    }

    console.log('\n  Tests:\n');
    tests.forEach((name) => {
      const active = name === config.activeTest;
      console.log(`  ${active ? '▶' : ' '} ${name}${active ? '  ← active' : ''}`);
    });
    if (config.targetUrl) {
      console.log(`\n  Target URL: ${config.targetUrl}`);
    }
    console.log('');
  });

// ─── ss variation ─────────────────────────────────────────────────────────────

program
  .command('variation')
  .description('Create a new variation for the active test and switch to it')
  .action(async () => {
    const config = loadConfig();
    if (!config.activeTest) {
      console.error('✖ No active test. Run "ss new <name>" first.');
      process.exit(1);
    }

    const testDir = join(process.cwd(), 'tests', config.activeTest);
    if (!existsSync(testDir)) {
      console.error(`✖ Test folder not found: tests/${config.activeTest}/`);
      process.exit(1);
    }

    // Find the highest existing v# folder and increment
    const existing = readdirSync(testDir).filter(
      (n) => /^v\d+$/.test(n) && statSync(join(testDir, n)).isDirectory()
    );
    const nums = existing.map((n) => parseInt(n.slice(1), 10));
    const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 2;
    const nextVariation = `v${nextNum}`;
    const currentVariation = config.activeVariation || 'v1';

    // Copy current variation folder to new variation
    cpSync(join(testDir, currentVariation), join(testDir, nextVariation), { recursive: true });

    // Rewrite the hidden cache entry to point to the new variation
    const { writeCacheEntry } = await import('../src/scaffold.mjs');
    writeCacheEntry(config.activeTest, nextVariation);

    saveConfig({ ...config, activeVariation: nextVariation });

    console.log(`✔ Created tests/${config.activeTest}/${nextVariation}/ (copied from ${currentVariation})`);
    console.log(`  Now active: ${nextVariation}`);
    console.log(`  Edit tests/${config.activeTest}/${nextVariation}/variation.js`);
  });

// ─── ss capture ───────────────────────────────────────────────────────────────

program
  .command('capture [url]')
  .description('Re-capture page context (screenshots + HTML) for the target site')
  .action(async (url) => {
    const config = loadConfig();
    const targetUrl = url || config.targetUrl;

    if (!targetUrl) {
      console.error('✖ No URL specified and no previous target found.');
      console.error('  Usage: ss capture <url>  or  run ss connect first.');
      process.exit(1);
    }

    const testName = config.activeTest || 'unknown';
    const { capturePageContext } = await import('../src/capture.mjs');
    await capturePageContext(targetUrl, testName);
  });

// ─── ss build ─────────────────────────────────────────────────────────────────

program
  .command('build')
  .description('Bundle all tests to dist/ for deployment (minified)')
  .action(async () => {
    const { buildAll } = await import('../src/builder.mjs');
    await buildAll();
  });

// ─── ss snapshot / click / fill / goto / browser / dash ──────────────────────
// Thin wrappers around @playwright/cli scoped to the project session.
// The CLI hits localhost:3000 (the proxy) so snapshots reflect the injected
// variation. Use these as the AI-agent DOM interface — YAML on disk, no
// context bloat. `ss browser` is a raw passthrough for anything the wrappers
// don't cover (state-save, state-load, type, close, etc.).

program
  .command('snapshot')
  .description('Write an accessibility-tree YAML snapshot of the proxied page to disk')
  .action(() => {
    process.exit(runCli(['snapshot']));
  });

program
  .command('click <ref>')
  .description('Click the element with the given snapshot ref')
  .action((ref) => {
    process.exit(runCli(['click', ref]));
  });

program
  .command('fill <ref> <text>')
  .description('Fill an input with the given snapshot ref')
  .action((ref, text) => {
    process.exit(runCli(['fill', ref, text]));
  });

program
  .command('goto <path>')
  .description('Navigate the CLI session to a new path on the proxy')
  .action((path) => {
    process.exit(runCli(['goto', path]));
  });

program
  .command('browser [args...]')
  .description('Passthrough to playwright-cli, scoped to the project session')
  .allowUnknownOption(true)
  .action((args = []) => {
    process.exit(runCli(args));
  });

program
  .command('dash')
  .description('Open the playwright-cli live session dashboard')
  .action(() => {
    process.exit(runCli(['show'], { raw: true }));
  });

// ─── ss man ───────────────────────────────────────────────────────────────────

program
  .command('man')
  .description('Show the full command reference')
  .action(() => {
    console.log(`
  ┌─────────────────────────────────────────────────────┐
  │                  ss — start-scripting                │
  │        A/B test dev tool for live websites           │
  └─────────────────────────────────────────────────────┘

  WORKFLOW
  ────────
  1. ss connect <url> --test <name>
       Proxy starts at localhost:3000 mirroring the live site.
       Screenshots saved to ss-context/ for visual reference.
       A playwright-cli session boots against the proxy for AI DOM inspection.

  2. Edit tests/<name>/v1/variation.js
       Write plain JS — no wrapper needed. Save to rebuild.

  3. Ask your AI (Copilot, Cursor, Claude Code, etc.):
       "Run ss snapshot and inspect the DOM, then update variation.js to..."
       AI reads YAML from disk on demand — no context bloat.

  4. ss build  →  dist/<name>.js
       Paste into Optimizely / VWO / Convert to go live.

  COMMANDS
  ────────
  ss connect <url>               Start proxy + watcher + CLI session
    --test, -t <name>            Test to use (auto-created if missing)
    --port, -p <number>          Port to run on (default: 3000)
    --snapshot, -s               Take a snapshot right after boot, no prompt
    --no-snapshot                Skip the snapshot prompt entirely

  ss new <test-name>             Scaffold a new test folder
  ss variation                   Create a new variation for the active test
  ss capture [url]               Re-capture screenshots + page.md
  ss list                        Show all tests, mark active one
  ss build                       Bundle all tests to dist/ (minified)
  ss man                         Show this reference

  AI-AGENT COMMANDS (via @playwright/cli, scoped to project session)
  ─────────────────────────────────────────────────────────────────
  ss snapshot                    Write accessibility YAML to disk, print path
  ss click <ref>                 Click by snapshot ref
  ss fill <ref> <text>           Fill input by snapshot ref
  ss goto <path>                 Navigate the CLI session to a new path
  ss browser <...args>           Raw passthrough to playwright-cli
  ss dash                        Open the live-session dashboard

  TEST FOLDER
  ───────────
  tests/<name>/
    v1/
      variation.js  ← your code (edit this)
      index.css     ← your styles (edit this)
      index.html    ← optional HTML injected before </body>

  CONTEXT FILES (auto-generated on connect, refreshed with ss capture)
  ────────────────────────────────────────────────────────────────────
  ss-context/
    desktop.png  ← full-page screenshot at 1440px
    tablet.png   ← full-page screenshot at 768px
    mobile.png   ← full-page screenshot at 375px
    page.md      ← workflow pointer — DOM lives in ss snapshot output

  INSTALL
  ───────
  git clone https://github.com/garrett-a/start-scripting.git ~/.ss
  cd ~/.ss && npm install && npm link

  UPDATE
  ──────
  cd ~/.ss && git pull && npm install
`);
  });

// ─── Parse and run ────────────────────────────────────────────────────────────

program.parse();
