/**
 * @typedef {Object} AssetEntry
 * @property {string} originalPath
 * @property {string} proposedPath
 * @property {'image'|'audio'|'video'|'unknown'} type
 * @property {string} documentName
 * @property {'scene'|'actor'|'item'|'journal'|'playlist'|'macro'|'table'|'compendium'} documentType
 * @property {string|null} documentSubType  - scene: 'background'|'token'|'tile'|'sound'; compendium: pack label
 * @property {string} documentId
 * @property {boolean} isExternal
 * @property {boolean} isAlreadyInWorld
 */

const WORLD_PREFIX = () => `worlds/${game.world.id}/`;
const MY_ASSETS_PREFIX = () => `worlds/${game.world.id}/my-assets/`;

/** @param {string} path @returns {boolean} */
function isExternalUrl(path) {
  return typeof path === 'string' && (path.startsWith('http://') || path.startsWith('https://'));
}

/** @param {string} path @returns {boolean} */
function isAlreadyInWorld(path) {
  return typeof path === 'string' && path.startsWith(WORLD_PREFIX());
}

/** @param {string} path @returns {'image'|'audio'|'video'|'unknown'} */
function inferType(path) {
  if (!path) return 'unknown';
  const ext = path.split('.').pop().toLowerCase().split('?')[0];
  if (['png','jpg','jpeg','webp','gif','svg','avif'].includes(ext)) return 'image';
  if (['mp3','ogg','wav','flac','m4a','aac'].includes(ext)) return 'audio';
  if (['mp4','webm','ogv'].includes(ext)) return 'video';
  return 'unknown';
}

/** @param {string} originalPath @returns {string} */
function buildProposedPath(originalPath) {
  if (isExternalUrl(originalPath)) {
    try {
      const url = new URL(originalPath);
      return MY_ASSETS_PREFIX() + 'external' + url.pathname;
    } catch {
      return MY_ASSETS_PREFIX() + 'external/' + originalPath.replace(/[^a-zA-Z0-9._-]/g, '_');
    }
  }
  return MY_ASSETS_PREFIX() + originalPath;
}

/**
 * @param {string} path
 * @param {string} documentName
 * @param {AssetEntry['documentType']} documentType
 * @param {string} documentId
 * @param {string|null} [documentSubType]
 * @returns {AssetEntry|null}
 */
function makeEntry(path, documentName, documentType, documentId, documentSubType = null) {
  if (!path || typeof path !== 'string' || path.trim() === '') return null;
  if (path.startsWith('icons/') || path.startsWith('ui/')) return null;

  return {
    originalPath: path,
    proposedPath: buildProposedPath(path),
    type: inferType(path),
    documentName,
    documentType,
    documentSubType,
    documentId,
    isExternal: isExternalUrl(path),
    isAlreadyInWorld: isAlreadyInWorld(path)
  };
}

