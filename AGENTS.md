# Agent notes (Strata)

## Invariants

- The fabrication build pack must contain **every plate** in the model (`sliced.plates`), enforced by the zip/HTML integrity check (`buildPackIntegrity`) and the tests in `test/build-pack-integrity.test.ts`. On any mismatch the UI shows an error and the CLI exits with code 1.
