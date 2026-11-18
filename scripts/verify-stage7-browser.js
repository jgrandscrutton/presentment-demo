#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');

const appModule = require('../app');
const { createDemoApiRouter } = require('../routes/demo-api');
const { createDemoLogRouter } = require('../routes/demo-log');
const { createDemoPreflightRouter } = require('../routes/demo-preflight');
const { createDemoRoutesRouter } = require('../routes/demo-routes');
const { createDemoRouter } = require('../routes/demo');

const ROOT = path.join(__dirname, '..');
const PASSCODE = 'stage7-browser-presenter';

function account(id, currency, paymentTypes, options = {}) {
  const assigned = paymentTypes.length > 0;
  return {
    key: id,
    merchantAccountId: id,
    label: options.label || `${currency} ${id}`,
    currency,
    paymentTypes: [...paymentTypes],
    paymentMethods: ['card'],
    threeDSecurePolicy: options.threeDSecurePolicy || 'optional',
    paymentTypeSources: Object.fromEntries(paymentTypes.map((type) => [type, 'policy'])),
    routingReasons: Object.fromEntries(
      paymentTypes.map((type) => [type, `Stage 7 smoke policy: ${currency} ${type}`])
    ),
    environment: 'sandbox',
    status: 'active',
    isDefault: options.isDefault === true,
    roleSource: assigned ? 'policy' : null,
    assignmentState: assigned ? 'assigned' : 'available_not_assigned',
    purpose: assigned
      ? 'Assigned by the deterministic Stage 7 browser fixture.'
      : 'Available, not assigned.',
  };
}

function createFixtureCatalog() {
  const state = {
    status: 'ok',
    gatewayMerchantId: 'stage7-browser-gateway',
    discoveredAt: '2026-11-17T12:00:00.000Z',
    error: null,
    warnings: [],
    policyStatus: 'applied',
    accounts: [
      account('cad-default', 'CAD', ['one_time', 'recurring'], {
        isDefault: true,
      }),
      account('jpy-sales', 'JPY', ['one_time']),
      account('jpy-billing', 'JPY', ['recurring']),
    ],
    planDiscovery: {
      status: 'ok',
      discoveredAt: '2026-11-17T12:00:00.000Z',
      error: null,
    },
    plans: [
      {
        id: 'stage7-jpy-monthly',
        name: 'Stage 7 JPY monthly',
        description: 'Deterministic browser fixture',
        currency: 'JPY',
        price: '1000',
        billingFrequency: 1,
      },
    ],
  };
  let refreshCount = 0;

  function copyState() {
    return structuredClone(state);
  }

  function applyAssignments(assignments) {
    for (const current of state.accounts) {
      const roles = assignments
        .filter((item) => item.merchantAccountId === current.merchantAccountId)
        .map((item) => item.paymentType);
      current.paymentTypes = roles;
      current.paymentTypeSources = Object.fromEntries(
        roles.map((role) => [role, 'policy'])
      );
      current.routingReasons = Object.fromEntries(
        roles.map((role) => [role, `Stage 7 presenter mapping: ${current.currency} ${role}`])
      );
      current.roleSource = roles.length > 0 ? 'policy' : null;
      current.assignmentState = roles.length > 0 ? 'assigned' : 'available_not_assigned';
      current.purpose = roles.length > 0
        ? 'Assigned by the Stage 7 presenter mapping.'
        : 'Available, not assigned.';
    }
    state.discoveredAt = new Date().toISOString();
  }

  return {
    applyAssignments,
    get refreshCount() {
      return refreshCount;
    },
    getState: copyState,
    getPublicMerchantAccounts() {
      return copyState().accounts;
    },
    getMerchantAccounts() {
      return copyState().accounts;
    },
    async refresh() {
      refreshCount += 1;
      return copyState();
    },
  };
}

function createMemoryEventStore() {
  let events = [];
  return {
    append(event) {
      const stored = {
        ...structuredClone(event),
        gatewayMerchantId: 'stage7-browser-gateway',
        id: `browser-event-${events.length + 1}`,
        timestamp: new Date().toISOString(),
      };
      events.push(stored);
      return structuredClone(stored);
    },
    list() {
      return structuredClone(events);
    },
    get(id) {
      const found = events.find((event) => event.id === id);
      return found ? structuredClone(found) : undefined;
    },
    clear() {
      const removed = events.length;
      events = [];
      return removed;
    },
  };
}

