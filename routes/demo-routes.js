'use strict';

const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');

const { getRuntimeCatalogService } = require('../lib/catalog/runtime');
const {
  PolicyUpdateError,
  createPolicyWriter,
} = require('../lib/catalog/policy-writer');

const PAYMENT_TYPES = Object.freeze(['one_time', 'recurring']);
const PAYMENT_TYPE_LABELS = Object.freeze({
  one_time: 'One-time payments',
  recurring: 'Recurring billing',
});
const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_LOCK_MS = 60_000;
const SESSION_MAX_AGE_MS = 30 * 60_000;
const RESTORE_CONFIRMATION = 'restore-starting-policy';
const NOTICE_COPY = Object.freeze({
  saved: {
    kind: 'success',
    title: 'Route mapping saved',
    message: 'Discovery accepted the policy and the live demo catalog now uses it.',
  },
  restored: {
    kind: 'success',
    title: 'Starting policy restored',
    message: 'The overlay captured before the first presenter edit is active again.',
  },
});

class RouteMappingProblem extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'RouteMappingProblem';
    this.status = status;
    this.code = code;
  }
}

function configuredPasscode(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function constantTimeEqual(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left)).digest();
  const rightDigest = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function csrfToken(sessionState) {
  if (typeof sessionState.csrfToken !== 'string') {
    sessionState.csrfToken = crypto.randomBytes(32).toString('base64url');
  }
  return sessionState.csrfToken;
}

function validCsrf(sessionState, submitted) {
  return (
    typeof sessionState?.csrfToken === 'string' &&
    typeof submitted === 'string' &&
    constantTimeEqual(sessionState.csrfToken, submitted)
  );
}

function securityHeaders(req, res, next) {
  res.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  next();
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
}

function safeCatalogState(service) {
  try {
    const state = service.getState();
    return state && typeof state === 'object' && !Array.isArray(state)
      ? state
      : null;
  } catch {
    return null;
  }
}

function paymentMethodLabel(account) {
  const paymentMethods = Array.isArray(account.paymentMethods)
    ? account.paymentMethods.filter((paymentMethod) =>
        ['card', 'paypal'].includes(paymentMethod)
      )
    : [];
  return paymentMethods.length > 0
    ? paymentMethods
        .map((paymentMethod) => (paymentMethod === 'paypal' ? 'PayPal' : 'Card'))
        .join(' · ')
    : 'None';
}

function displayTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not yet discovered';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/London',
  }).format(date);
}

function selectedAccountId(accounts, currency, paymentType) {
  return accounts.find(
    (account) =>
      account.status === 'active' &&
      account.currency === currency &&
      Array.isArray(account.paymentTypes) &&
      account.paymentTypes.includes(paymentType)
  )?.merchantAccountId || null;
}

