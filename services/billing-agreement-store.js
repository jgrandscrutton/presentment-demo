const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const environment = require('../config/environment');

class AgreementNotFoundError extends Error {
  constructor(id) {
    super(`Billing agreement ${id} was not found.`);
    this.name = 'AgreementNotFoundError';
    this.statusCode = 404;
  }
}

class BillingAgreementStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = null;
    this.queue = Promise.resolve();
  }

  runExclusive(operation) {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }

  async load() {
    if (this.state) {
      return;
    }

    try {
      const contents = await fs.readFile(this.filePath, 'utf8');
      const state = JSON.parse(contents);

      if (state.version !== 1 || !Array.isArray(state.agreements)) {
        throw new Error('The billing agreement store has an unsupported format.');
      }

      this.state = state;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      this.state = { version: 1, agreements: [] };
    }
  }

  async write(state) {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });

    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  async create(agreement) {
    return this.runExclusive(async () => {
      await this.load();

      if (this.state.agreements.some(item => item.id === agreement.id)) {
        throw new Error(`Billing agreement ${agreement.id} already exists.`);
      }

      const nextState = structuredClone(this.state);
      nextState.agreements.push(structuredClone(agreement));
      await this.write(nextState);
      this.state = nextState;
      return structuredClone(agreement);
    });
  }

  async get(id) {
    return this.runExclusive(async () => {
      await this.load();
      const agreement = this.state.agreements.find(item => item.id === id);
      return agreement ? structuredClone(agreement) : null;
    });
  }

  async require(id) {
    const agreement = await this.get(id);
    if (!agreement) {
      throw new AgreementNotFoundError(id);
    }
    return agreement;
  }

  async list() {
    return this.runExclusive(async () => {
      await this.load();
      return structuredClone(this.state.agreements);
    });
  }

  async listDue(now, limit) {
    const dueAt = new Date(now).getTime();

    return this.runExclusive(async () => {
      await this.load();
      return structuredClone(this.state.agreements
        .filter(agreement => (
          agreement.status === 'active' &&
          agreement.nextChargeAt &&
          !agreement.inFlight &&
          new Date(agreement.nextChargeAt).getTime() <= dueAt
        ))
        .sort((left, right) => left.nextChargeAt.localeCompare(right.nextChargeAt))
        .slice(0, limit));
    });
  }

  async update(id, updater) {
    return this.runExclusive(async () => {
      await this.load();
      const index = this.state.agreements.findIndex(item => item.id === id);

      if (index === -1) {
        throw new AgreementNotFoundError(id);
      }

      const current = structuredClone(this.state.agreements[index]);
      const updated = updater(current);

      if (!updated || updated.id !== id) {
        throw new Error('Billing agreement updates must preserve the agreement ID.');
      }

      updated.updatedAt = new Date().toISOString();
      const nextState = structuredClone(this.state);
      nextState.agreements[index] = structuredClone(updated);
      await this.write(nextState);
      this.state = nextState;
      return structuredClone(updated);
    });
  }

  async markInterruptedChargesForReview() {
    return this.runExclusive(async () => {
      await this.load();
      let changed = false;

      const nextState = structuredClone(this.state);
      nextState.agreements = nextState.agreements.map(agreement => {
        if (!agreement.inFlight) {
          return agreement;
        }

        changed = true;
        return {
          ...agreement,
          status: 'review_required',
          nextChargeAt: null,
          lastError: 'The process stopped during a charge. Verify the order ID in Braintree before resolving.',
          updatedAt: new Date().toISOString(),
        };
      });

      if (changed) {
        await this.write(nextState);
        this.state = nextState;
      }

      return changed;
    });
  }
}

const billingAgreementStore = new BillingAgreementStore(environment.billing.storePath);

module.exports = {
  AgreementNotFoundError,
  BillingAgreementStore,
  billingAgreementStore,
};