function createFixturePolicyWriter(catalog) {
  let baseline = null;
  return {
    async hasBaseline() {
      return baseline !== null;
    },
    async save({ assignments, refresh }) {
      if (!baseline) baseline = catalog.getState().accounts;
      catalog.applyAssignments(assignments);
      await refresh();
    },
    async restore({ refresh }) {
      if (!baseline) throw new Error('No browser fixture baseline');
      const assignments = [];
      for (const current of baseline) {
        for (const paymentType of current.paymentTypes) {
          assignments.push({
            currency: current.currency,
            paymentType,
            merchantAccountId: current.merchantAccountId,
          });
        }
      }
      catalog.applyAssignments(assignments);
      await refresh();
    },
  };
}

function fixtureApplication() {
  const catalog = createFixtureCatalog();
  const store = createMemoryEventStore();
  const policyWriter = createFixturePolicyWriter(catalog);
  const forbiddenMutationCalls = [];
  function denyMutationRouter(name) {
    const router = express.Router();
    router.use((req, res) => {
      forbiddenMutationCalls.push({ name, method: req.method, path: req.path });
      res.status(503).json({
        success: false,
        error: { code: 'BROWSER_FIXTURE_MUTATION_BLOCKED' },
      });
    });
    return router;
  }
  const getCatalogService = () => catalog;
  const routers = {
    demo: createDemoRouter({ getCatalogService }),
    demoApi: createDemoApiRouter({
      catalogService: catalog,
      gatewayClient: {},
      store,
      merchantId: 'stage7-browser-gateway',
      logger: { error() {} },
    }),
    demoLog: createDemoLogRouter({ catalogService: catalog, store }),
    demoPreflight: createDemoPreflightRouter({
      catalogService: catalog,
      store,
      environment: {},
    }),
    demoRoutes: createDemoRoutesRouter({
      catalogService: catalog,
      policyWriter,
      presenterPasscode: PASSCODE,
      sessionSecret: crypto.randomBytes(32).toString('hex'),
    }),
    demoOperations: denyMutationRouter('transaction-operation'),
    demoRecurringApi: denyMutationRouter('recurring-operation'),
  };
  return {
    app: appModule.createApp({ catalogService: catalog, routers, requestLogger: null }),
    catalog,
    forbiddenMutationCalls,
    store,
  };
}

async function listen(app) {
  const server = await new Promise((resolve, reject) => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
    candidate.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('The Stage 7 browser fixture could not bind a loopback port.');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    ),
  };
}

async function firstExecutable(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next well-known Chrome/Chromium location.
    }
  }
  throw new Error(
    'Chrome or Chromium was not found. Set CHROME_PATH to run the Stage 7 browser smoke.'
  );
}

async function waitForFile(filePath, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited before DevTools started (code ${child.exitCode}).`);
    }
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the Chrome DevTools endpoint.');
}

async function startChrome() {
  const executable = await firstExecutable([
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]);
  const profileDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'phonepal-stage7-browser-')
  );
  const args = [
    '--headless=new',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-default-browser-check',
    '--no-first-run',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDirectory}`,
    'about:blank',
  ];
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    args.unshift('--no-sandbox');
  }
  let child;
  try {
    child = spawn(executable, args, { stdio: 'ignore' });
    const startupError = new Promise((resolve, reject) => {
      child.once('error', reject);
    });
    const endpointFile = path.join(profileDirectory, 'DevToolsActivePort');
    const endpointContents = await Promise.race([
      waitForFile(endpointFile, child),
      startupError,
    ]);
    const endpoint = endpointContents.trim().split(/\r?\n/);
    if (!/^\d+$/.test(endpoint[0] || '') || !endpoint[1]) {
      throw new Error('Chrome returned an invalid DevTools endpoint.');
    }
    return {
      child,
      profileDirectory,
      webSocketUrl: `ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`,
    };
  } catch (error) {
    if (child) await stopChild(child);
    await removeTemporaryProfile(profileDirectory);
    throw error;
  }
}

async function stopChild(child, timeoutMs = 5_000) {
  if (!child.pid || child.exitCode !== null) return;
  let onExit;
  const cleanupListeners = () => {
    child.off('exit', onExit);
    child.off('close', onExit);
  };
  const exited = new Promise((resolve) => {
    onExit = () => {
      cleanupListeners();
      resolve();
    };
    child.once('exit', onExit);
    child.once('close', onExit);
  });
  if (!child.kill('SIGTERM')) {
    cleanupListeners();
    return;
  }
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(true), timeoutMs);
    timeoutId.unref?.();
  });
  const timedOut = await Promise.race([exited.then(() => false), timeout]);
  clearTimeout(timeoutId);
  if (!timedOut || child.exitCode !== null) {
    cleanupListeners();
    return;
  }
  if (!child.kill('SIGKILL')) {
    cleanupListeners();
    return;
  }
  let killTimeoutId;
  const killTimeout = new Promise((resolve) => {
    killTimeoutId = setTimeout(resolve, timeoutMs);
    killTimeoutId.unref?.();
  });
  await Promise.race([exited, killTimeout]);
  clearTimeout(killTimeoutId);
  cleanupListeners();
}

