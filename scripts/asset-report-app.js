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

const STATUS_FILTERS = [
  { id: 'all',       label: 'All' },
  { id: 'broken',    label: 'Broken' },
  { id: 'possible',  label: 'Possible Match' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'copyable',  label: 'Copyable' },
  { id: 'copied',    label: 'Copied' },
  { id: 'external',  label: 'External' },
];

const OPENABLE_TYPES = new Set(['scene', 'actor', 'item', 'journal', 'macro', 'table', 'playlist']);

const MAX_CANDIDATES = 5;

/**
 * Splits a filename stem into lowercase tokens.
 * Handles kebab-case, snake_case, dot.case, spaces, and camelCase.
 * @param {string} stem
 * @returns {string[]}
 */
function stemToTokens(stem) {
  return stem
    .toLowerCase()
    // split camelCase: "DragonToken" → "Dragon Token"
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[-_.\s]+/)
    .filter(t => t.length > 1);
}

/**
 * Token overlap score: shared tokens / max(|a|, |b|)
 * Returns 0..1.
 * @param {string[]} tokensA
 * @param {string[]} tokensB
 * @returns {number}
 */
function tokenScore(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const setA = new Set(tokensA);
  const shared = tokensB.filter(t => setA.has(t)).length;
  return shared / Math.max(tokensA.length, tokensB.length);
}

/**
 * Derives the status key for a fully-annotated asset row.
 * @param {object} a
 */
