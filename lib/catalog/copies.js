'use strict';

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);

  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }

  return Object.freeze(value);
}

function frozenCopy(value) {
  return deepFreeze(structuredClone(value));
}

module.exports = {
  deepFreeze,
  frozenCopy,
};