async function removeTemporaryProfile(directory) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error.code) || attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

class DevToolsClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => this.receive(event.data));
    socket.addEventListener('close', () => {
      for (const { reject, timeoutId } of this.pending.values()) {
        clearTimeout(timeoutId);
        reject(new Error('Chrome DevTools connection closed.'));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    let timeoutId;
    await new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        socket.close();
        reject(new Error('Timed out connecting to Chrome DevTools.'));
      }, 10_000);
      timeoutId.unref?.();
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    }).finally(() => clearTimeout(timeoutId));
    return new DevToolsClient(socket);
  }

  receive(raw) {
    const message = JSON.parse(String(raw));
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeoutId);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }
    for (const listener of this.listeners.get(message.method) || []) {
      listener(message.params || {}, message.sessionId);
    }
  }

  on(method, listener) {
    const current = this.listeners.get(method) || [];
    current.push(listener);
    this.listeners.set(method, current);
  }

  send(method, params = {}, sessionId, timeoutMs = 10_000) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Chrome DevTools method ${method}.`));
      }, timeoutMs);
      timeoutId.unref?.();
      this.pending.set(id, { resolve, reject, timeoutId });
      try {
        this.socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timeoutId);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    this.socket.close();
  }
}

async function createPage(client) {
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await client.send('Page.enable', {}, sessionId);
  await client.send('Runtime.enable', {}, sessionId);
  await client.send('Network.enable', {}, sessionId);
  await client.send('Network.setBlockedURLs', {
    urls: ['https://js.braintreegateway.com/*'],
  }, sessionId);
  return sessionId;
}

async function setViewport(client, sessionId, width, height) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: width,
    screenHeight: height,
  }, sessionId);
  await evaluate(
    client,
    sessionId,
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
  );
}

async function evaluate(client, sessionId, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, sessionId);
  if (response.exceptionDetails) {
    const message = response.exceptionDetails.exception?.description ||
      response.exceptionDetails.text ||
      'Browser evaluation failed.';
    throw new Error(message);
  }
  return response.result?.value;
}

async function waitFor(client, sessionId, expression, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(client, sessionId, expression)) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`
  );
}

async function navigate(client, sessionId, url) {
  await client.send('Page.navigate', { url }, sessionId);
  await waitFor(
    client,
    sessionId,
    'document.readyState === "complete"',
    `page load at ${url}`
  );
}

async function submit(client, sessionId, expression) {
  try {
    await evaluate(client, sessionId, expression);
  } catch (error) {
    if (!/context|navigat|target/i.test(error.message)) throw error;
  }
}

