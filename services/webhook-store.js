const MAX_EVENTS = 50;
const events = [];

function add(event) {
  events.unshift(event);

  if (events.length > MAX_EVENTS) {
    events.pop();
  }
}

function list() {
  return [...events];
}

module.exports = {
  add,
  list,
};
