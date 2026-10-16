# Agent notes (Strata)

## Invariants

- The fabrication build pack must contain **every plate** in the model (`sliced.plates`), including empty or zero-area layers. Zip `plates/*.dxf` count, `manifest.json` `plateCount`, the HTML cover legend (`data-plate-count`), and the Every plate gallery (`data-plate-key` per plate) must equal `sliced.plates.length`. Cuttable plates also have laser part DXFs. Filename sanitisation must not overwrite another plate. Enforced by `buildPackIntegrity` and `test/build-pack-integrity.test.ts`. On mismatch the UI shows an error and the CLI exits with code 1.