async function auditRoutingDemoLayout(client, sessionId) {
  const viewports = [
    { width: 1440, height: 1000, workbenchColumns: 2, scenarioColumns: { min: 3 } },
    { width: 1024, height: 900, workbenchColumns: 2, scenarioColumns: { min: 3 } },
    { width: 768, height: 900, workbenchColumns: 1, scenarioColumns: { exact: 2 } },
    { width: 390, height: 844, workbenchColumns: 1, scenarioColumns: { exact: 1 } },
    { width: 320, height: 568, workbenchColumns: 1, scenarioColumns: { exact: 1 } },
  ];

  for (const viewport of viewports) {
    await setViewport(client, sessionId, viewport.width, viewport.height);
    const report = await evaluate(
      client,
      sessionId,
      `(() => {
        const visible = (element) => {
          if (!element || element.hidden) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const rectFor = (selector) => {
          const element = document.querySelector(selector);
          if (!visible(element)) return null;
          const rect = element.getBoundingClientRect();
          return { selector, width: rect.width, height: rect.height, top: rect.top, left: rect.left, bottom: rect.bottom };
        };
        const targetSelectors = [
          '.site-header .brand',
          '.demo-nav a',
          '.hero-start-link',
          '.scenario-preset',
          '.advanced-options > summary',
          '#preview-route',
          '#run-payment',
          '[data-catalog-refresh]'
        ];
        const targets = targetSelectors.flatMap((selector) =>
          [...document.querySelectorAll(selector)]
            .filter(visible)
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return { selector, text: element.textContent.trim().replace(/\\s+/g, ' '), width: rect.width, height: rect.height };
            })
        );
        const tinyText = [...document.querySelectorAll('header *, main *, footer *')]
          .filter(visible)
          .filter((element) => !element.closest('[aria-hidden="true"]'))
          .filter((element) => [...element.childNodes].some(
            (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== ''
          ))
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            className: typeof element.className === 'string' ? element.className : '',
            text: element.textContent.trim().replace(/\s+/g, ' ').slice(0, 80),
            fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
          }))
          .filter((item) => item.fontSize < 11.5);
        const scenarioLefts = [...document.querySelectorAll('.scenario-preset')]
          .filter(visible)
          .map((element) => Math.round(element.getBoundingClientRect().left));
        const checkout = rectFor('.checkout-panel');
        const inspector = rectFor('.inspector-panel');
        const workbenchColumns = checkout && inspector &&
          Math.abs(checkout.top - inspector.top) <= 2 && inspector.left > checkout.left
          ? 2
          : 1;
        return {
          viewport: { width: innerWidth, height: innerHeight },
          documentOverflow: Math.max(
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
            document.body.scrollWidth - document.body.clientWidth
          ),
          workbenchColumns,
          scenarioColumns: new Set(scenarioLefts).size,
          targets,
          tinyText,
        };
      })()`
    );

    const label = `${viewport.width}x${viewport.height}`;
    assert.deepEqual(report.viewport, {
      width: viewport.width,
      height: viewport.height,
    }, `${label} must use the requested CSS viewport`);
    assert.ok(
      report.documentOverflow <= 1,
      `${label} must not horizontally overflow the document (${report.documentOverflow}px)`
    );
    assert.equal(
      report.workbenchColumns,
      viewport.workbenchColumns,
      `${label} must use the intended checkout/inspector layout`
    );
    if (viewport.scenarioColumns.exact) {
      assert.equal(
        report.scenarioColumns,
        viewport.scenarioColumns.exact,
        `${label} must use ${viewport.scenarioColumns.exact} scenario column(s)`
      );
    } else {
      assert.ok(
        report.scenarioColumns >= viewport.scenarioColumns.min,
        `${label} must keep at least ${viewport.scenarioColumns.min} scenario columns`
      );
    }
    const undersized = report.targets.filter((target) =>
      target.width < 43.5 || target.height < 43.5
    );
    assert.deepEqual(
      undersized,
      [],
      `${label} has interactive targets smaller than 44px: ${JSON.stringify(undersized)}`
    );
    assert.deepEqual(
      report.tinyText,
      [],
      `${label} has visible text smaller than 12px: ${JSON.stringify(report.tinyText)}`
    );
  }

  await setViewport(client, sessionId, 1440, 1000);
  const contrastReport = await evaluate(
    client,
    sessionId,
    `(() => {
      const parseRgb = (value) => (value.match(/[0-9.]+/g) || []).slice(0, 3).map(Number);
      const luminance = (value) => {
        const channels = parseRgb(value).map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
      };
      const ratio = (foreground, background) => {
        const lighter = Math.max(luminance(foreground), luminance(background));
        const darker = Math.min(luminance(foreground), luminance(background));
        return (lighter + 0.05) / (darker + 0.05);
      };
      return ['.hero-start-link', '.demo-nav a.is-current', '.environment-pill']
        .map((selector) => {
          const style = getComputedStyle(document.querySelector(selector));
          return {
            selector,
            foreground: style.color,
            background: style.backgroundColor,
            ratio: ratio(style.color, style.backgroundColor),
          };
        });
    })()`
  );
  assert.deepEqual(
    contrastReport.filter((item) => item.ratio < 4.5),
    [],
    `key routing-demo text must meet WCAG AA contrast: ${JSON.stringify(contrastReport)}`
  );
  const skipLink = await evaluate(
    client,
    sessionId,
    `(() => {
      const link = document.querySelector('.skip-link');
      link.focus();
      const rect = link.getBoundingClientRect();
      const style = getComputedStyle(link);
      return {
        focused: document.activeElement === link,
        visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.top >= 0 && rect.width > 0 && rect.height >= 43.5,
      };
    })()`
  );
  assert.deepEqual(skipLink, { focused: true, visible: true }, 'the skip link must become visible when focused');

  await client.send('Emulation.setEmulatedMedia', {
    media: '',
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  }, sessionId);
  const reducedMotion = await evaluate(
    client,
    sessionId,
    `(() => {
      const seconds = (value) => value.split(',').reduce((total, item) => {
        const token = item.trim();
        return total + (token.endsWith('ms') ? Number.parseFloat(token) / 1000 : Number.parseFloat(token));
      }, 0);
      const selectors = ['.scenario-preset', '.hero-start-link', '.primary-button'];
      return {
        matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
        scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
        moving: selectors.flatMap((selector) => [...document.querySelectorAll(selector)])
          .filter((element) => {
            const style = getComputedStyle(element);
            return seconds(style.transitionDuration) > 0 || seconds(style.animationDuration) > 0;
          })
          .map((element) => element.className),
      };
    })()`
  );
  assert.equal(reducedMotion.matches, true, 'Chrome must emulate reduced motion');
  assert.equal(reducedMotion.scrollBehavior, 'auto', 'reduced motion must disable smooth scrolling');
  assert.deepEqual(reducedMotion.moving, [], 'reduced motion must remove key UI transitions and animations');
  await client.send('Emulation.setEmulatedMedia', { media: '', features: [] }, sessionId);
  await setViewport(client, sessionId, 1440, 1000);
  process.stdout.write('✓ Routing UI passes responsive, target-size, skip-link, and reduced-motion checks\n');
}

