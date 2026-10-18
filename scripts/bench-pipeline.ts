// Times full and preview builds on the 93-plate Vermilion and on Shadow with 8 frames.
// npx tsx scripts/bench-pipeline.ts
import { createFrontPipeline, type Assets } from '../src/core/pipeline';
import type { Project } from '../src/core/project';
import { shadow8, shadowFrameGray, vermilion93 } from '../test/engine-fixtures';

const none: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

function bench(label: string, p: Project, assets: Assets) {
  for (const preview of [false, true]) {
    const run = createFrontPipeline({ preview });
    run(p, assets);
    const ms: number[] = [];
    for (const amp of [40, 50, 60]) {
      const f = run({ ...p, params: { ...p.params, erosionAmp: String(amp) } }, assets);
      ms.push(f.totalMs);
    }
    console.log(`${label} ${preview ? 'preview' : 'full'}: ${ms.map((x) => x.toFixed(0)).join(', ')} ms per edit`);
  }
}

bench('Vermilion 93', vermilion93(), none);
bench('Shadow 8 frames', shadow8(), { ...none, shadowFrames: Array.from({ length: 8 }, (_, i) => shadowFrameGray(i)) });
