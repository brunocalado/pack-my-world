/**
 * @typedef {Object} AssetEntry
 * @property {string} originalPath       - The current path as stored in the document.
 * @property {string} proposedPath       - Where the file will live after consolidation.
 * @property {'image'|'audio'|'video'|'unknown'} type
 * @property {string} documentName
 * @property {'scene'|'actor'|'item'|'journal'|'playlist'|'macro'|'table'|'compendium'} documentType
 * @property {string|null} documentSubType
 * @property {string} documentId
 * @property {boolean} isExternal
 * @property {boolean} isAlreadyInWorld
 * @property {boolean} isWildcard        - True if this entry was resolved from a wildcard path.
 * @property {string|null} wildcardPath  - The original wildcard path (e.g. "modules/.../token/Acid*").
 * @property {boolean} isBroken          - True if the file returned 404 or could not be fetched.
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

/** @param {string} path @returns {boolean} */
function isWildcardPath(path) {
  return typeof path === 'string' && path.trimEnd().endsWith('*');
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

/**
 * Sanitizes a filename (without extension) to lowercase kebab-case.
 * Decodes percent-encoding first so "%20" becomes a hyphen, not "%20".
 * @param {string} filename
 * @returns {string}
 */
function sanitizeFilename(filename) {
  return decodeURIComponent(filename)
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Splits a path into { dir, name, ext }.
 * @param {string} filePath
 * @returns {{ dir: string, name: string, ext: string }}
 */
function splitPath(filePath) {
  const lastSlash = filePath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? filePath.slice(0, lastSlash + 1) : '';
  const base = filePath.slice(lastSlash + 1);
  const dotIndex = base.lastIndexOf('.');
  if (dotIndex <= 0) return { dir, name: base, ext: '' };
  return { dir, name: base.slice(0, dotIndex), ext: base.slice(dotIndex) };
}

/**
 * Builds the proposed destination path inside my-assets/, sanitizing only the filename.
 * @param {string} originalPath
 * @returns {string}
 */
function buildProposedPath(originalPath) {
  if (isExternalUrl(originalPath)) {
    try {
      const url = new URL(originalPath);
      const { dir, name, ext } = splitPath(url.pathname.replace(/^\//, ''));
      return MY_ASSETS_PREFIX() + 'external/' + dir + sanitizeFilename(name) + ext.toLowerCase();
    } catch {
      return MY_ASSETS_PREFIX() + 'external/' + sanitizeFilename(originalPath);
    }
  }
  const { dir, name, ext } = splitPath(originalPath);
  return MY_ASSETS_PREFIX() + dir + sanitizeFilename(name) + ext.toLowerCase();
}

/**
 * For a wildcard path like "modules/dh/token/Acid-Burrower*", returns the
 * equivalent wildcard path inside my-assets/ so Foundry can still resolve it.
 * e.g. → "worlds/<id>/my-assets/modules/dh/token/acid-burrower*"
 * @param {string} wildcardPath
 * @returns {string}
 */
function buildProposedWildcardPath(wildcardPath) {
  // Strip trailing * to sanitize the prefix, then restore *.
  const prefix = wildcardPath.slice(0, -1);
  const { dir, name } = splitPath(prefix);
  return MY_ASSETS_PREFIX() + dir + sanitizeFilename(name) + '*';
}

/**
 * Returns the FilePicker class, compatible with Foundry v13+ namespaced API
 * and older versions that expose it as a global.
 * @returns {typeof FilePicker}
 */
function getFilePicker() {
  return foundry?.applications?.apps?.FilePicker?.implementation ?? FilePicker;
}

/**
 * Resolves a wildcard path to the list of real files it matches using FilePicker.browse.
 * Returns an empty array if the directory cannot be browsed (permissions, missing folder).
 * @param {string} wildcardPath - e.g. "modules/dh/token/Acid-Burrower*"
 * @returns {Promise<string[]>} - Array of resolved file paths.
 */
async function resolveWildcard(wildcardPath) {
  const prefix = wildcardPath.slice(0, -1); // strip trailing *
  const lastSlash = prefix.lastIndexOf('/');
  const dir = lastSlash >= 0 ? prefix.slice(0, lastSlash) : '.';
  const filePrefix = prefix.slice(lastSlash + 1).toLowerCase();

  try {
    const FP = getFilePicker();
    const result = await FP.browse('data', dir);
    return (result.files ?? []).filter(f => {
      const filename = f.split('/').pop().toLowerCase();
      return filename.startsWith(filePrefix);
    });
  } catch (err) {
    console.warn(`Pack My World | Could not browse "${dir}" for wildcard "${wildcardPath}": ${err.message}`);
    return [];
  }
}

/**
 * Checks if a single asset URL is reachable.
 * For local paths, prepends the Foundry base URL.
 * Returns true if the file is broken (404 or network error).
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function checkIsBroken(path) {
  try {
    const url = isExternalUrl(path)
      ? path
      : `${window.location.origin}/${path}`;
    const res = await fetch(url, { method: 'HEAD' });
    return !res.ok;
  } catch {
    return true;
  }
}

/**
 * Checks all entries for broken links in parallel (capped at `concurrency` simultaneous requests).
 * Mutates each entry's `isBroken` field in place.
 * Wildcard entries with unresolved paths are skipped (marked false).
 * @param {AssetEntry[]} entries
 * @param {number} [concurrency=20]
 * @returns {Promise<void>}
 */
export async function checkBrokenLinks(entries, concurrency = 20) {
  // Only check concrete, non-already-in-world entries. Skip unresolved wildcards.
  const toCheck = entries.filter(e => !e.isAlreadyInWorld && !(e.isWildcard && e.wildcardPath === e.originalPath));

  const queue = toCheck.slice();
  async function worker() {
    while (queue.length) {
      const entry = queue.shift();
      entry.isBroken = await checkIsBroken(entry.originalPath);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, toCheck.length) }, worker);
  await Promise.all(workers);
}

/**
 * Creates a regular AssetEntry for a concrete file path.
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
    isAlreadyInWorld: isAlreadyInWorld(path),
    isWildcard: false,
    wildcardPath: null,
    isBroken: false
  };
}

/**
 * Creates a wildcard-resolved AssetEntry for a single real file found under a wildcard.
 * @param {string} resolvedFile   - The concrete file path returned by FilePicker.browse.
 * @param {string} wildcardPath   - The original wildcard path (ends with *).
 * @param {string} documentName
 * @param {AssetEntry['documentType']} documentType
 * @param {string} documentId
 * @param {string|null} [documentSubType]
 * @returns {AssetEntry}
 */
function makeWildcardEntry(resolvedFile, wildcardPath, documentName, documentType, documentId, documentSubType = null) {
  return {
    originalPath: resolvedFile,
    proposedPath: buildProposedPath(resolvedFile),
    type: inferType(resolvedFile),
    documentName,
    documentType,
    documentSubType,
    documentId,
    isExternal: false,
    isAlreadyInWorld: isAlreadyInWorld(resolvedFile),
    isWildcard: true,
    wildcardPath,
    isBroken: false
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
   * Wildcard paths are resolved to real files via FilePicker.browse.
   * @returns {Promise<AssetEntry[]>}
   */
  static async scan() {
    const regularEntries = [];

    AssetScanner._scanScenes(regularEntries);
    AssetScanner._scanActors(regularEntries);
    AssetScanner._scanItems(regularEntries);
    AssetScanner._scanJournals(regularEntries);
    AssetScanner._scanPlaylists(regularEntries);
    AssetScanner._scanMacros(regularEntries);
    AssetScanner._scanTables(regularEntries);
    await AssetScanner._scanWorldCompendiums(regularEntries);

    // Separate wildcards from concrete paths and resolve them.
    const concrete = regularEntries.filter(e => e !== null && !isWildcardPath(e.originalPath));
    const wildcardEntries = regularEntries.filter(e => e !== null && isWildcardPath(e.originalPath));

    const resolved = await AssetScanner._resolveWildcardEntries(wildcardEntries);

    return [...concrete, ...resolved];
  }

  /**
   * For each entry whose originalPath is a wildcard, resolves the real files
   * and returns wildcard AssetEntry objects for each match.
   * If no files are found the original entry is kept as-is so the user can see it.
   * @param {AssetEntry[]} wildcardEntries
   * @returns {Promise<AssetEntry[]>}
   */
  static async _resolveWildcardEntries(wildcardEntries) {
    const results = [];
    for (const entry of wildcardEntries) {
      const files = await resolveWildcard(entry.originalPath);
      if (files.length === 0) {
        // Keep the unresolved wildcard visible so the user knows it exists.
        results.push({ ...entry, isWildcard: true, wildcardPath: entry.originalPath });
      } else {
        for (const file of files) {
          results.push(makeWildcardEntry(
            file,
            entry.originalPath,
            entry.documentName,
            entry.documentType,
            entry.documentId,
            entry.documentSubType
          ));
        }
      }
    }
    return results;
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
