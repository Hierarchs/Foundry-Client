'use strict';
const fs = require('node:fs');
const path = require('node:path');
const adapter = fs.readFileSync(path.join(__dirname, 'foundry-adapter.js'), 'utf8');
function readScript() { return `(() => {${adapter}; return readFoundry(); })()`; }
function settingsScript(values, restore = false) { return `(async () => {${adapter}; return await changeFoundrySettings(${JSON.stringify(values)}, ${restore === true}); })()`; }
module.exports = { readScript, settingsScript };
