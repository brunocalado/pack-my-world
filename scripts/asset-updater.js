/**
 * @import { AssetEntry } from './asset-scanner.js'
 */

/**
 * Applies new paths to world documents based on a resolved asset map.
 * Isolated from the UI layer for clarity and testability.
 */
export class AssetUpdater {

  // ---------------------------------------------------------------------------
  // Wildcard path helpers
  // ---------------------------------------------------------------------------

  /**
   * Given a wildcardPath like "modules/dh/token/Acid*" and a confirmed concrete
   * candidate path like "worlds/myworld/my-assets/modules/dh/token/acid-burrower-01.png",
   * returns the new wildcard path that points to the same directory with the same stem prefix:
   * e.g. "worlds/myworld/my-assets/modules/dh/token/acid*"
   *
   * @param {string} originalWildcard   - e.g. "modules/dh/token/Acid*"
   * @param {string} confirmedPath      - A concrete file under the new directory.
   * @returns {string}
   */
  static buildProposedWildcardFromConfirmed(originalWildcard, confirmedPath) {
    const prefix     = originalWildcard.slice(0, -1);
    const stemPrefix = prefix.split('/').pop().toLowerCase();
    const newDir     = confirmedPath.slice(0, confirmedPath.lastIndexOf('/') + 1);
    return newDir + stemPrefix + '*';
  }

  /**
   * Given a wildcard AssetEntry that was successfully copied, builds the new wildcard
   * path inside my-assets/ using the proposedPath directory + sanitized stem prefix.
   *
   * @param {AssetEntry} entry
   * @returns {string}
   */
  static buildProposedWildcardFromEntry(entry) {
    const prefix     = entry.wildcardPath.slice(0, -1);
    const stemPrefix = prefix.split('/').pop().toLowerCase();
    const newDir     = entry.proposedPath.slice(0, entry.proposedPath.lastIndexOf('/') + 1);
    return newDir + stemPrefix + '*';
  }

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------

  /**
   * Applies all resolved path changes to world documents.
   *
   * @param {AssetEntry[]} assets  - Full list from AssetScanner.scan(), annotated with confirmedPath.
   * @param {Map<string, string>} pathMap
   *   Key: original path (or wildcardPath for wildcard entries).
   *   Value: new path to write into the document.
   * @param {function(string, 'success'|'error', string|null): void} onProgress
   * @returns {Promise<{successCount: number, errorCount: number}>}
   */
  static async applyAll(assets, pathMap, onProgress) {
    const docGroups = AssetUpdater._buildDocGroups(assets, pathMap);

    let successCount = 0;
    let errorCount = 0;

    for (const [groupKey, group] of docGroups) {
      try {
        await AssetUpdater._updateDocument(group);
        for (const asset of group.assets) onProgress(asset.originalPath, 'success', null);
        successCount += group.assets.length;
      } catch (err) {
        console.error(`Pack My World | AssetUpdater: failed to update ${groupKey}: ${err.message}`, err);
        for (const asset of group.assets) onProgress(asset.originalPath, 'error', err.message);
        errorCount += group.assets.length;
      }
    }

    return { successCount, errorCount };
  }

  // ---------------------------------------------------------------------------
  // Grouping
  // ---------------------------------------------------------------------------

