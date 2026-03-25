/**
 * @import { AssetEntry } from './asset-scanner.js'
 */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// Sub-filter options available when the active tab is 'scene'.
const SCENE_SUB_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'background', label: 'Backgrounds' },
  { id: 'token', label: 'Tokens' },
  { id: 'tile', label: 'Tiles' },
  { id: 'sound', label: 'Sounds' }
];

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
      width: 960,
      height: 640
    }
  };

  /** @override */
  static PARTS = {
    main: {
      template: 'modules/pack-my-world/templates/asset-report.hbs'
    }
  };

  /** @param {AssetEntry[]} assets */
  constructor(assets) {
    super();
    /** @type {AssetEntry[]} */
    this._assets = assets;
    /** @type {string} */
    this._activeTab = 'scene';
    /** @type {string} Active sub-filter for scene tab. */
    this._sceneSubFilter = 'all';
  }

  /** @override */
  async _prepareContext() {
    const tabIds = ['scene', 'actor', 'item', 'journal', 'playlist', 'macro', 'table', 'compendium'];

    const grouped = {};
    for (const t of tabIds) grouped[t] = this._assets.filter(a => a.documentType === t);

    const tabs = tabIds.map(t => ({
      id: t,
      label: t.charAt(0).toUpperCase() + t.slice(1),
      count: grouped[t].length,
      active: t === this._activeTab
    }));

    // Apply scene sub-filter to the visible list.
    let visibleAssets = grouped[this._activeTab] ?? [];
    if (this._activeTab === 'scene' && this._sceneSubFilter !== 'all') {
      visibleAssets = visibleAssets.filter(a => a.documentSubType === this._sceneSubFilter);
    }

    const sceneSubFilters = SCENE_SUB_FILTERS.map(sf => ({
      ...sf,
      active: sf.id === this._sceneSubFilter,
      // Show count for 'all' as total, others filtered.
      count: sf.id === 'all'
        ? grouped['scene'].length
        : grouped['scene'].filter(a => a.documentSubType === sf.id).length
    }));

    return {
      tabs,
      activeTab: this._activeTab,
      visibleAssets,
      totalFound: this._assets.length,
      totalExternal: this._assets.filter(a => a.isExternal).length,
      showSceneSubFilters: this._activeTab === 'scene',
      sceneSubFilters
    };
  }

  /** @override */
  _onRender(context, options) {
    this.element.querySelectorAll('.pmw-tab').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this._activeTab = e.currentTarget.dataset.tab;
        this._sceneSubFilter = 'all';
        this.render();
      });
    });

    this.element.querySelectorAll('.pmw-sub-tab').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this._sceneSubFilter = e.currentTarget.dataset.sub;
        this.render();
      });
    });
  }
}
