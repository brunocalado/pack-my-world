/**
 * @import { AssetEntry } from './asset-scanner.js'
 */

import { AssetCopier } from './asset-copier.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const SCENE_SUB_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'background', label: 'Backgrounds' },
  { id: 'token', label: 'Tokens' },
  { id: 'tile', label: 'Tiles' },
  { id: 'sound', label: 'Sounds' }
];

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
    position: { width: 960, height: 640 }
  };

  /** @override */
  static PARTS = {
    main: { template: 'modules/pack-my-world/templates/asset-report.hbs' }
  };

  /** @param {AssetEntry[]} assets */
  constructor(assets) {
    super();
    this._assets = assets;
    this._activeTab = 'scene';
    this._sceneSubFilter = 'all';
    this._compendiumSubFilter = 'all';
    /**
     * Tracks copy result per originalPath after Phase 2 runs.
     * @type {Map<string, 'success'|'error'|'skip'>}
     */
    this._copyResults = new Map();
    /** @type {boolean} True while copy is running — disables the Copy Files button. */
    this._copying = false;
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

    const sceneSubFilters = SCENE_SUB_FILTERS.map(sf => ({
      ...sf,
      active: sf.id === this._sceneSubFilter,
      count: sf.id === 'all'
        ? grouped['scene'].length
        : grouped['scene'].filter(a => a.documentSubType === sf.id).length
    }));

    const packLabels = [...new Set(grouped['compendium'].map(a => a.documentSubType).filter(Boolean))].sort();
    const compendiumSubFilters = [
      { id: 'all', label: 'All Packs', active: this._compendiumSubFilter === 'all', count: grouped['compendium'].length },
      ...packLabels.map(label => ({
        id: label,
        label,
        active: this._compendiumSubFilter === label,
        count: grouped['compendium'].filter(a => a.documentSubType === label).length
      }))
    ];

    let visibleAssets = grouped[this._activeTab] ?? [];
    if (this._activeTab === 'scene' && this._sceneSubFilter !== 'all')
      visibleAssets = visibleAssets.filter(a => a.documentSubType === this._sceneSubFilter);
    if (this._activeTab === 'compendium' && this._compendiumSubFilter !== 'all')
      visibleAssets = visibleAssets.filter(a => a.documentSubType === this._compendiumSubFilter);

    // Annotate each visible asset with its copy result if Phase 2 has run.
    const annotated = visibleAssets.map(a => ({
      ...a,
      copyStatus: this._copyResults.get(a.originalPath) ?? null
    }));

    const copyDone = this._copyResults.size > 0;
    const copySuccessCount = [...this._copyResults.values()].filter(v => v === 'success').length;
    const copyErrorCount  = [...this._copyResults.values()].filter(v => v === 'error').length;

    return {
      tabs,
      activeTab: this._activeTab,
      visibleAssets: annotated,
      totalFound: this._assets.length,
      totalExternal: this._assets.filter(a => a.isExternal).length,
      totalWildcard: this._assets.filter(a => a.isWildcard).length,
      showSceneSubFilters: this._activeTab === 'scene',
      sceneSubFilters,
      showCompendiumSubFilters: this._activeTab === 'compendium',
      compendiumSubFilters,
      copying: this._copying,
      copyDone,
      copySuccessCount,
      copyErrorCount
    };
  }

  /** @override */
  _onRender(context, options) {
    this.element.querySelectorAll('.pmw-tab').forEach(btn => {
      btn.addEventListener('click', e => {
        this._activeTab = e.currentTarget.dataset.tab;
        this._sceneSubFilter = 'all';
        this._compendiumSubFilter = 'all';
        this.render();
      });
    });

    this.element.querySelectorAll('.pmw-sub-tab[data-sub]').forEach(btn => {
      btn.addEventListener('click', e => {
        const value = e.currentTarget.dataset.sub;
        if (this._activeTab === 'scene') this._sceneSubFilter = value;
        else if (this._activeTab === 'compendium') this._compendiumSubFilter = value;
        this.render();
      });
    });

    const copyBtn = this.element.querySelector('#pmw-copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => this._onCopyFiles());
    }
  }

  /**
   * Triggered by the Copy Files button.
   * Shows a confirmation dialog warning about duration, then starts the copy.
   * Triggered by user action in _onRender.
   * @returns {Promise<void>}
   */
  async _onCopyFiles() {
    if (this._copying) return;

    // Native V13 dialog for confirmation.
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Pack My World — Copy Files' },
      content: `
        <p>This will copy <strong>${this._assets.filter(a => !a.isAlreadyInWorld).length} files</strong>
        into <code>worlds/${game.world.id}/my-assets/</code>.</p>
        <p>This process can take a long time depending on the number and size of assets.
        Do not close Foundry while it is running.</p>
        <p><strong>Document paths will NOT be updated in this step.</strong></p>
      `,
      yes: { label: 'Start Copying', icon: 'fa-solid fa-copy' },
      no:  { label: 'Cancel' }
    });

    if (!confirmed) return;

    this._copying = true;
    this._copyResults.clear();
    await this.render();

    await AssetCopier.copyAll(this._assets, (originalPath, status) => {
      this._copyResults.set(originalPath, status);
    });

    this._copying = false;
    await this.render();

    const successCount = [...this._copyResults.values()].filter(v => v === 'success').length;
    const errorCount   = [...this._copyResults.values()].filter(v => v === 'error').length;
    ui.notifications.info(
      `Pack My World: Copy complete. ${successCount} copied, ${errorCount} failed.`
    );
  }
}
