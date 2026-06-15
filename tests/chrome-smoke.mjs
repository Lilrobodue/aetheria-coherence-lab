// Headless-Chrome smoke test driven over the DevTools Protocol (no puppeteer).
// Loads the app from the local static server, clicks through the disclaimer,
// runs both shared-engine self-tests, opens the Interval Analysis Lab, and
// reports any console errors / page exceptions.
//
// Prereqs: static server already serving src/ at BASE; Chrome at CHROME.
// Run: node tests/chrome-smoke.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8099/';
const CHROME = process.env.CHROME || '/c/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9222;

const userDataDir = mkdtempSync(join(tmpdir(), 'aetheria-smoke-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getJSON(path) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${path}`); if (r.ok) return await r.json(); }
    catch (_) {}
    await sleep(250);
  }
  throw new Error('DevTools endpoint never came up');
}

let exitCode = 1;
try {
  // Discover the DevTools target and connect.
  const version = await getJSON('/json/version');
  const wsUrl = version.webSocketDebuggerUrl;
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let nextId = 1;
  const pending = new Map();
  const consoleErrors = [];
  const exceptions = [];

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      exceptions.push(d.exception?.description || d.text);
    }
  };

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  // We connected to the browser target; open a fresh page target instead.
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  // From here, route methods to the page session.
  const sendS = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, sessionId, method, params }));
  });

  await sendS('Runtime.enable');
  await sendS('Page.enable');
  await sendS('Log.enable');

  await sendS('Page.navigate', { url: BASE });
  // Wait for modules to load + execute.
  await sleep(2500);

  const evalExpr = async (expression) => {
    const r = await sendS('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // 1. Shared libs present (loaded via classic <script> before main.js).
  const libs = await evalExpr(`({
    ia: typeof window.IntervalAnalysis,
    pe: typeof window.PrescriptionEngine,
  })`);

  // 2. Acknowledge the disclaimer to boot main.js init().
  await evalExpr(`(function(){
    var b = document.getElementById('disclaimer-accept');
    if (b) b.click();
    return true;
  })()`);
  await sleep(1500);

  // 3. Self-tests + lab wiring after init.
  const result = await evalExpr(`({
    iaSelf: window.IntervalAnalysis.selfTest(),
    peSelf: window.PrescriptionEngine.selfTest(),
    labMounted: !!window.aetheria && !!window.aetheria.intervalLab,
    btn: !!document.getElementById('btn-intervals'),
    freqs: (window.aetheria && window.aetheria.frequencies || []).length,
  })`);

  // 4. Open the lab and confirm the modal + library tab render without throwing.
  const opened = await evalExpr(`(function(){
    window.aetheria.intervalLab.open();
    // switch to the always-available library source
    var tab = document.querySelector('#interval-lab-modal .il-tab[data-src="library"]');
    if (tab) tab.click();
    var modal = document.getElementById('interval-lab-modal');
    var table = document.querySelector('#il-table .il-tbl');
    var canvas = document.querySelector('#il-numberline canvas');
    return {
      visible: modal && !modal.classList.contains('hidden'),
      tableRows: table ? table.querySelectorAll('tbody tr').length : 0,
      numberlineWidth: canvas ? canvas.width : 0,
    };
  })()`);

  // 5. Cascade path: inject a synthetic completed session and confirm the
  //    cascade tab renders its duration card + the brain↔audio overlay.
  const cascade = await evalExpr(`(function(){
    window.aetheria.lastSession = {
      metadata: { sessionId:'smoke', startTime:'2026-05-01T10:00:00Z', endTime:'2026-05-01T10:45:00Z' },
      streams: {
        coherence: [
          { t:0, tcs:40, gut:0.4, heart:0.4, head:0.4, plv:0.3, harm:0.4 },
          { t:1350, tcs:72, gut:0.7, heart:0.6, head:0.66, plv:0.5, harm:0.6 },
          { t:2700, tcs:84, gut:0.82, heart:0.77, head:0.8, plv:0.6, harm:0.7 }
        ],
        prescription: [
          { t:10, action:'play', freq:174, regime:'GUT', name:'Foundation' },
          { t:600, action:'play', freq:285, regime:'GUT', name:'Quantum Cognition' },
          { t:1200, action:'play', freq:396, regime:'GUT', name:'Liberation' },
          { t:1800, action:'play', freq:528, regime:'GUT', name:'Transformation' }
        ]
      }
    };
    window.aetheria.intervalLab.open();
    var casTab = document.querySelector('#interval-lab-modal .il-tab[data-src="cascade"]');
    if (casTab) casTab.click();
    var durCard = Array.from(document.querySelectorAll('#il-summary .il-card-label'))
      .some(function(e){ return /Duration vs Protocol/.test(e.textContent); });
    var xcorr = document.querySelector('#il-crosscorr canvas');
    var rows = document.querySelectorAll('#il-table .il-tbl tbody tr').length;
    return { durCard: durCard, xcorrWidth: xcorr ? xcorr.width : 0, cascadeRows: rows };
  })()`);

  // ---- Report ----
  const log = [];
  let ok = true;
  const check = (name, cond, detail) => { if (!cond) ok = false; log.push(`${cond ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };

  check('IntervalAnalysis global loaded', libs.ia === 'object', `typeof=${libs.ia}`);
  check('PrescriptionEngine global loaded', libs.pe === 'object', `typeof=${libs.pe}`);
  check('IntervalAnalysis self-test passes', result.iaSelf.failed === 0, `${result.iaSelf.passed}/${result.iaSelf.total}`);
  check('PrescriptionEngine self-test passes', result.peSelf.failed === 0, `${result.peSelf.passed}/${result.peSelf.total}`);
  check('frequencies.json loaded (27)', result.freqs === 27, `${result.freqs}`);
  check('IntervalLab instantiated', result.labMounted === true);
  check('header button present', result.btn === true);
  check('lab modal opens (visible)', opened.visible === true);
  check('library interval table renders rows', opened.tableRows > 0, `${opened.tableRows} rows`);
  check('number-line canvas has width', opened.numberlineWidth > 0, `${opened.numberlineWidth}px buffer`);
  check('cascade tab shows duration-vs-protocol card', cascade.durCard === true);
  check('cascade interval table renders rows', cascade.cascadeRows === 6, `${cascade.cascadeRows} rows (expect 6 for 4 freqs)`);
  check('brain↔audio cross-corr canvas has width', cascade.xcorrWidth > 0, `${cascade.xcorrWidth}px buffer`);
  check('no page exceptions', exceptions.length === 0, exceptions.join(' | ') || 'none');
  check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | ') || 'none');

  console.log('\nchrome-smoke.mjs');
  console.log(log.map(l => '  ' + l).join('\n'));
  console.log(`\n${ok ? 'ALL SMOKE CHECKS PASSED' : 'SMOKE CHECKS FAILED'}`);
  exitCode = ok ? 0 : 1;

  ws.close();
} catch (err) {
  console.error('smoke harness error:', err.message);
} finally {
  chrome.kill();
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(exitCode);
}
