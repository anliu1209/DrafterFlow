# Hydrangea workspace implementation audit

The application uses native ES modules, static HTML/CSS and Three.js. FastAPI serves
the page, static assets, examples, image analysis and STL generation. No frontend
framework or routing library is needed. Hash navigation and `/s/:code` already exist.

## Existing behavior → new workspace

| Existing source of truth / functions | Presentation |
| --- | --- |
| `colorSourceFile`, `setColorSource`, `setupColorDropzone` | Artwork panel + central upload state; keep drag/drop and file types |
| `colorAnalysis`, `analyzeColorLayers`, `colorPaletteSize` | Visible Target colors + Analyze Image; segmentation remains `/api/color/analyze` |
| `backgroundCandidateId`, `setBackgroundRemoved` | Always-present background status, Remove / Restore in Artwork |
| `colorPalette` (internally bottom → top) | Single Layers list displayed bottom → top in print order; rows use stable entry IDs |
| `colorLayerBands`, entry `height_mm` | Selected-layer inspector + bulk height controls; default/uniform heights in Geometry |
| `colorRegionPixels`, `colorRegionOwners`, seed lists | Regions view and region inspector; preserve tiny-feature hit testing and multi-selection |
| `splitColorRegions` | Distinct Move to existing / Separate new actions; existing destinations retain same-pigment restriction |
| `rebuildColorPrintPreview` | Dedicated Print Plan view; each slab includes all higher regions |
| `colorDimensionValues`, cleanup/slicer inputs | Geometry panel; units and no hidden algorithm changes |
| `autoColorHole`, canvas placement and independent height | Keychain panel, visible placement/cancel state |
| `generateColorLayers`, `loadColorStl`, `downloadColorStl` | Persistent Generate / Update / Current action, spacious 3D view, Export dialog |
| `analysis`, `holes`, `analyze`, `generate`, `loadStl` | Stroke extraction adapter in the same shell; keep thresholds, multi-hole editing, snapping and hole undo |
| existing project/auth/share/community functions | Keep project actions and routes; place secondary actions in a compact project menu |

## Implementation sequence

1. Centralize hydrangea tokens and compact accessible controls.
2. Mount existing inputs/canvases into one three-column shell without replacing APIs.
3. Render layers/inspector in small ES modules; map visual order to existing bottom-up array.
4. Add a lightweight generation lifecycle: retain stale previews, disable stale export,
   reject results from superseded edits, and never auto-generate.
5. Route ordinary uploads and examples through layered analysis (line art uses 2 colors).
   Retain the original stroke pipeline as an advanced processing option and for old projects.
6. Verify UI interactions, background restoration, selection transfers, heights, print
   support masks, hole placement, both STL pipelines and responsive widths.

## Constraints retained

Initial segmentation supports 2–6 colors; splitting permits up to 24 physical layers.
Existing-layer transfers only target layers sharing the source pigment, as required by
the current backend. STL carries geometry, not embedded filament assignments. Undo/redo
already exists only for stroke-pipeline hole edits; do not imply global editing history.
No new server-side printing service, authentication behavior or geometry semantics is added.

## Follow-up: chef showcase and page scrolling

The editor now stays in normal document flow; `body` is not scroll-locked and the forge
is no longer a fixed fullscreen overlay. The header follows visible editor context;
users can scroll upward to the homepage and downward to other sections.
Background controls have 14 px inner padding, separate explanatory text spacing,
and a shorter Remove background label. The EVAN nametag is no longer presented as
a public example (its backend remains for compatibility with existing projects).
The hero shows the chef original, a real cropped screenshot of its generated 3D
preview, and the user-supplied physical-print photo. No synthetic print was created.

## Verification (2026-10-05)

- 26 Python tests and 7 Node lifecycle tests pass; ES-module syntax and whitespace checks pass.
- Browser-tested upload/analysis with a deterministic five-color fixture and the user's chef PNG.
- Remove / Restore excludes only exterior white; enclosed hat and tiny highlights remain.
- Split two highlights into a same-color sixth layer, transfer each between existing layers,
  pointer-drag reorder, custom thickness persistence after reload, and uniform-height reset verified.
- Print Plan's lowest slab fills the full higher-layer silhouette; the highest shows only highlights.
- Manual hole placement and automatic placement, 0.8 mm base / independent 2.4 mm tab verified.
- Actual downloaded color STL is watertight at 2.4 mm maximum Z; changing highlight thickness
  yields another watertight STL at 2.6 mm. Legacy stroke export is watertight at 6 mm.
- The real chef image generates a five-layer 6.97 MB STL and displays its 3D result.
  Its final downloaded/restored-project variant is also watertight (6.11 MB, tab top 2.4 mm).
- Renaming does not stale geometry; editing height disables export and retains the old 3D.
- CSS viewport widths 1440, 1280, 1024 and 390 tested without horizontal overflow;
  narrow screens retain primary actions and expose tools/layers through drawers.
- Fixed renderer `data-engine` stamp collision, current-action hover contrast, mobile inherited
  button hiding, and tool messages covering the canvas, all found through actual browser QA.
- No console errors in the tested flows. Tests use an isolated local origin; no account,
  community publish, remote deployment or production-data write was performed.

### Preview and gallery follow-up

- Both renderers now use neutral studio fill and no filmic tone mapping to preserve pastel colours.
  The homepage chef model image was recaptured from the updated live 3D preview.
- Personal/community galleries use capped-width 4:3 thumbnail cards with contained images.
- Creators can edit published titles, descriptions, tags and Remix settings without opening or
  saving over the unrelated editor model. Existing ownership checks protect metadata updates.
- Browser QA edited a synthetic published project in a separate temporary database on port 8003;
  the saved model data remained unchanged. No real account or production project was edited.
