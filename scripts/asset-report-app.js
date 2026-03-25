/**
 * @import { AssetEntry } from './asset-scanner.js'
 */

import { AssetCopier } from './asset-copier.js';
import { checkBrokenLinks } from './asset-scanner.js';

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
    position: { width: 1200, height: 680 }
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
    /** @type {boolean} True while broken-link check is running. */
    this._checkingLinks = false;
    /** @type {boolean} True while Fix Broken search is running. */
    this._fixingBroken = false;
    /**
     * Tracks possible-match results for broken assets.
     * Key: originalPath, Value: { matchPath: string, confirmed: boolean }
     * @type {Map<string, { matchPath: string, confirmed: boolean }>}
     */
    this._possibleMatches = new Map();
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

    // Annotate each visible asset with copy result, possible-match data, and resolved preview path.
    const annotated = visibleAssets.map(a => {
      const match = this._possibleMatches.get(a.originalPath);
      const possibleMatch = match ? match.matchPath : null;
      const matchConfirmed = match ? match.confirmed : false;

      // Determine the path the preview icon should use:
      // - broken with confirmed match  → matchPath
      // - broken with possible match   → matchPath
      // - broken, no match             → null (button disabled in template)
      // - everything else              → originalPath
      let previewPath;
      if (a.isBroken) {
        previewPath = (possibleMatch) ? possibleMatch : null;
      } else {
        previewPath = a.originalPath;
      }

      return {
        ...a,
        copyStatus: this._copyResults.get(a.originalPath) ?? null,
        possibleMatch,
        matchConfirmed,
        previewPath
      };
    });

    const copyDone = this._copyResults.size > 0;
    const copySuccessCount = [...this._copyResults.values()].filter(v => v === 'success').length;
    const copyErrorCount  = [...this._copyResults.values()].filter(v => v === 'error').length;
    const totalBroken = this._assets.filter(a => a.isBroken).length;
    const linkCheckDone = this._assets.some(a => a.isBroken !== undefined && a.isBroken !== false)
      || (this._assets.length > 0 && this._assets.every(a => a.isBroken !== undefined));
    const totalPossibleMatches = this._possibleMatches.size;
    const totalConfirmed = [...this._possibleMatches.values()].filter(v => v.confirmed).length;

    return {
      tabs,
      activeTab: this._activeTab,
      visibleAssets: annotated,
      totalFound: this._assets.length,
      totalExternal: this._assets.filter(a => a.isExternal).length,
      totalWildcard: this._assets.filter(a => a.isWildcard).length,
      totalBroken,
      linkCheckDone,
      checkingLinks: this._checkingLinks,
      fixingBroken: this._fixingBroken,
      hasBroken: totalBroken > 0,
      totalPossibleMatches,
      totalConfirmed,
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
    if (copyBtn) copyBtn.addEventListener('click', () => this._onCopyFiles());

    const checkBtn = this.element.querySelector('#pmw-check-links-btn');
    if (checkBtn) checkBtn.addEventListener('click', () => this._onCheckLinks());

    const fixBtn = this.element.querySelector('#pmw-fix-broken-btn');
    if (fixBtn) fixBtn.addEventListener('click', () => this._onFixBroken());

    this.element.querySelectorAll('.pmw-confirm-match-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        const originalPath = e.currentTarget.dataset.original;
        const existing = this._possibleMatches.get(originalPath);
        if (existing) {
          existing.confirmed = true;
          this.render();
        }
      });
    });

    this.element.querySelectorAll('.pmw-preview-btn:not(.pmw-preview-btn--disabled)').forEach(btn => {
      btn.addEventListener('click', e => {
        const path = e.currentTarget.dataset.path;
        const type = e.currentTarget.dataset.type;
        this._onPreviewAsset(path, type);
      });
    });
  }

  /**
   * Opens a preview for the given asset path.
   * Images use Foundry's ImagePopout; everything else opens in a new browser tab.
   * @param {string} path
   * @param {string} type  'image' | 'audio' | 'video' | 'unknown'
   */
  _onPreviewAsset(path, type) {
    if (!path) return;
    if (type === 'image') {
      const ip = new ImagePopout(path, { title: path.split('/').pop() });
      ip.render(true);
    } else {
      // For audio, video, unknown: open in new tab so the browser handles it natively.
      const url = path.startsWith('http') ? path : `${window.location.origin}/${path}`;
      window.open(url, '_blank');
    }
  }

  /**
   * Runs broken-link detection across all assets.
   * @returns {Promise<void>}
   */
  async _onCheckLinks() {
    if (this._checkingLinks) return;
    this._checkingLinks = true;
    for (const a of this._assets) a.isBroken = false;
    this._possibleMatches.clear();
    await this.render();

    await checkBrokenLinks(this._assets);

    this._checkingLinks = false;
    await this.render();

    const broken = this._assets.filter(a => a.isBroken).length;
    if (broken > 0) {
      ui.notifications.warn(`Pack My World: ${broken} broken link(s) found.`);
    } else {
      ui.notifications.info('Pack My World: No broken links found.');
    }
  }

  /**
   * Searches all Foundry Data for files matching broken-link filenames.
   * Updates _possibleMatches with found candidates.
   * Does NOT update any entity data — purely visual.
   * @returns {Promise<void>}
   */
  async _onFixBroken() {
    if (this._fixingBroken) return;

    const brokenAssets = this._assets.filter(a => a.isBroken);
    if (brokenAssets.length === 0) {
      ui.notifications.info('Pack My World: No broken links to fix. Run Check Links first.');
      return;
    }

    this._fixingBroken = true;
    await this.render();

    let allFiles = [];
    try {
      allFiles = await this._browseAllFiles('data', '');
    } catch (err) {
      console.warn('Pack My World | Fix Broken: could not browse Foundry Data:', err);
    }

    /** @type {Map<string, string[]>} */
    const byFilename = new Map();
    for (const filePath of allFiles) {
      const basename = filePath.split('/').pop().toLowerCase();
      if (!byFilename.has(basename)) byFilename.set(basename, []);
      byFilename.get(basename).push(filePath);
    }

    let found = 0;
    for (const asset of brokenAssets) {
      if (this._possibleMatches.has(asset.originalPath)) continue;
      const basename = asset.originalPath.split('/').pop().toLowerCase();
      const candidates = byFilename.get(basename) ?? [];
      if (candidates.length > 0) {
        this._possibleMatches.set(asset.originalPath, { matchPath: candidates[0], confirmed: false });
        found++;
      }
    }

    this._fixingBroken = false;
    await this.render();

    if (found > 0) {
      ui.notifications.info(`Pack My World: Found ${found} possible match(es) for broken links.`);
    } else {
      ui.notifications.warn('Pack My World: No matches found for broken links.');
    }
  }

  /**
   * Recursively browses a source/path and returns all file paths found.
   * @param {string} source
   * @param {string} dir
   * @param {number} [depth]
   * @returns {Promise<string[]>}
   */
  async _browseAllFiles(source, dir, depth = 0) {
    if (depth > 6) return [];
    const FP = foundry?.applications?.apps?.FilePicker?.implementation ?? FilePicker;
    let result;
    try {
      result = await FP.browse(source, dir || '.');
    } catch {
      return [];
    }
    const files = result.files ?? [];
    const dirs = result.dirs ?? [];
    const nested = await Promise.all(dirs.map(d => this._browseAllFiles(source, d, depth + 1)));
    return [...files, ...nested.flat()];
  }

  /**
   * Triggered by the Copy Files button.
   * @returns {Promise<void>}
   */
  async _onCopyFiles() {
    if (this._copying) return;

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
