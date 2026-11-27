'use strict';

const { loadConfig } = require('./backend/config');
const { createStore } = require('./backend/store');
const { createModerator } = require('./backend/moderation');
const { createTwitchService } = require('./backend/twitchService');
const { createApp } = require('./backend/app');

const config = loadConfig();
const store = createStore({ file: config.dataFile });
const moderate = createModerator({ providerName: config.moderationProvider, timeoutMs: config.moderationTimeoutMs });
const twitch = createTwitchService({ secretKeys: config.secretKeys, apiClientId: config.apiClientId, apiClientSecret: config.apiClientSecret });
const app = createApp({ config, store, moderate, twitch });

app.server.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log('ChallengeLive is running on port ' + config.port + (config.devHarness ? ' (TEST MODE with fake Twitch)' : ''));
});

function shutdown() {
  store.close();
  app.close();
  app.server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
