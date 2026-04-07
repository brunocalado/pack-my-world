# Changelog

## [Unreleased]

### [Added]
- Phase 3: "Apply Path Updates" button writes confirmed new paths back into world documents using `Document#update()`.
- `AssetUpdater` engine handles all document types (scenes, actors, items, journals, playlists, macros, tables, compendiums) including embedded documents and wildcard token paths.
- Mandatory backup warning dialog before applying irreversible path changes.

- Phase 1: `AssetScanner` scans all world Scenes, Actors, Items, Journals, and Playlists for assets stored outside the world folder.
- Phase 1: `AssetReportApp` (ApplicationV2) displays scanned assets in a filterable table with current path, expected new path, and copy status.
- `PackMyWorld.Start()` global entry point to trigger scan and open the report UI.
