import { AssetScanner } from './asset-scanner.js';
import { AssetReportApp } from './asset-report-app.js';

/**
 * Global entry point exposed as PackMyWorld.
 * Registered on the window object so GMs can call PackMyWorld.Start() from the console.
 */
const PackMyWorld = {
  /**
   * Scans all world entities and opens the asset report UI.
   * @returns {Promise<void>}
   */
  async Start() {
    if (!game.user.isGM) {
      ui.notifications.warn('Pack My World: Only GMs can run the asset scanner.');
      return;
    }
    ui.notifications.info('Pack My World: Scanning world assets...');
    const assets = await AssetScanner.scan();
    new AssetReportApp(assets).render(true);
  }
};

window.PackMyWorld = PackMyWorld;

Hooks.once('ready', () => {
  console.log('Pack My World | Ready. Call PackMyWorld.Start() to scan assets.');
});
