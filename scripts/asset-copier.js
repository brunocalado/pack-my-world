/**
 * @import { AssetEntry } from './asset-scanner.js'
 */

/**
 * Handles copying assets from their original locations into the world's my-assets/ folder.
 * Uses foundry.applications.apps.FilePicker.implementation.upload for each file.
 * Progress is reported in the browser console. Does NOT update any document paths — that is Phase 3.
 */
export class AssetCopier {
  /**
   * Copies all provided asset entries to their proposed paths.
   * Skips entries that are already inside the world folder.
   * Reports progress via the browser console.
   *
   * @param {AssetEntry[]} assets - Full list of entries from AssetScanner.scan().
   * @param {function(string, {status: string, error: string|null}): void} onProgress
   *   Called after each file is processed with the originalPath and result.
   * @returns {Promise<Map<string, {status: string, error: string|null}>>}
   *   A map from originalPath to its copy result.
   */
  static async copyAll(assets, onProgress) {
    // Only process entries that are not already inside the world.
    const todo = assets.filter(a => !a.isAlreadyInWorld);
    const results = new Map();
    const total = todo.length;

    // Single notification — user follows progress in the browser console.
    ui.notifications.info('Pack My World: Copying assets… Check the console for progress.');
    console.log(`Pack My World | Starting copy of ${total} asset(s).`);

    for (let i = 0; i < total; i++) {
      const entry = todo[i];
      const result = await AssetCopier._copyOne(entry);

      results.set(entry.originalPath, result);
      onProgress(entry.originalPath, result);

      const logSuffix = result.error ? ` (${result.error})` : '';
      console.log(`Pack My World | [${i + 1}/${total}] ${result.status.toUpperCase()}${logSuffix}: "${entry.originalPath}" → "${entry.proposedPath}"`);
    }

    console.log(`Pack My World | Copy complete. ${total} asset(s) processed.`);

    return results;
  }

  /**
   * Copies a single asset entry to its proposed path.
   * For external URLs, attempts a fetch first — skips silently on CORS failure.
   * @param {AssetEntry} entry
   * @returns {Promise<{status: string, error: string|null}>}
   */
  static async _copyOne(entry) {
    const { originalPath, proposedPath } = entry;

    try {
      // Derive destination folder and filename from the proposed path.
      const lastSlash = proposedPath.lastIndexOf('/');
      const destFolder = proposedPath.slice(0, lastSlash);
      const destFilename = proposedPath.slice(lastSlash + 1);

      // Fetch the file as a Blob. For local paths Foundry serves them relative to its root.
      const fetchUrl = entry.isExternal ? originalPath : `/${originalPath}`;
      const response = await fetch(fetchUrl);
      if (!response.ok) {
        console.warn(`Pack My World | Fetch failed for "${originalPath}" (HTTP ${response.status}) — skipping.`);
        return { status: 'error', error: `HTTP ${response.status}` };
      }
      const blob = await response.blob();
      const file = new File([blob], destFilename, { type: blob.type });

      // Ensure destination directory exists before uploading.
      await AssetCopier._ensureDirectory(destFolder);

      await foundry.applications.apps.FilePicker.implementation.upload('data', destFolder, file, {}, { notify: false });
      return { status: 'success', error: null };
    } catch (err) {
      console.warn(`Pack My World | Error copying "${originalPath}": ${err.message}`);
      return { status: 'error', error: err.message };
    }
  }

  /**
   * Recursively ensures that a directory path exists by creating each segment.
   * FilePicker.implementation.createDirectory is idempotent — it will not throw if the folder exists.
   * @param {string} fullPath - e.g. "worlds/my-world/my-assets/modules/dh/token"
   * @returns {Promise<void>}
   */
  static async _ensureDirectory(fullPath) {
    const segments = fullPath.split('/').filter(Boolean);
    let current = '';
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      try {
        await foundry.applications.apps.FilePicker.implementation.createDirectory('data', current);
      } catch {
        // Directory likely already exists — createDirectory throws on conflict.
      }
    }
  }
}
