# Tuned sounding plates

Strata's original tuner treats a plate as a cantilever: clamped where it enters
the concrete, free at the top. A sounding plate is the other support. It hangs
at the two nodes of its first bending mode, the way a xylophone bar does, and
the length of the bar is what sets the note. Face width does not, so the plate
can stay wide enough to carry an image.

The fast model runs in the existing deferred worker. A separate 2D check, below,
says how far that 1D answer sits from a Mindlin plate on the same outline.

## Material

Wave speed is `c = √(E/ρ)` from the materials already in `src/core/tuning.ts`.
Those constants are left as they are (changing them would move every cantilever
preset).

| Material | E | ρ | c = √(E/ρ) |
| --- | --- | --- | --- |
| Steel, corten | 200 GPa | 7850 kg/m³ | 5048 m/s |
| Aluminium | 69 GPa | 2700 kg/m³ | 5055 m/s |

Both sit in the usual "steel ~5100, aluminium ~5000" band. Poisson's ratio for
the beam and the plate is 0.30, so `G = E / (2(1+ν))`. Shear factor κ = 5/6.

## Fast model (1D Timoshenko)

`src/core/beam.ts`. The outline is read as a beam along its length (the plate's
vertical, y). About 100 elements. Width is the material width of each station;
a hole subtracts its chord, so the mounting holes are in the stiffness and the
mass. Each element is a 2-node Timoshenko beam (transverse deflection and
rotation), shear integrated at one point so a thin bar does not lock, rotary
inertia kept in the mass.

No supports are applied. The dense eigenproblem therefore has two rigid-body
modes at 0 Hz, then bending. A shift-invert subspace iteration (Cholesky of
`K + σM`, a 6-vector Rayleigh–Ritz projection, Jacobi on that 6×6) returns the
first three bending partials. Nodes of mode 1 are the zeros of its shape,
nearest the analytic pair.

For a uniform thin strip the Euler–Bernoulli free-free root `βL = 4.73004`
collapses to

```
f = 1.028 · c · t / L²
```

