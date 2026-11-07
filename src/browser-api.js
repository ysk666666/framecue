(function initFrameCueApi(root) {
  'use strict';

  // Chrome exposes promise-returning methods on chrome.*, while Firefox keeps
  // the chrome.* namespace callback-only and only returns promises from
  // browser.*. Wrapping the callback style works identically in both engines,
  // so every promise-based call in the extension goes through this bridge.
  const chromeApi = root.chrome;

  function isAvailable() {
    return Boolean(chromeApi && chromeApi.runtime);
  }

  function method(owner, name) {
    return owner && typeof owner[name] === 'function' ? owner[name].bind(owner) : null;
  }

  function call(rawMethod, ...args) {
    return new Promise((resolve, reject) => {
      if (typeof rawMethod !== 'function') {
        reject(new Error('FrameCue: extension API unavailable'));
        return;
      }
      let settled = false;
      try {
        rawMethod(...args, (result) => {
          settled = true;
          const error = chromeApi.runtime && chromeApi.runtime.lastError;
          if (error) {
            reject(new Error(error.message || String(error)));
            return;
          }
          resolve(result);
        });
      } catch (error) {
        if (!settled) {
          reject(error);
        }
      }
    });
  }

  function storageArea(areaName) {
    return chromeApi && chromeApi.storage ? chromeApi.storage[areaName] : null;
  }

  const api = {
    isAvailable,
    call,
    storage: {
      get(areaName, key) {
        return call(method(storageArea(areaName), 'get'), key);
      },
      set(areaName, value) {
        return call(method(storageArea(areaName), 'set'), value);
      },
      remove(areaName, key) {
        return call(method(storageArea(areaName), 'remove'), key);
      },
    },
    permissions: {
      contains(origins) {
        return call(method(chromeApi && chromeApi.permissions, 'contains'), { origins });
      },
      request(origins) {
        return call(method(chromeApi && chromeApi.permissions, 'request'), { origins });
      },
      remove(origins) {
        return call(method(chromeApi && chromeApi.permissions, 'remove'), { origins });
      },
      getAll() {
        return call(method(chromeApi && chromeApi.permissions, 'getAll'));
      },
    },
    scripting: {
      executeScript(details) {
        return call(method(chromeApi && chromeApi.scripting, 'executeScript'), details);
      },
    },
  };

  root.FrameCueApi = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
