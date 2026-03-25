/**
 * @import { AssetEntry } from './asset-scanner.js'
 */

/**
 * Handles copying assets from their original locations into the world's my-assets/ folder.
 * Uses FilePicker.upload for each file and SceneNavigation progress bar for feedback.
 * Does NOT update any document paths — that is Phase 3.
 */
export class AssetCopier {
  /**
   * Copies all provided asset entries to their proposed paths.
   * Skips entries that are already inside the world folder.
   * Reports progress via the native Foundry progress bar (SceneNavigation).
   *
   * @param {AssetEntry[]} assets - Full list of entries from AssetScanner.scan().
   * @param {function(string, 'success'|'error'|'skip'): void} onProgress
   *   Called after each file is processed with the originalPath and result status.
   * @returns {Promise<Map<string, 'success'|'error'|'skip'>>}
   *   A map from originalPath to its copy result.
   */
  static async copyAll(assets, onProgress) {
    // Only process entries that are not already inside the world.
    const todo = assets.filter(a => !a.isAlreadyInWorld);
    const results = new Map();
    const total = todo.length;

    // SceneNavigation.displayProgressBar is the V13-native way to show a loading bar.
    SceneNavigation.displayProgressBar({ label: 'Pack My World: Copying assets…', pct: 0 });

    for (let i = 0; i < total; i++) {
      const entry = todo[i];
      const pct = Math.round(((i + 1) / total) * 100);
      const status = await AssetCopier._copyOne(entry);

      results.set(entry.originalPath, status);
      onProgress(entry.originalPath, status);

      // Update native progress bar.
      SceneNavigation.displayProgressBar({
        label: `Pack My World: Copying assets… (${i + 1}/${total})`,
        pct
      });
    }

    // Hide the progress bar after completion.
    SceneNavigation.displayProgressBar({ label: 'Pack My World: Done.', pct: 100 });
    setTimeout(() => SceneNavigation.displayProgressBar({ label: '', pct: 0 }), 2000);

    return results;
  }

  /**
   * Copies a single asset entry to its proposed path.
   * For external URLs, attempts a fetch first — skips silently on CORS failure.
   * @param {AssetEntry} entry
   * @returns {Promise<'success'|'error'|'skip'>}
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
        return 'error';
      }
      const blob = await response.blob();
      const file = new File([blob], destFilename, { type: blob.type });

      // Ensure destination directory exists before uploading.
      await AssetCopier._ensureDirectory(destFolder);

      await FilePicker.upload('data', destFolder, file, {}, { notify: false });
      console.log(`Pack My World | Copied: "${originalPath}" → "${proposedPath}"`);
      return 'success';
    } catch (err) {
      console.warn(`Pack My World | Error copying "${originalPath}": ${err.message}`);
      return 'error';
    }
  }

  /**
   * Recursively ensures that a directory path exists by creating each segment.
   * FilePicker.createDirectory is idempotent — it will not throw if the folder exists.
   * @param {string} fullPath - e.g. "worlds/my-world/my-assets/modules/dh/token"
   * @returns {Promise<void>}
   */
  static async _ensureDirectory(fullPath) {
    const segments = fullPath.split('/').filter(Boolean);
    let current = '';
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      try {
        await FilePicker.createDirectory('data', current);
      } catch {
        // Directory likely already exists — FilePicker.createDirectory throws on conflict.
      }
    }
  }
}
