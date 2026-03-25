import { AssetScanner } from './asset-scanner.js';
import { AssetReportApp } from './asset-report-app.js';

/**
 * Global entry point exposed as PackMyWorld.
 * Registered on the window object so GMs can call PackMyWorld.Start() from the console.
 */
const PackMyWorld = {
  /**
   * Scans all world entities, opens the asset report UI,
   * then automatically starts the broken-link check.
   * @returns {Promise<void>}
   */
  async Start() {
    if (!game.user.isGM) {
      ui.notifications.warn('Pack My World: Only GMs can run the asset scanner.');
      return;
    }
    ui.notifications.info('Pack My World: Scanning world assets...');
    const assets = await AssetScanner.scan();
    const app = new AssetReportApp(assets);
    await app.render(true);
    app._onCheckLinks();
  }
};

window.PackMyWorld = PackMyWorld;

Hooks.once('ready', () => {
  // Register setting to persist the deny list across sessions.
  game.settings.register('pack-my-world', 'pathDenyList', {
    name: 'Path Deny List',
    hint: 'Newline-separated path prefixes to exclude from the asset report.',
    scope: 'world',
    config: false,
    type: String,
    default: ''
  });

  console.log('Pack My World | Ready. Call PackMyWorld.Start() to scan assets.');
});
