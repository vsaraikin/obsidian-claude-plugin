// The Agent SDK passes AbortSignals to events.setMaxListeners. In Obsidian's Electron renderer the
// global AbortController is the DOM one, and Node's setMaxListeners rejects DOM signals with
// ERR_INVALID_ARG_TYPE. Raising a listener limit is only about leak warnings, so skip it there.
const events = require("node:events");

function setMaxListeners(n, ...targets) {
  try {
    return events.setMaxListeners(n, ...targets);
  } catch {
    return undefined;
  }
}

module.exports = new Proxy(events, {
  get: (target, key, receiver) => (key === "setMaxListeners" ? setMaxListeners : Reflect.get(target, key, receiver)),
});