function getStatusKey(a) {
  if (a.matchConfirmed)           return 'confirmed';
  if (a.hasCandidates)            return 'possible';
  if (a.isBroken)                 return 'broken';
  if (a.copyStatus === 'success') return 'copied';
  if (a.copyStatus === 'error')   return 'error';
  if (a.isExternal)               return 'external';
  return 'copyable';
}

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
    this._statusFilter = 'all';
    /** @type {Map<string, 'success'|'error'|'skip'>} */
    this._copyResults = new Map();
    this._copying = false;
    this._checkingLinks = false;
    this._fixingBroken = false;
    /**
     * Key: originalPath
     * Value: {
     *   candidates: Array<{ path: string, score: number, method: 'exact'|'stem'|'token' }>,
     *   confirmedIndex: number|null
     * }
     * @type {Map<string, { candidates: Array<{path:string,score:number,method:string}>, confirmedIndex: number|null }>}
     */
    this._possibleMatches = new Map();
    /** @type {Map<string, string[]> | null} */
    this._fileIndex = null;
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

    let baseAssets = grouped[this._activeTab] ?? [];
    if (this._activeTab === 'scene' && this._sceneSubFilter !== 'all')
      baseAssets = baseAssets.filter(a => a.documentSubType === this._sceneSubFilter);
    if (this._activeTab === 'compendium' && this._compendiumSubFilter !== 'all')
      baseAssets = baseAssets.filter(a => a.documentSubType === this._compendiumSubFilter);

    const annotated = baseAssets.map(a => {
      const match = this._possibleMatches.get(a.originalPath);
      const confirmedIndex = match ? match.confirmedIndex : null;
      const confirmed = confirmedIndex !== null && match.candidates[confirmedIndex] != null;
      const confirmedPath = confirmed ? match.candidates[confirmedIndex].path : null;

      // Candidates enriched with per-candidate flags for the template.
      const candidates = match ? match.candidates.map((c, i) => ({
        ...c,
        index: i,
        isConfirmed: i === confirmedIndex,
        scoreLabel: Math.round(c.score * 100) + '%',
        originalPath: a.originalPath
      })) : [];

      const hasCandidates = candidates.length > 0;
      const previewPath = a.isBroken ? (confirmedPath ?? (hasCandidates ? candidates[0].path : null)) : a.originalPath;

      return {
        ...a,
        copyStatus: this._copyResults.get(a.originalPath) ?? null,
        candidates,
        hasCandidates,
        matchConfirmed: confirmed,
        confirmedPath,
        previewPath,
        canOpenDocument: OPENABLE_TYPES.has(a.documentType)
      };
    });

    const statusFilters = STATUS_FILTERS.map(sf => ({
      ...sf,
      active: sf.id === this._statusFilter,
      count: sf.id === 'all'
        ? annotated.length
        : annotated.filter(a => getStatusKey(a) === sf.id).length
    }));

    const visibleAssets = this._statusFilter === 'all'
      ? annotated
      : annotated.filter(a => getStatusKey(a) === this._statusFilter);

    const copyDone = this._copyResults.size > 0;
    const copySuccessCount = [...this._copyResults.values()].filter(v => v === 'success').length;
    const copyErrorCount  = [...this._copyResults.values()].filter(v => v === 'error').length;
    const totalBroken = this._assets.filter(a => a.isBroken).length;
    const linkCheckDone = this._assets.some(a => a.isBroken !== undefined && a.isBroken !== false)
      || (this._assets.length > 0 && this._assets.every(a => a.isBroken !== undefined));
    const totalPossibleMatches = this._possibleMatches.size;
    const totalConfirmed = [...this._possibleMatches.values()].filter(v => v.confirmedIndex !== null).length;

    return {
      tabs,
      activeTab: this._activeTab,
      visibleAssets,
      statusFilters,
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
        this._statusFilter = 'all';
        this.render();
      });
    });

    this.element.querySelectorAll('.pmw-sub-tab[data-sub]').forEach(btn => {
      btn.addEventListener('click', e => {
        const value = e.currentTarget.dataset.sub;
        if (this._activeTab === 'scene') this._sceneSubFilter = value;
        else if (this._activeTab === 'compendium') this._compendiumSubFilter = value;
        this._statusFilter = 'all';
        this.render();
      });
    });

    this.element.querySelectorAll('.pmw-status-filter[data-status]').forEach(btn => {
      btn.addEventListener('click', e => {
        this._statusFilter = e.currentTarget.dataset.status;
        this.render();
      });
    });

    this.element.querySelectorAll('.pmw-open-doc-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        const { id, doctype } = e.currentTarget.dataset;
        this._onOpenDocument(id, doctype);
      });
    });

    const copyBtn = this.element.querySelector('#pmw-copy-btn');
    if (copyBtn) copyBtn.addEventListener('click', () => this._onCopyFiles());

    const checkBtn = this.element.querySelector('#pmw-check-links-btn');
    if (checkBtn) checkBtn.addEventListener('click', () => this._onCheckLinks());

    const fixBtn = this.element.querySelector('#pmw-fix-broken-btn');
    if (fixBtn) fixBtn.addEventListener('click', () => this._onFixBroken());

    // Confirm a specific candidate by index.
    this.element.querySelectorAll('.pmw-confirm-match-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        const { original, index } = e.currentTarget.dataset;
        const existing = this._possibleMatches.get(original);
        if (existing) {
          existing.confirmedIndex = parseInt(index, 10);
          this.render();
        }
      });
    });

    // Preview a specific candidate path.
    this.element.querySelectorAll('.pmw-preview-btn:not(.pmw-preview-btn--disabled)').forEach(btn => {
      btn.addEventListener('click', e => {
        const path = e.currentTarget.dataset.path;
        const type = e.currentTarget.dataset.type;
        this._onPreviewAsset(path, type);
      });
    });
  }

  /**
   * Opens the Foundry sheet/view for the given document.
   * @param {string} id
   * @param {string} doctype
   */
  _onOpenDocument(id, doctype) {
    let doc;
    switch (doctype) {
      case 'scene':    doc = game.scenes.get(id);    break;
      case 'actor':    doc = game.actors.get(id);    break;
      case 'item':     doc = game.items.get(id);     break;
      case 'journal':  doc = game.journal.get(id);   break;
      case 'macro':    doc = game.macros.get(id);    break;
      case 'table':    doc = game.tables.get(id);    break;
      case 'playlist': doc = game.playlists.get(id); break;
    }
    if (!doc) {
      ui.notifications.warn(`Pack My World: could not find ${doctype} with id "${id}".`);
      return;
    }
    if (doctype === 'scene') doc.view();
    else doc.sheet.render(true);
  }

  /**
   * Opens a preview for the given asset path.
   * @param {string} path
   * @param {'image'|'audio'|'video'|'unknown'} type
   */
  _onPreviewAsset(path, type) {
    if (!path) return;
    if (type === 'image') {
      new foundry.applications.apps.ImagePopout({
        src: path,
        window: { title: path.split('/').pop() }
      }).render(true);
    } else {
      const url = path.startsWith('http') ? path : `${window.location.origin}/${path}`;
      window.open(url, '_blank');
    }
  }

  /** @returns {Promise<void>} */
  async _onCheckLinks() {
    if (this._checkingLinks) return;
    this._checkingLinks = true;
    for (const a of this._assets) a.isBroken = false;
    this._possibleMatches.clear();
    this._fileIndex = null;
    this._statusFilter = 'all';
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

  /** @returns {Promise<void>} */
  async _onFixBroken() {
    if (this._fixingBroken) return;

    const brokenAssets = this._assets.filter(a => a.isBroken);
    if (brokenAssets.length === 0) {
      ui.notifications.info('Pack My World: No broken links to fix. Run Check Links first.');
      return;
    }

    this._fixingBroken = true;
    await this.render();

    // Build index if not cached.
    // Primary key: lowercase basename → [paths]
    // Secondary key: lowercase stem (no ext) → [paths]
    if (!this._fileIndex) {
      let allFiles = [];
      try {
        allFiles = await this._browseAllFiles('data', '');
      } catch (err) {
        console.warn('Pack My World | Fix Broken: could not browse Foundry Data:', err);
      }

      /** @type {Map<string, string[]>} keyed by lowercase basename */
      this._fileIndex = new Map();
      /** @type {Map<string, string[]>} keyed by lowercase stem (no extension) */
      this._stemIndex = new Map();
      /** @type {Array<{ path: string, tokens: string[] }>} for token search */
      this._tokenList = [];

      for (const filePath of allFiles) {
        const basename = filePath.split('/').pop();
        const lowerBasename = basename.toLowerCase();
        const dotIdx = lowerBasename.lastIndexOf('.');
        const stem = dotIdx > 0 ? lowerBasename.slice(0, dotIdx) : lowerBasename;
        const tokens = stemToTokens(stem);

        // basename index
        if (!this._fileIndex.has(lowerBasename)) this._fileIndex.set(lowerBasename, []);
        this._fileIndex.get(lowerBasename).push(filePath);

        // stem index
        if (!this._stemIndex.has(stem)) this._stemIndex.set(stem, []);
        this._stemIndex.get(stem).push(filePath);

        // token list
        if (tokens.length > 0) this._tokenList.push({ path: filePath, tokens });
      }
    }

    let found = 0;
    for (const asset of brokenAssets) {
      if (this._possibleMatches.has(asset.originalPath)) continue;

      const basename = asset.originalPath.split('/').pop();
      const lowerBasename = basename.toLowerCase();
      const dotIdx = lowerBasename.lastIndexOf('.');
      const stem = dotIdx > 0 ? lowerBasename.slice(0, dotIdx) : lowerBasename;
      const assetTokens = stemToTokens(stem);

      /** @type {Map<string, {score:number, method:string}>} deduplicated by path */
      const seen = new Map();

      const addCandidate = (path, score, method) => {
        const existing = seen.get(path);
        // keep highest score if path already found by another method
        if (!existing || existing.score < score) seen.set(path, { score, method });
      };

      // Phase 1 — exact basename match
      for (const p of (this._fileIndex.get(lowerBasename) ?? []))
        addCandidate(p, 1.0, 'exact');

      // Phase 2 — same stem, any extension
      for (const p of (this._stemIndex.get(stem) ?? [])) {
        const pBasename = p.split('/').pop().toLowerCase();
        if (pBasename !== lowerBasename) addCandidate(p, 0.9, 'stem');
      }

      // Phase 3 — token overlap (only if we have at least 2 tokens to avoid noise)
      if (assetTokens.length >= 2) {
        for (const entry of this._tokenList) {
          const sc = tokenScore(assetTokens, entry.tokens);
          if (sc >= 0.5) addCandidate(entry.path, sc * 0.85, 'token');
        }
      }

      if (seen.size === 0) continue;

      // Sort by score desc, cap at MAX_CANDIDATES.
      const candidates = [...seen.entries()]
        .map(([path, { score, method }]) => ({ path, score, method }))
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_CANDIDATES);

      this._possibleMatches.set(asset.originalPath, { candidates, confirmedIndex: null });
      found++;
    }

    this._fixingBroken = false;
    await this.render();

    if (found > 0) {
      ui.notifications.info(`Pack My World: Found candidates for ${found} broken link(s).`);
    } else {
      ui.notifications.warn('Pack My World: No candidates found for broken links.');
    }
  }

  /**
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

  /** @returns {Promise<void>} */
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
