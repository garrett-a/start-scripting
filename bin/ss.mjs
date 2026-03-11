#!/usr/bin/env node
/**
 * bin/ss.mjs — CLI entry point
 *
 * Commander works like a menu: you define commands and options, then call
 * program.parse() at the end to read the actual arguments from the terminal
 * and run the matching command.
 */

import { program } from 'commander';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';

// Config and tests live in the current working directory (the user's project)
const CONFIG_FILE = join(process.cwd(), '.ss-config.json');

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
    saveConfig({ ...config, activeTest: testName });
  });

// ─── ss connect <url> ─────────────────────────────────────────────────────────

program
  .command('connect <url>')
  .description('Start proxy + watcher, capture page context, and open the site in your browser')
  .option('-t, --test <name>', 'Test name to use (defaults to last used test)')
  .option('-p, --port <number>', 'Port to run on', '3000')
  .action(async (url, options) => {
    const config = loadConfig();
    const testName = options.test || config.activeTest;

    if (!testName) {
      console.error('✖ No test specified.');
      console.error('  Run "ss new <test-name>" first, or use: ss connect <url> --test <name>');
      process.exit(1);
    }

    const port = parseInt(options.port, 10);

    // Auto-create the test folder if it doesn't exist yet
    const testDir = join(process.cwd(), 'tests', testName);
    if (!existsSync(testDir)) {
      const { scaffoldTest } = await import('../src/scaffold.mjs');
      scaffoldTest(testName);
    }

    saveConfig({ ...config, activeTest: testName, targetUrl: url });

    console.log(`\n  Active test : tests/${testName}/`);
    console.log(`  Target URL  : ${url}`);

    const { startBuilder } = await import('../src/builder.mjs');
    const { startProxy } = await import('../src/proxy.mjs');
    const { capturePageContext } = await import('../src/capture.mjs');

    // Start proxy + builder, then capture page context in parallel
    await Promise.all([
      startBuilder(testName),
      startProxy(url, port),
      capturePageContext(url, testName),
    ]);

    // Open the proxied site in the default browser
    const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${openCmd} http://localhost:${port}`);

    console.log('  Edit tests/' + testName + '/variation.js to write your test.');
    console.log('  Ask your AI: "Based on ss-context/page.md, [what you want]"');
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

// ─── ss build ─────────────────────────────────────────────────────────────────

program
  .command('build')
  .description('Bundle all tests to dist/ for deployment (minified)')
  .action(async () => {
    const { buildAll } = await import('../src/builder.mjs');
    await buildAll();
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
       Page context saved to ss-context/ for your AI assistant.

  2. Edit tests/<name>/variation.js
       Write plain JS — no wrapper needed. Save to rebuild.

  3. Ask your AI (Copilot, Cursor, Claude, etc.):
       "Based on ss-context/page.md, add a sticky bar..."
       Paste the output into variation.js.

  4. ss build  →  dist/<name>.js
       Paste into Optimizely / VWO / Convert to go live.

  COMMANDS
  ────────
  ss connect <url>               Start proxy + watcher
    --test, -t <name>            Test to use (auto-created if missing)
    --port, -p <number>          Port to run on (default: 3000)

  ss new <test-name>             Scaffold a new test folder
  ss list                        Show all tests, mark active one
  ss build                       Bundle all tests to dist/ (minified)
  ss man                         Show this reference

  TEST FOLDER
  ───────────
  tests/<name>/
    variation.js    ← your code (edit this)
    index.css       ← your styles (edit this)
    index.js        ← boilerplate (do not edit)

  CONTEXT FILES (auto-generated on connect)
  ──────────────────────────────────────────
  ss-context/
    screenshot.png  ← open in IDE to see the page visually
    page.md         ← reference when prompting your AI assistant

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
