# Vendored agent skills (three.js / React Three Fiber)

Copied verbatim, no edits. Pure Markdown: no scripts, hooks or network calls.
To update, re-copy the `skills/` folders from a newer commit and change the pins below.

| Skills | Source | Pinned commit | License |
| --- | --- | --- | --- |
| `r3f-fundamentals`, `r3f-geometry`, `r3f-materials`, `r3f-lighting`, `r3f-textures`, `r3f-loaders`, `r3f-animation`, `r3f-shaders`, `r3f-postprocessing`, `r3f-interaction`, `r3f-physics` | [EnzeD/r3f-skills](https://github.com/EnzeD/r3f-skills) | `4a11805f097396fb0b893172efd1e359e8051f92` | MIT (README) |
| `three-best-practices`, `r3f-best-practices` | [emalorenzo/three-agent-skills](https://github.com/emalorenzo/three-agent-skills) | `f950f95ae3b13581546e6d6d8b2f88a08eb3e577` | MIT (package.json) |

Left out: the upstream `.zip` bundles (duplicates of the folders), and each repo's eval/validation tooling.

Strata pins `@react-three/fiber` 9.8, `@react-three/drei` 10.7, `three` 0.186. The r3f-skills were checked upstream against
fiber 9.7 / three r185, close enough. Strata does not use Rapier, `@react-three/postprocessing`, WebGPU/TSL or WebXR,
so ignore those parts unless a task adds them. `r3f-best-practices` links `rules/state-zustand-selectors.md`, which
upstream never shipped; the same advice is in `rules/perf-zustand-selectors.md`.