with nodes at 0.2242 and 0.7758 of the length. Overtones sit near
`f2/f1 = 2.756` and `f3/f1 = 5.404`. The reference implementation in
[amosr/xylo](https://github.com/amosr/xylo) tunes the same bar by Timoshenko
receptance; this one uses the element matrices and a tiny dense solve so it
can run on an arbitrary outline in the worker.

Check piece, 300 × 50 × 3 mm steel, 100 elements:

| | f1 (Hz) | f2 | f3 | vs analytic f1 |
| --- | --- | --- | --- | --- |
| Analytic `1.028·c·t/L²` | 172.963 | — | — | |
| 1D Timoshenko | 172.912 | 476.514 | 933.831 | −0.5 cent |

Nodes land at 0.22416 and 0.77584. The solve is well under a millisecond once
the matrices are built; the whole call stays far below the 500 ms test budget.

## Tuning loop

Given a target frequency, length is adjusted by the secant method on `x = 1/L²`,
which is the Euler scaling (`f ∝ 1/L²`). The first guess is the analytic
length. Iteration stops when f1 is inside 0.4 cent, so a rounded display reads
±0¢. Holes of the requested diameter sit at the node fractions and are included
while solving. If the computed nodes then differ from the assumed hole centres
by more than 0.002 of the length, the holes move and the secant runs once more.

In the sculpture the holes are cut on the outline at those fractions, on the
centreline. `tuneModel = free` selects this path. `cantilever` is unchanged
and remains the default.

## 2D Mindlin check

`tools/mindlin_plate.py` solves a Reissner–Mindlin plate on the real rectangle
with [scikit-fem](https://github.com/kinnala/scikit-fem) (bilinear quads, three
degrees of freedom per node: `w`, `θx`, `θy`). Bending uses the default
quadrature. Shear uses one point per quad, again to avoid locking. Nothing is
clamped, so the rigid modes fall out and the next eigenvalues are the plate
modes. A mode is called bending or torsion from the transverse displacement on
an end cross-section (the first torsion mode has a node at mid-length, so a
mid-span sample cannot tell them apart).

Same 300 × 50 × 3 mm steel plate. The timed mesh is 30 × 5 quads, 558 degrees
of freedom. A 60 × 10 mesh (2013 dof) is only a convergence check.

| Model | f1 (Hz) | f2 bend | f3 bend | first torsion |
| --- | --- | --- | --- | --- |
| Analytic beam | 172.963 | — | — | — |
| 1D Timoshenko, 100 elements | 172.912 | 476.514 | 933.831 | — |
| 2D Mindlin, 30×5, native | 173.448 | 481.641 | 954.299 | 613.109 |
| 2D Mindlin, 30×5, Pyodide | 173.449 | 481.738 | 954.302 | 613.111 |
| 2D Mindlin, 60×10, native | 173.196 | 479.356 | 944.205 | 616.951 |

f1 of the 1D model is 0.5 cent flat of the analytic strip. The 30×5 plate is
4.9 cents sharp of that strip; refining the mesh brings it to 2.3 cents. The
rest is the plate itself (Poisson stiffening, anticlastic curvature, a finite
width), which a beam cannot see. Overtones move more: the plate's second and
third bending modes sit a little sharp of the beam, and a torsional mode near
613 Hz falls between them. The fast model does not report torsion. Playback
uses the three bending partials only.

For a tuned bar this means the length from the 1D loop is a starting cut. A
real plate, and a tuner, will want a small trim. The preset keeps the tuning
allowance at zero so the drawn length is the tuned length; edge rounds of 2 mm
on the Free Palestine outlines still leave the worker's re-solve of the cut
shape inside 1 cent of the target (see `test/tuning.test.ts`).

### Solve time

Native is CPython 3.12 with numpy/scipy and scikit-fem 12.0.2. Pyodide is
0.27.7 (numpy 2.0.2, scipy 1.14.1, the same scikit-fem) via
`tools/mindlin_pyodide.mjs`. Both run the identical script on the 30×5 mesh.
Times are assemble plus the eigen-solve, not interpreter startup.

| Runtime | Assemble | Eigen | Total solve |
| --- | --- | --- | --- |
| Native | 13 ms | 7 ms | 17–21 ms (three repeats: 20.6, 17.1, 17.5) |
| Pyodide | 43 ms | 47 ms | 90 ms |

Pyodide is about five times the native solve. Bringing the runtime up is a
separate cost: about 1.2 s to boot a warm Pyodide, 1.3 s to load the cached
numpy/scipy wheels, 0.4 s for scikit-fem, and 1.2 s of script wall time of
which the 90 ms above is the actual plate. The 1D worker never pays that; the
2D script is a check, not part of the app bundle.

Pyodide is not an app dependency. From a scratch directory:

```
npm install --prefix /tmp/pyodide-run pyodide
NODE_PATH=/tmp/pyodide-run/node_modules node tools/mindlin_pyodide.mjs
```

If that import fails, `python3 tools/mindlin_plate.py` is the same numbers
without the wasm runtime.

## Speech-like (vowel colours)

**Tuned plates › Speech-like** builds on Words: each syllable gets a cluster of
plates tuned to the vowel's formants (F1, F2, and optionally F3) from
**Peterson & Barney (1952)**, *J. Acoust. Soc. Am.* 24, 175–184 (`src/core/speechTuning.ts`).
Each formant is octave-shifted until the predicted bar length sits in the
10–2500 mm tuner range. An optional **Melody plate** per syllable rings the
speech-melody note from Words mode; the cluster is meant to be struck together.

This suggests vowel colour and rhythm, not intelligible speech. The tuning table
shows a live plate count and Chop Chop price estimate, with **Melody preview**
and **Speech-like preview** in Web Audio.

## Words (chant)

**Tuned plates › Words (chant)** turns any phrase into one plate per syllable.
`src/core/chantWords.ts` syllabifies English with a small rule set; hyphens in
the text override it (`FREE-PAL-ES-TINE`). A speech-like melody lifts stressed
syllables and falls back to **Melody home** on the last syllable; each note can
be changed in the tuning table. Rhythm for the Web Audio preview comes from
vowel length (long vowels and longer codas get more time at 96 bpm). Changing
the phrase updates the plate count, etched labels, tuned lengths, and chant
playback.

## Free Palestine

The Sound preset uses Words mode. Four free-free steel plates, 3 mm, one
syllable each: FREE, PAL, ES, TINE.
The contour is sol–do–ti–sol, **G4 C5 B4 G4** (392.00, 523.25, 493.88, 392.00 Hz).
The call jumps a fourth onto PAL, steps down to ES, and comes home on TINE,
which is the same bar as FREE. That is a singable four-note chant rather than
a transcription of one particular recording.

Rhythm at 96 bpm, the way the phrase is usually called: a quarter on FREE, two
eighths on PAL and ES, a dotted quarter on TINE. Onsets are 0, 0.625, 0.9375
and 1.25 seconds (`CHANT_ONSETS`). The preview sums decaying sines at each
plate's computed f1, f2 and f3 (amplitudes 1, 0.28, 0.14; decays 1.5, 4.2 and
7.5 s⁻¹) and lets them overlap.

Width is 140 mm, which does not set the pitch, so the face can carry an image.
Mounting holes are Ø8 mm at the two nodes. Embed is zero: the plates stand on
the base rather than being cast in as cantilevers, and there is no tuning
allowance. Each plate is etched with its syllable and note (`FREE G4`, and so
on).

Lengths from the fast model, holes included. f1 is the target; the cents column
is the residual of the secant.

| Plate | Note | Length | f1 | f2 | f3 | cents |
| --- | --- | --- | --- | --- | --- | --- |
| FREE | G4 | 199.11 mm | 391.995 Hz | 1078.75 | 2112.48 | +0.000 |
| PAL | C5 | 172.29 mm | 523.251 Hz | 1439.08 | 2816.41 | −0.000 |
| ES | B4 | 177.34 mm | 493.883 Hz | 1358.48 | 2659.07 | −0.000 |
| TINE | G4 | 199.11 mm | 391.995 Hz | 1078.75 | 2112.48 | +0.000 |

Nodes sit at 0.2240 and 0.7760 of each bar. The tuning table's **Play the
chant** button speaks them in that order. A per-plate play button speaks one
bar. Once the deferred worker has re-read the finished outline (edge rounds and
holes included), playback uses those partials.