function buildRouteMappingViewModel(
  state,
  { baselineAvailable = false, submittedAssignments = null } = {}
) {
  const catalogAvailable = state?.status === 'ok' && Array.isArray(state.accounts);
  const accounts = catalogAvailable ? state.accounts : [];
  const activeAccounts = accounts.filter((account) => account?.status === 'active');
  const currencies = [...new Set(activeAccounts.map((account) => account.currency))]
    .filter((currency) => /^[A-Z]{3}$/.test(currency || ''))
    .sort();
  const routeGroups = currencies.map((currency) => {
    const eligible = activeAccounts
      .filter((account) => account.currency === currency)
      .sort((left, right) =>
        left.merchantAccountId.localeCompare(right.merchantAccountId)
      );
    return {
      currency,
      routes: PAYMENT_TYPES.map((paymentType) => {
        const routeKey = `${currency}:${paymentType}`;
        const current = selectedAccountId(accounts, currency, paymentType);
        const selected = submittedAssignments?.has(routeKey)
          ? submittedAssignments.get(routeKey)
          : current;
        return {
          paymentType,
          paymentTypeLabel: PAYMENT_TYPE_LABELS[paymentType],
          fieldName: `route_${currency}_${paymentType}`,
          currentAccountId: current,
          isUnassigned: !selected,
          options: eligible.map((account) => ({
            merchantAccountId: account.merchantAccountId,
            label: account.label,
            isDefault: account.isDefault === true,
            selected: selected === account.merchantAccountId,
          })),
        };
      }),
    };
  });

  return {
    title: 'Presenter route mapping',
    catalogAvailable,
    catalogStatusLabel: catalogAvailable ? 'Catalog ready' : 'Catalog unavailable',
    catalogStatusClass: catalogAvailable ? 'is-ready' : 'is-blocked',
    catalogMessage: catalogAvailable
      ? 'Only active accounts discovered from the connected Sandbox gateway can be selected.'
      : state?.error?.message || 'Refresh Sandbox discovery before editing routes.',
    gatewayMerchantId:
      typeof state?.gatewayMerchantId === 'string'
        ? state.gatewayMerchantId
        : 'Not configured',
    discoveredAt:
      typeof state?.discoveredAt === 'string'
        ? displayTimestamp(state.discoveredAt)
        : 'Not yet discovered',
    policyStatus:
      typeof state?.policyStatus === 'string'
        ? state.policyStatus.replaceAll('_', ' ')
        : 'not loaded',
    routeGroups,
    hasRoutes: routeGroups.length > 0,
    accounts: accounts.map((account) => ({
      merchantAccountId: account.merchantAccountId,
      label: account.label,
      currency: account.currency,
      status: account.status,
      isDefault: account.isDefault === true,
      paymentMethodLabel: paymentMethodLabel(account),
      threeDSecureLabel:
        account.threeDSecurePolicy === 'required' ? 'Required' : 'Optional',
      roleLabel:
        Array.isArray(account.paymentTypes) && account.paymentTypes.length > 0
          ? account.paymentTypes.map((type) => PAYMENT_TYPE_LABELS[type]).join(' · ')
          : 'Available · not assigned',
    })),
    baselineAvailable,
  };
}

function assignmentsFromRequest(state, body = {}) {
  if (state?.status !== 'ok' || !Array.isArray(state.accounts)) {
    throw new RouteMappingProblem(
      503,
      'CATALOG_UNAVAILABLE',
      'The current Sandbox catalog is unavailable. Refresh discovery before saving.'
    );
  }
  const activeAccounts = state.accounts.filter((account) => account.status === 'active');
  const currencies = [...new Set(activeAccounts.map((account) => account.currency))]
    .filter((currency) => /^[A-Z]{3}$/.test(currency || ''))
    .sort();
  if (currencies.length === 0) {
    throw new RouteMappingProblem(
      503,
      'CATALOG_UNAVAILABLE',
      'No active Sandbox accounts are available for route mapping.'
    );
  }

  const assignments = [];
  const selected = new Map();
  for (const currency of currencies) {
    for (const paymentType of PAYMENT_TYPES) {
      const rawValue = body[`route_${currency}_${paymentType}`];
      if (Array.isArray(rawValue)) {
        throw new RouteMappingProblem(
          400,
          'POLICY_ASSIGNMENT_INVALID',
          'Each route must have one selection.'
        );
      }
      const merchantAccountId =
        typeof rawValue === 'string' && rawValue.trim() !== ''
          ? rawValue.trim()
          : null;
      assignments.push({ currency, paymentType, merchantAccountId });
      selected.set(`${currency}:${paymentType}`, merchantAccountId);
    }
  }
  return { assignments, selected };
}

function publicProblem(error) {
  if (error instanceof RouteMappingProblem) return error;
  if (error instanceof PolicyUpdateError) {
    const status = error.code === 'CATALOG_REFRESH_FAILED'
      ? 503
      : error.code === 'POLICY_ROLLBACK_FAILED'
        ? 500
        : error.code === 'CATALOG_CHANGED_DURING_UPDATE'
        ? 409
        : error.code === 'POLICY_ACCOUNT_INVALID'
          ? 409
          : error.code === 'POLICY_BASELINE_NOT_FOUND'
            ? 409
            : 400;
    return new RouteMappingProblem(status, error.code, error.message);
  }
  return new RouteMappingProblem(
    500,
    'ROUTE_MAPPING_FAILED',
    'The route mapping could not be changed safely. The previous overlay remains active.'
  );
}

