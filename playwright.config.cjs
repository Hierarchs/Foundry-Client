const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({ testDir: './tests/e2e', timeout: 60000, workers: 1, fullyParallel: false, reporter: 'list' });