  /**
   * Groups assets by (documentType, documentId) so each document is updated once.
   * @param {AssetEntry[]} assets
   * @param {Map<string, string>} pathMap
   * @returns {Map<string, { documentType: string, documentId: string, documentSubType: string|null, assets: AssetEntry[], pathMap: Map<string,string> }>}
   */
  static _buildDocGroups(assets, pathMap) {
    const groups = new Map();
    for (const asset of assets) {
      const lookupKey = (asset.isWildcard && asset.wildcardPath) ? asset.wildcardPath : asset.originalPath;
      if (!pathMap.has(lookupKey)) continue;

      const groupKey = `${asset.documentType}::${asset.documentId}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          documentType: asset.documentType,
          documentId: asset.documentId,
          documentSubType: asset.documentSubType,
          assets: [],
          pathMap: new Map()
        });
      }
      const g = groups.get(groupKey);
      g.assets.push(asset);
      g.pathMap.set(lookupKey, pathMap.get(lookupKey));
    }
    return groups;
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  /**
   * Dispatches to the correct updater based on documentType.
   * @param {{ documentType: string, documentId: string, documentSubType: string|null, assets: AssetEntry[], pathMap: Map<string,string> }} group
   * @returns {Promise<void>}
   */
  static async _updateDocument(group) {
    switch (group.documentType) {
      case 'scene':      return AssetUpdater._updateScene(group);
      case 'actor':      return AssetUpdater._updateActor(group);
      case 'item':       return AssetUpdater._updateItem(group);
      case 'journal':    return AssetUpdater._updateJournal(group);
      case 'playlist':   return AssetUpdater._updatePlaylist(group);
      case 'macro':      return AssetUpdater._updateMacro(group);
      case 'table':      return AssetUpdater._updateTable(group);
      case 'compendium': return AssetUpdater._updateCompendium(group);
      default:
        throw new Error(`Unknown documentType: ${group.documentType}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-type updaters
  // ---------------------------------------------------------------------------

  /**
   * Updates scene-level fields and embedded tokens, tiles, and sounds.
   * @param {{ assets: AssetEntry[], pathMap: Map<string,string>, documentId: string }} group
   * @returns {Promise<void>}
   */
  static async _updateScene(group) {
    const scene = game.scenes.get(group.documentId);
    if (!scene) throw new Error(`Scene not found: ${group.documentId}`);

    const sceneUpdates = {};
    const tokenUpdates = [];
    const tileUpdates  = [];
    const soundUpdates = [];

    for (const asset of group.assets) {
      const from = (asset.isWildcard && asset.wildcardPath) ? asset.wildcardPath : asset.originalPath;
      const to   = group.pathMap.get(from);
      if (!to) continue;

      switch (asset.documentSubType) {
        case 'background':
          if (scene.background?.src === from) sceneUpdates['background.src'] = to;
          if (scene.foreground === from)       sceneUpdates['foreground'] = to;
          if (scene.fog?.overlay === from)     sceneUpdates['fog.overlay'] = to;
          break;
        case 'token': {
          const matchTokens = scene.tokens.filter(t => (t.texture?.src ?? '') === from);
          for (const t of matchTokens)
            tokenUpdates.push({ _id: t.id, 'texture.src': to });
          break;
        }
        case 'tile': {
          const matchTiles = scene.tiles.filter(t => (t.texture?.src ?? '') === from);
          for (const t of matchTiles)
            tileUpdates.push({ _id: t.id, 'texture.src': to });
          break;
        }
        case 'sound': {
          const matchSounds = scene.sounds.filter(s => s.path === from);
          for (const s of matchSounds)
            soundUpdates.push({ _id: s.id, path: to });
          break;
        }
      }
    }

    if (Object.keys(sceneUpdates).length) await scene.update(sceneUpdates);
    if (tokenUpdates.length)  await scene.updateEmbeddedDocuments('Token', tokenUpdates);
    if (tileUpdates.length)   await scene.updateEmbeddedDocuments('Tile', tileUpdates);
    if (soundUpdates.length)  await scene.updateEmbeddedDocuments('AmbientSound', soundUpdates);
  }

  /**
   * Updates actor portrait and prototype token texture.
   * @param {{ assets: AssetEntry[], pathMap: Map<string,string>, documentId: string }} group
   * @returns {Promise<void>}
   */
  static async _updateActor(group) {
    const actor = game.actors.get(group.documentId);
    if (!actor) throw new Error(`Actor not found: ${group.documentId}`);

    const updates = {};
    for (const asset of group.assets) {
      const from = (asset.isWildcard && asset.wildcardPath) ? asset.wildcardPath : asset.originalPath;
      const to   = group.pathMap.get(from);
      if (!to) continue;
      if (actor.img === from)                          updates['img'] = to;
      if (actor.prototypeToken?.texture?.src === from) updates['prototypeToken.texture.src'] = to;
    }
    if (Object.keys(updates).length) await actor.update(updates);
  }

  /**
   * Updates item image path.
   * @param {{ assets: AssetEntry[], pathMap: Map<string,string>, documentId: string }} group
   * @returns {Promise<void>}
   */
  static async _updateItem(group) {
    const item = game.items.get(group.documentId);
    if (!item) throw new Error(`Item not found: ${group.documentId}`);

    const updates = {};
    for (const asset of group.assets) {
      const from = (asset.isWildcard && asset.wildcardPath) ? asset.wildcardPath : asset.originalPath;
      const to   = group.pathMap.get(from);
      if (!to) continue;
      if (item.img === from) updates['img'] = to;
    }
    if (Object.keys(updates).length) await item.update(updates);
  }

  /**
   * Updates journal page sources and inline HTML content via string replacement.
   * @param {{ assets: AssetEntry[], pathMap: Map<string,string>, documentId: string }} group
   * @returns {Promise<void>}
   */
  static async _updateJournal(group) {
    const journal = game.journal.get(group.documentId);
    if (!journal) throw new Error(`Journal not found: ${group.documentId}`);

    for (const page of journal.pages) {
      const pageUpdates = {};
      for (const asset of group.assets) {
        const from = asset.originalPath;
        const to   = group.pathMap.get(from);
        if (!to) continue;
        if (page.src === from) pageUpdates['src'] = to;
        if (page.text?.content?.includes(from)) {
          const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const newContent = (pageUpdates['text.content'] ?? page.text.content).replace(new RegExp(escaped, 'g'), to);
          pageUpdates['text.content'] = newContent;
        }
      }
      if (Object.keys(pageUpdates).length) await page.update(pageUpdates);
    }
  }

  /**
   * Updates playlist sound paths via embedded document update.
   * @param {{ assets: AssetEntry[], pathMap: Map<string,string>, documentId: string }} group
   * @returns {Promise<void>}
   */
  static async _updatePlaylist(group) {
    const playlist = game.playlists.get(group.documentId);
    if (!playlist) throw new Error(`Playlist not found: ${group.documentId}`);

    const soundUpdates = [];
    for (const sound of playlist.sounds) {
      for (const asset of group.assets) {
        const from = asset.originalPath;
        const to   = group.pathMap.get(from);
        if (!to) continue;
        if (sound.path === from) soundUpdates.push({ _id: sound.id, path: to });
      }
    }
    if (soundUpdates.length) await playlist.updateEmbeddedDocuments('PlaylistSound', soundUpdates);
  }

  /**
   * Updates macro image path.
   * @param {{ assets: AssetEntry[], pathMap: Map<string,string>, documentId: string }} group
   * @returns {Promise<void>}
   */
  static async _updateMacro(group) {
    const macro = game.macros.get(group.documentId);
    if (!macro) throw new Error(`Macro not found: ${group.documentId}`);

    const updates = {};
    for (const asset of group.assets) {
      const from = asset.originalPath;
      const to   = group.pathMap.get(from);
      if (!to) continue;
      if (macro.img === from) updates['img'] = to;
    }
    if (Object.keys(updates).length) await macro.update(updates);
  }

  /**
   * Updates roll table image and embedded result images.
   * @param {{ assets: AssetEntry[], pathMap: Map<string,string>, documentId: string }} group
   * @returns {Promise<void>}
   */
  static async _updateTable(group) {
    const table = game.tables.get(group.documentId);
    if (!table) throw new Error(`RollTable not found: ${group.documentId}`);

    const tableUpdates = {};
    const resultUpdates = [];

    for (const asset of group.assets) {
      const from = asset.originalPath;
      const to   = group.pathMap.get(from);
      if (!to) continue;
      if (table.img === from) tableUpdates['img'] = to;
      for (const result of table.results) {
        if (result.img === from) resultUpdates.push({ _id: result.id, img: to });
      }
    }
    if (Object.keys(tableUpdates).length) await table.update(tableUpdates);
    if (resultUpdates.length) await table.updateEmbeddedDocuments('TableResult', resultUpdates);
  }

  /**
   * Updates documents inside a world compendium pack.
   * Loads all documents and patches matching paths individually.
   * @param {{ assets: AssetEntry[], pathMap: Map<string,string>, documentId: string }} group
   * @returns {Promise<void>}
   */
  static async _updateCompendium(group) {
    const pack = game.packs.get(group.documentId);
    if (!pack) throw new Error(`Compendium pack not found: ${group.documentId}`);

    let documents;
    try {
      documents = await pack.getDocuments();
    } catch (err) {
      throw new Error(`Could not load compendium "${group.documentId}": ${err.message}`);
    }

    for (const doc of documents) {
      const updates = {};

      for (const asset of group.assets) {
        const from = (asset.isWildcard && asset.wildcardPath) ? asset.wildcardPath : asset.originalPath;
        const to   = group.pathMap.get(from);
        if (!to) continue;

        if (doc.documentName === 'Actor') {
          if (doc.img === from)                          updates['img'] = to;
          if (doc.prototypeToken?.texture?.src === from) updates['prototypeToken.texture.src'] = to;
        } else if (doc.documentName === 'Item') {
          if (doc.img === from) updates['img'] = to;
        } else if (doc.documentName === 'Scene') {
          if (doc.background?.src === from) updates['background.src'] = to;
        } else if (doc.documentName === 'Macro') {
          if (doc.img === from) updates['img'] = to;
        } else if (doc.documentName === 'RollTable') {
          if (doc.img === from) updates['img'] = to;
        }
      }

      if (Object.keys(updates).length) await doc.update(updates);
    }
  }
}
