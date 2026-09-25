import { createConfig } from './lib/config.js';
console.log('[jev] options loaded', await createConfig(chrome.storage.local).get());
