/**
 * @import { AssetEntry } from './asset-scanner.js'
 */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * ApplicationV2-based UI that displays all external world assets grouped by document type.
 * Opened by PackMyWorld.Start() after AssetScanner.scan() completes.
 */
export class AssetReportApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @override */
  static DEFAULT_OPTIONS = {
    id: 'pack-my-world-report',
    classes: ['pack-my-world'],
    tag: 'div',
    window: {
      title: 'Pack My World — Asset Report',
      resizable: true
    },
    position: {
      width: 900,
      height: 600
    }
  };

  /** @override */
  static PARTS = {
    main: {
      template: 'modules/pack-my-world/templates/asset-report.hbs'
    }
  };

  /**
   * @param {AssetEntry[]} assets - Full list returned by AssetScanner.scan().
   */
  constructor(assets) {
    super();
    /** @type {AssetEntry[]} */
    this._assets = assets;
    /** @type {string} Active filter tab. */
    this._activeTab = 'scene';
  }

  /** @override */
  async _prepareContext() {
    const tabs = ['scene', 'actor', 'item', 'journal', 'playlist'];

    const grouped = {};
    for (const tab of tabs) {
      grouped[tab] = this._assets.filter(a => a.documentType === tab);
    }

    const totalFound = this._assets.length;
    const totalExternal = this._assets.filter(a => a.isExternal).length;

    return {
      tabs,
      activeTab: this._activeTab,
      grouped,
      totalFound,
      totalExternal,
      worldPrefix: `worlds/${game.world.id}/my-assets/`
    };
  }

  /** @override */
  _onRender(context, options) {
    // Attach filter tab click handlers after each render.
    this.element.querySelectorAll('.pmw-tab').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this._activeTab = e.currentTarget.dataset.tab;
        this.render();
      });
    });
  }
}