/** @param {string} html @returns {string[]} */
function extractImgSrcsFromHtml(html) {
  if (!html) return [];
  return [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
}

export class AssetScanner {
  /**
   * Scans all world entities and world compendiums for external asset references.
   * @returns {Promise<AssetEntry[]>}
   */
  static async scan() {
    const entries = [];
    AssetScanner._scanScenes(entries);
    AssetScanner._scanActors(entries);
    AssetScanner._scanItems(entries);
    AssetScanner._scanJournals(entries);
    AssetScanner._scanPlaylists(entries);
    AssetScanner._scanMacros(entries);
    AssetScanner._scanTables(entries);
    await AssetScanner._scanWorldCompendiums(entries);
    return entries.filter(e => e !== null);
  }

  /** @param {AssetEntry[]} entries */
  static _scanScenes(entries) {
    for (const scene of game.scenes) {
      const name = scene.name;
      const id = scene.id;
      const push = (path, label, subType) => {
        const e = makeEntry(path, label ?? name, 'scene', id, subType);
        if (e && !e.isAlreadyInWorld) entries.push(e);
      };
      push(scene.background?.src, name, 'background');
      push(scene.foreground, `${name} › Foreground`, 'background');
      push(scene.fog?.overlay, `${name} › Fog Overlay`, 'background');
      for (const token of scene.tokens) push(token.texture?.src, `${name} › Token: ${token.name}`, 'token');
      for (const tile of scene.tiles) push(tile.texture?.src, `${name} › Tile`, 'tile');
      for (const sound of scene.sounds) push(sound.path, `${name} › Sound`, 'sound');
    }
  }

  /** @param {AssetEntry[]} entries */
  static _scanActors(entries) {
    for (const actor of game.actors) {
      const push = (path, label) => {
        const e = makeEntry(path, label ?? actor.name, 'actor', actor.id);
        if (e && !e.isAlreadyInWorld) entries.push(e);
      };
      push(actor.img);
      push(actor.prototypeToken?.texture?.src, `${actor.name} › Token`);
    }
  }

  /** @param {AssetEntry[]} entries */
  static _scanItems(entries) {
    for (const item of game.items) {
      const e = makeEntry(item.img, item.name, 'item', item.id);
      if (e && !e.isAlreadyInWorld) entries.push(e);
    }
  }

  /** @param {AssetEntry[]} entries */
  static _scanJournals(entries) {
    for (const journal of game.journal) {
      for (const page of journal.pages) {
        if (page.src) {
          const e = makeEntry(page.src, `${journal.name} › ${page.name}`, 'journal', journal.id);
          if (e && !e.isAlreadyInWorld) entries.push(e);
        }
        for (const src of extractImgSrcsFromHtml(page.text?.content)) {
          const e = makeEntry(src, `${journal.name} › ${page.name} (inline)`, 'journal', journal.id);
          if (e && !e.isAlreadyInWorld) entries.push(e);
        }
      }
    }
  }

  /** @param {AssetEntry[]} entries */
  static _scanPlaylists(entries) {
    for (const playlist of game.playlists) {
      for (const sound of playlist.sounds) {
        const e = makeEntry(sound.path, `${playlist.name} › ${sound.name}`, 'playlist', playlist.id);
        if (e && !e.isAlreadyInWorld) entries.push(e);
      }
    }
  }

  /** @param {AssetEntry[]} entries */
  static _scanMacros(entries) {
    for (const macro of game.macros) {
      const e = makeEntry(macro.img, macro.name, 'macro', macro.id);
      if (e && !e.isAlreadyInWorld) entries.push(e);
    }
  }

  /** @param {AssetEntry[]} entries */
  static _scanTables(entries) {
    for (const table of game.tables) {
      const eTable = makeEntry(table.img, table.name, 'table', table.id);
      if (eTable && !eTable.isAlreadyInWorld) entries.push(eTable);
      for (const result of table.results) {
        const e = makeEntry(result.img, `${table.name} › ${result.text}`, 'table', table.id);
        if (e && !e.isAlreadyInWorld) entries.push(e);
      }
    }
  }

  /**
   * Scans world-owned compendium packs only.
   * documentSubType is set to the pack label so the UI can sub-filter by pack.
   * @param {AssetEntry[]} entries
   * @returns {Promise<void>}
   */
  static async _scanWorldCompendiums(entries) {
    const worldPacks = game.packs.filter(p => p.metadata.packageType === 'world');

    for (const pack of worldPacks) {
      const packLabel = pack.metadata.label;
      let documents;
      try {
        documents = await pack.getDocuments();
      } catch (err) {
        console.warn(`Pack My World | Could not load compendium "${packLabel}": ${err.message}`);
        continue;
      }

      const push = (path, label) => {
        // documentSubType carries the pack label for compendium sub-filtering.
        const e = makeEntry(path, label, 'compendium', pack.collection, packLabel);
        if (e && !e.isAlreadyInWorld) entries.push(e);
      };

      for (const doc of documents) {
        const label = `[${packLabel}] ${doc.name}`;
        if (doc.documentName === 'Actor') {
          push(doc.img, label);
          push(doc.prototypeToken?.texture?.src, `${label} › Token`);
        } else if (doc.documentName === 'Item') {
          push(doc.img, label);
        } else if (doc.documentName === 'Scene') {
          push(doc.background?.src, label);
          for (const t of (doc.tokens ?? [])) push(t.texture?.src, `${label} › Token: ${t.name}`);
          for (const t of (doc.tiles ?? [])) push(t.texture?.src, `${label} › Tile`);
        } else if (doc.documentName === 'JournalEntry') {
          for (const page of (doc.pages ?? [])) {
            if (page.src) push(page.src, `${label} › ${page.name}`);
            for (const src of extractImgSrcsFromHtml(page.text?.content))
              push(src, `${label} › ${page.name} (inline)`);
          }
        } else if (doc.documentName === 'RollTable') {
          push(doc.img, label);
          for (const r of (doc.results ?? [])) push(r.img, `${label} › ${r.text}`);
        } else if (doc.documentName === 'Macro') {
          push(doc.img, label);
        }
      }
    }
  }
}