async function runSmoke(
  { baseUrl, catalog, forbiddenMutationCalls, store },
  client,
  sessionId
) {
  const uncaught = [];
  client.on('Runtime.exceptionThrown', (event, eventSessionId) => {
    if (eventSessionId === sessionId) {
      uncaught.push(event.exceptionDetails?.exception?.description || 'Uncaught browser error');
    }
  });
  client.on('Page.javascriptDialogOpening', (event, eventSessionId) => {
    if (eventSessionId === sessionId) {
      client.send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});
    }
  });

  await navigate(client, sessionId, `${baseUrl}/demo/preflight`);
  await waitFor(
    client,
    sessionId,
    'document.querySelector("h1")?.textContent.includes("Know what is ready")',
    'the preflight page'
  );
  assert.equal(catalog.refreshCount, 0, 'preflight GET must not refresh discovery');
  process.stdout.write('✓ Preflight renders without an automatic gateway refresh\n');

  await navigate(client, sessionId, `${baseUrl}/demo`);
  await waitFor(
    client,
    sessionId,
    'Boolean(document.querySelector("[data-scenario-id=\\"jpy-one-time\\"]"))',
    'the JPY one-time preset'
  );
  await auditRoutingDemoLayout(client, sessionId);
  await evaluate(
    client,
    sessionId,
    'document.querySelector("[data-scenario-id=\\"jpy-one-time\\"]").click()'
  );
  await waitFor(
    client,
    sessionId,
    'document.querySelector("#account-summary")?.textContent.includes("jpy-sales")',
    'the initial JPY one-time route'
  );
  await evaluate(
    client,
    sessionId,
    'document.querySelector("[data-scenario-id=\\"jpy-recurring\\"]").click()'
  );
  await waitFor(
    client,
    sessionId,
    'document.querySelector("#account-summary")?.textContent.includes("jpy-billing")',
    'the initial JPY recurring route'
  );
  process.stdout.write('✓ One-time and recurring presets resolve to their server-selected accounts\n');

  await navigate(client, sessionId, `${baseUrl}/demo/routes`);
  await waitFor(
    client,
    sessionId,
    'Boolean(document.querySelector("#presenter-passcode"))',
    'the presenter passcode form'
  );
  await submit(
    client,
    sessionId,
    `document.querySelector("#presenter-passcode").value = ${JSON.stringify(PASSCODE)}; document.querySelector(".route-login-form").requestSubmit(); true`
  );
  await waitFor(
    client,
    sessionId,
    'Boolean(document.querySelector(".route-policy-form"))',
    'the authenticated route editor'
  );
  await submit(
    client,
    sessionId,
    'document.querySelector("#route_JPY_one_time").value = "jpy-billing"; document.querySelector("#route_JPY_recurring").value = "jpy-sales"; document.querySelector(".route-policy-form").requestSubmit(); true'
  );
  await waitFor(
    client,
    sessionId,
    'document.body.textContent.includes("Route mapping saved")',
    'the route-save confirmation'
  );
  assert.deepEqual(
    catalog.getState().accounts
      .filter((entry) => entry.currency === 'JPY')
      .map((entry) => [entry.merchantAccountId, entry.paymentTypes]),
    [
      ['jpy-sales', ['recurring']],
      ['jpy-billing', ['one_time']],
    ]
  );

  await navigate(client, sessionId, `${baseUrl}/demo`);
  await waitFor(
    client,
    sessionId,
    'Boolean(document.querySelector("[data-scenario-id=\\"jpy-one-time\\"]"))',
    'the remapped JPY preset'
  );
  await evaluate(
    client,
    sessionId,
    'document.querySelector("[data-scenario-id=\\"jpy-one-time\\"]").click()'
  );
  await waitFor(
    client,
    sessionId,
    'document.querySelector("#account-summary")?.textContent.includes("jpy-billing")',
    'the remapped next route preview'
  );
  process.stdout.write('✓ A presenter edit changes the next route preview\n');

  await navigate(client, sessionId, `${baseUrl}/demo/routes`);
  await waitFor(
    client,
    sessionId,
    'Boolean(document.querySelector(".route-restore-section form"))',
    'the restore control'
  );
  await submit(
    client,
    sessionId,
    'document.querySelector("input[name=confirmRestore]").checked = true; document.querySelector(".route-restore-section form").requestSubmit(); true'
  );
  await waitFor(
    client,
    sessionId,
    'document.body.textContent.includes("Starting policy restored")',
    'the baseline restore confirmation'
  );
  assert.deepEqual(
    catalog.getState().accounts
      .filter((entry) => entry.currency === 'JPY')
      .map((entry) => [entry.merchantAccountId, entry.paymentTypes]),
    [
      ['jpy-sales', ['one_time']],
      ['jpy-billing', ['recurring']],
    ]
  );
  process.stdout.write('✓ Restore returns the local policy to its captured baseline\n');

  await navigate(client, sessionId, `${baseUrl}/demo`);
  await waitFor(
    client,
    sessionId,
    'Boolean(document.querySelector("[data-scenario-id=\\"jpy-one-time\\"]"))',
    'the restored JPY presets'
  );
  await evaluate(
    client,
    sessionId,
    'document.querySelector("[data-scenario-id=\\"jpy-one-time\\"]").click()'
  );
  await waitFor(
    client,
    sessionId,
    'document.querySelector("#account-summary")?.textContent.includes("jpy-sales")',
    'the restored one-time route preview'
  );
  await evaluate(
    client,
    sessionId,
    'document.querySelector("[data-scenario-id=\\"jpy-recurring\\"]").click()'
  );
  await waitFor(
    client,
    sessionId,
    'document.querySelector("#account-summary")?.textContent.includes("jpy-billing")',
    'the restored recurring route preview'
  );

  assert.ok(store.list().length > 0, 'route previews should have produced local evidence');
  await navigate(client, sessionId, `${baseUrl}/demo/log`);
  await waitFor(
    client,
    sessionId,
    'Boolean(document.querySelector("#reset-local-demo"))',
    'the local reset control'
  );
  await evaluate(client, sessionId, 'document.querySelector("#reset-local-demo").click()');
  await waitFor(
    client,
    sessionId,
    'document.body.textContent.includes("No events match these filters")',
    'the clean local event log'
  );
  assert.equal(store.list().length, 0);
  process.stdout.write('✓ One-click reset clears only the fixture’s local visible evidence\n');

  assert.deepEqual(
    forbiddenMutationCalls,
    [],
    'the presenter browser smoke must never touch a transaction-operation or recurring-mutation endpoint'
  );
  assert.deepEqual(uncaught, [], `uncaught browser errors: ${uncaught.join('\n')}`);
}

async function main() {
  let fixtureServer;
  let chrome;
  let client;
  try {
    const fixture = fixtureApplication();
    fixtureServer = await listen(fixture.app);
    chrome = await startChrome();
    client = await DevToolsClient.connect(chrome.webSocketUrl);
    const sessionId = await createPage(client);
    await runSmoke({ ...fixture, baseUrl: fixtureServer.baseUrl }, client, sessionId);
    process.stdout.write('Stage 7 real-browser smoke passed.\n');
  } finally {
    if (client) {
      try {
        await client.send('Browser.close');
      } catch {
        // Chrome may close the DevTools socket before acknowledging shutdown.
      }
      client.close();
    }
    if (chrome) {
      await stopChild(chrome.child);
      await removeTemporaryProfile(chrome.profileDirectory);
    }
    if (fixtureServer) await fixtureServer.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Stage 7 browser smoke failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
