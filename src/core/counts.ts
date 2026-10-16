import type { Model } from './pipeline';

/** Plate and part totals that must agree across header, status, pack, nest, and ZIP. */
export function packCounts(model: Model) {
  const plates = model.sliced.plates.filter((p) => p.parts.length).length;
  const parts = model.sliced.parts.length;
  const nested = model.nested.sheets.reduce((a, s) => a + s.placements.length, 0);
  return {
    plates,
    parts,
    bomPlates: model.bom.plateCount,
    bomParts: model.bom.partCount,
    nestedParts: nested,
    unplaced: model.nested.unplaced.length,
  };
}

export function assertCountsAgree(model: Model): void {
  const c = packCounts(model);
  if (c.plates !== c.bomPlates) throw new Error(`plate count ${c.plates} ≠ BOM ${c.bomPlates}`);
  if (c.parts !== c.bomParts) throw new Error(`part count ${c.parts} ≠ BOM ${c.bomParts}`);
  if (c.nestedParts + c.unplaced !== c.parts) throw new Error(`nested ${c.nestedParts} + unplaced ${c.unplaced} ≠ parts ${c.parts}`);
}

/** Counts written to the fabrication ZIP as manifest.json. */
export function packManifest(model: Model) {
  assertCountsAgree(model);
  const c = packCounts(model);
  return {
    version: 1 as const,
    plateCount: c.plates,
    partCount: c.parts,
    nestedParts: c.nestedParts,
    unplaced: c.unplaced,
    plates: model.sliced.plates
      .filter((p) => p.parts.length)
      .map((p) => ({
        key: p.def.key,
        plateId: p.parts[0]?.plateId ?? p.parts[0]?.id,
        partIds: p.parts.map((q) => q.id),
      })),
    parts: model.sliced.parts.map((p) => ({
      id: p.id,
      plateId: p.plateId ?? p.id,
      plateKey: p.plateKey,
    })),
    fragments: (model.sliced.fragments ?? []).map((e) => ({
      pieceId: e.pieceId,
      plateId: e.plateId,
      action: e.action,
      reason: e.reason,
      w: e.w,
      h: e.h,
    })),
  };
}