function createDemoRoutesRouter({
  catalogService,
  getCatalogService = getRuntimeCatalogService,
  policyWriter = createPolicyWriter(),
  environment = process.env,
  presenterPasscode,
  sessionSecret,
  now = () => Date.now(),
} = {}) {
  if (!catalogService && typeof getCatalogService !== 'function') {
    throw new TypeError('A catalog service is required');
  }
  if (
    !policyWriter ||
    typeof policyWriter.save !== 'function' ||
    typeof policyWriter.restore !== 'function' ||
    typeof policyWriter.hasBaseline !== 'function'
  ) {
    throw new TypeError('A compatible routing policy writer is required');
  }

  const passcode = configuredPasscode(
    presenterPasscode === undefined
      ? environment.DEMO_PRESENTER_PASSCODE
      : presenterPasscode
  );
  const secret = configuredPasscode(sessionSecret) || crypto.randomBytes(48).toString('base64url');
  const router = express.Router();

  router.use(securityHeaders);
  router.use(session({
    name: 'phonepal.presenter',
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: SESSION_MAX_AGE_MS,
      path: '/demo/routes',
      secure: false,
    },
  }));

  function service() {
    return catalogService || getCatalogService();
  }

  function loginModel(req, additions = {}) {
    return {
      layout: false,
      title: 'Presenter route mapping',
      loginMode: true,
      passcodeConfigured: Boolean(passcode),
      csrfToken: csrfToken(req.session),
      ...additions,
    };
  }

  async function editorModel(req, additions = {}) {
    const state = safeCatalogState(service());
    let baselineAvailable = false;
    if (typeof state?.gatewayMerchantId === 'string') {
      try {
        baselineAvailable = await policyWriter.hasBaseline({
          merchantId: state.gatewayMerchantId,
        });
      } catch {
        baselineAvailable = false;
      }
    }
    return {
      layout: false,
      loginMode: false,
      csrfToken: csrfToken(req.session),
      notice: NOTICE_COPY[req.query?.notice] || null,
      ...buildRouteMappingViewModel(state, {
        baselineAvailable,
        submittedAssignments: additions.submittedAssignments,
      }),
      ...additions,
    };
  }

  function requireAuthentication(req, res, next) {
    if (req.session?.presenterAuthenticated === true) return next();
    return res.status(401).render('demo-routes', loginModel(req, {
      authenticationRequired: true,
    }));
  }

  function requireCsrf(req, res, next) {
    if (validCsrf(req.session, req.body?._csrf)) return next();
    return res.status(403).render('demo-routes', {
      ...(req.session?.presenterAuthenticated === true
        ? {
            layout: false,
            loginMode: false,
            title: 'Presenter route mapping',
            catalogAvailable: false,
            hasRoutes: false,
          }
        : loginModel(req)),
      problem: {
        code: 'FORM_EXPIRED',
        message: 'This form expired. Reload the page and try again.',
      },
    });
  }

  router.get('/', async (req, res, next) => {
    try {
      if (req.session?.presenterAuthenticated !== true) {
        return res.status(passcode ? 200 : 503).render(
          'demo-routes',
          loginModel(req)
        );
      }
      return res.render('demo-routes', await editorModel(req));
    } catch (error) {
      return next(error);
    }
  });

  router.post('/login', requireCsrf, async (req, res, next) => {
    try {
      if (!passcode) {
        return res.status(503).render('demo-routes', loginModel(req, {
          problem: {
            code: 'PASSCODE_NOT_CONFIGURED',
            message: 'Set DEMO_PRESENTER_PASSCODE in the local environment before using route mapping.',
          },
        }));
      }
      const lockedUntil = Number(req.session.loginLockedUntil || 0);
      if (lockedUntil > now()) {
        return res.status(429).render('demo-routes', loginModel(req, {
          problem: {
            code: 'LOGIN_TEMPORARILY_LOCKED',
            message: 'Too many attempts. Wait one minute, then reload and try again.',
          },
        }));
      }

      const submitted = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
      if (!constantTimeEqual(passcode, submitted)) {
        const failedAttempts = Number(req.session.failedLoginAttempts || 0) + 1;
        req.session.failedLoginAttempts = failedAttempts;
        if (failedAttempts >= LOGIN_ATTEMPT_LIMIT) {
          req.session.loginLockedUntil = now() + LOGIN_LOCK_MS;
          req.session.failedLoginAttempts = 0;
        }
        return res.status(401).render('demo-routes', loginModel(req, {
          problem: {
            code: 'LOGIN_FAILED',
            message: 'That presenter passcode was not accepted.',
          },
        }));
      }

      await regenerateSession(req);
      req.session.presenterAuthenticated = true;
      req.session.authenticatedAt = new Date(now()).toISOString();
      csrfToken(req.session);
      await saveSession(req);
      return res.redirect(303, '/demo/routes');
    } catch (error) {
      return next(error);
    }
  });

  router.post('/logout', requireAuthentication, requireCsrf, async (req, res, next) => {
    try {
      await destroySession(req);
      res.clearCookie('phonepal.presenter', { path: '/demo/routes' });
      return res.redirect(303, '/demo/routes');
    } catch (error) {
      return next(error);
    }
  });

  router.post('/save', requireAuthentication, requireCsrf, async (req, res, next) => {
    const currentService = service();
    const state = safeCatalogState(currentService);
    let submittedAssignments = null;
    try {
      const submitted = assignmentsFromRequest(state, req.body);
      submittedAssignments = submitted.selected;
      await policyWriter.save({
        merchantId: state.gatewayMerchantId,
        accounts: state.accounts,
        assignments: submitted.assignments,
        refresh: () => currentService.refresh(),
      });
      return res.redirect(303, '/demo/routes?notice=saved');
    } catch (error) {
      const problem = publicProblem(error);
      try {
        return res.status(problem.status).render(
          'demo-routes',
          await editorModel(req, {
            submittedAssignments,
            problem: { code: problem.code, message: problem.message },
          })
        );
      } catch (renderError) {
        return next(renderError);
      }
    }
  });

  router.post('/restore', requireAuthentication, requireCsrf, async (req, res, next) => {
    const currentService = service();
    const state = safeCatalogState(currentService);
    try {
      if (req.body?.confirmRestore !== RESTORE_CONFIRMATION) {
        throw new RouteMappingProblem(
          400,
          'RESTORE_CONFIRMATION_REQUIRED',
          'Confirm that you want to restore the starting policy.'
        );
      }
      if (state?.status !== 'ok' || typeof state.gatewayMerchantId !== 'string') {
        throw new RouteMappingProblem(
          503,
          'CATALOG_UNAVAILABLE',
          'The current Sandbox catalog is unavailable. Refresh discovery before restoring.'
        );
      }
      await policyWriter.restore({
        merchantId: state.gatewayMerchantId,
        refresh: () => currentService.refresh(),
      });
      return res.redirect(303, '/demo/routes?notice=restored');
    } catch (error) {
      const problem = publicProblem(error);
      try {
        return res.status(problem.status).render(
          'demo-routes',
          await editorModel(req, {
            problem: { code: problem.code, message: problem.message },
          })
        );
      } catch (renderError) {
        return next(renderError);
      }
    }
  });

  return router;
}

const router = createDemoRoutesRouter();
router.assignmentsFromRequest = assignmentsFromRequest;
router.buildRouteMappingViewModel = buildRouteMappingViewModel;
router.createDemoRoutesRouter = createDemoRoutesRouter;

module.exports = router;
module.exports.RESTORE_CONFIRMATION = RESTORE_CONFIRMATION;
module.exports.RouteMappingProblem = RouteMappingProblem;
module.exports.assignmentsFromRequest = assignmentsFromRequest;
module.exports.buildRouteMappingViewModel = buildRouteMappingViewModel;
module.exports.createDemoRoutesRouter = createDemoRoutesRouter;
