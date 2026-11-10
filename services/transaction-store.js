const MAX_TRANSACTIONS = 100;
const transactions = new Map();

function add(transaction) {
  transactions.set(transaction.transactionId, {
    ...transaction,
    recordedAt: new Date().toISOString(),
  });

  if (transactions.size > MAX_TRANSACTIONS) {
    const oldestId = transactions.keys().next().value;
    transactions.delete(oldestId);
  }
}

function get(transactionId) {
  const transaction = transactions.get(transactionId);
  return transaction ? { ...transaction } : null;
}

module.exports = {
  add,
  get,
};
