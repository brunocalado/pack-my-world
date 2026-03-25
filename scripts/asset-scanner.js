/**
 * @typedef {Object} AssetEntry
 * @property {string} originalPath     - The current path as stored in the document.
 * @property {string} proposedPath     - Where the file will live after consolidation.
 * @property {'image'|'audio'|'video'} type
 * @property {string} documentName     - Human-readable name of the source document.
 * @property {'scene'|'actor'|'item'|'journal'|'playlist'} documentType
 * @property {string} documentId       - UUID or id of the source document.
 * @property {boolean} isExternal      - True if the path starts with http/https.
 * @property {boolean} isAlreadyInWorld - True if the path is already under worlds/<id>/.
 */

const WORLD_PREFIX = () => `worlds/${game.world.id}/`;
const MY_ASSETS_PREFIX = () => `worlds/${game.world.id}/my-assets/`;

/**
 * Returns true if the path is an external URL.
 * @param {string} path
 * @returns {boolean}
 */
function isExternalUrl(path) {
  return typeof path === 'string' && (path.startsWith('http://') || path.startsWith('https://'));
}

/**
 * Returns true if the path is already inside this world's folder.
 * @param {string} path
 * @returns {boolean}
 */
function isAlreadyInWorld(path) {
  return typeof path === 'string' && path.startsWith(WORLD_PREFIX());
}

/**
 * Infers asset type from file extension.
 * @param {string} path
 * @returns {'image'|'audio'|'video'|'unknown'}
 */
function inferType(path) {
  if (!path) return 'unknown';
  const ext = path.split('.').pop().toLowerCase().split('?')[0];
  if (['png','jpg','jpeg','webp','gif','svg','avif'].includes(ext)) return 'image';
  if (['mp3','ogg','wav','flac','m4a','aac'].includes(ext)) return 'audio';
  if (['mp4','webm','ogv'].includes(ext)) return 'video';
  return 'unknown';
}

/**
 * Builds the proposed destination path inside my-assets/,
 * preserving the original directory structure after the root segment.
 * e.g. modules/dnd-content/img/token.png → worlds/<id>/my-assets/modules/dnd-content/img/token.png
 * @param {string} originalPath
 * @returns {string}
 */
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
 * Normalises a raw path value into an AssetEntry, or returns null if the path is empty/invalid.
 * @param {string|null|undefined} path
 * @param {string} documentName
 * @param {'scene'|'actor'|'item'|'journal'|'playlist'} documentType
 * @param {string} documentId
 * @returns {AssetEntry|null}
 */
function makeEntry(path, documentName, documentType, documentId) {
  if (!path || typeof path !== 'string' || path.trim() === '') return null;
  // Ignore Foundry built-in placeholder icons shipped with core.
  if (path.startsWith('icons/') || path.startsWith('ui/')) return null;

  return {
    originalPath: path,
    proposedPath: buildProposedPath(path),
    type: inferType(path),
    documentName,
    documentType,
    documentId,
    isExternal: isExternalUrl(path),
    isAlreadyInWorld: isAlreadyInWorld(path)
  };
}

/**
 * Extracts all img src values from an HTML string (used for Journal pages).
 * @param {string} html
 * @returns {string[]}
 */
function extractImgSrcsFromHtml(html) {
  if (!html) return [];
  const matches = [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)];
  return matches.map(m => m[1]);
}

/**
 * Main scanner. Iterates all world documents and collects external asset references.
 */
export class AssetScanner {
  /**
   * Scans all world entities and returns a list of asset entries for files outside the world folder.
   * Called by PackMyWorld.Start().
   * @returns {Promise<AssetEntry[]>}
   */
  static async scan() {
    const entries = [];

    AssetScanner._scanScenes(entries);
    AssetScanner._scanActors(entries);
    AssetScanner._scanItems(entries);
    AssetScanner._scanJournals(entries);
    AssetScanner._scanPlaylists(entries);

    return entries.filter(e => e !== null);
  }

  /**
   * @param {AssetEntry[]} entries
   */
  static _scanScenes(entries) {
    for (const scene of game.scenes) {
      const name = scene.name;
      const id = scene.id;
      const push = (path, label) => {
        const e = makeEntry(path, label ?? name, 'scene', id);
        if (e && !e.isAlreadyInWorld) entries.push(e);
      };

      push(scene.background?.src);
      // Use fog.overlay (V13+); scene.fogOverlay is deprecated since V12.
      push(scene.fog?.overlay);
      push(scene.foreground);

      for (const token of scene.tokens) {
        push(token.texture?.src, `${name} › Token: ${token.name}`);
      }
      for (const tile of scene.tiles) {
        push(tile.texture?.src, `${name} › Tile`);
      }
      for (const sound of scene.sounds) {
        push(sound.path, `${name} › Sound`);
      }
    }
  }

  /**
   * @param {AssetEntry[]} entries
   */
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

  /**
   * @param {AssetEntry[]} entries
   */
  static _scanItems(entries) {
    for (const item of game.items) {
      const e = makeEntry(item.img, item.name, 'item', item.id);
      if (e && !e.isAlreadyInWorld) entries.push(e);
    }
  }

  /**
   * @param {AssetEntry[]} entries
   */
  static _scanJournals(entries) {
    for (const journal of game.journal) {
      for (const page of journal.pages) {
        if (page.src) {
          const e = makeEntry(page.src, `${journal.name} › ${page.name}`, 'journal', journal.id);
          if (e && !e.isAlreadyInWorld) entries.push(e);
        }
        const srcs = extractImgSrcsFromHtml(page.text?.content);
        for (const src of srcs) {
          const e = makeEntry(src, `${journal.name} › ${page.name} (inline)`, 'journal', journal.id);
          if (e && !e.isAlreadyInWorld) entries.push(e);
        }
      }
    }
  }

  /**
   * @param {AssetEntry[]} entries
   */
  static _scanPlaylists(entries) {
    for (const playlist of game.playlists) {
      for (const sound of playlist.sounds) {
        const e = makeEntry(sound.path, `${playlist.name} › ${sound.name}`, 'playlist', playlist.id);
        if (e && !e.isAlreadyInWorld) entries.push(e);
      }
    }
  }
}
