/**
 * Open a fabrication zip (Save / Export ZIP): the working copy is
 * `project.strata.json` inside. Settings come from deserialize(), which fills
 * missing params and depth fields from current defaults (schema migration).
 */
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate';
import { deserialize, serialize, type Project } from './project';

export class ProjectZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectZipError';
  }
}

function basename(path: string): string {
  const n = path.replace(/\\/g, '/');
  const i = n.lastIndexOf('/');
  return i >= 0 ? n.slice(i + 1) : n;
}

/** The zip entry that holds the project, if any. */
export function projectZipEntry(names: string[]): string | undefined {
  const normalised = names.map((n) => n.replace(/\\/g, '/'));
  const exact = normalised.find((n) => basename(n).toLowerCase() === 'project.strata.json');
  if (exact) return names[normalised.indexOf(exact)];
  const loose = normalised.find((n) => /\.strata\.json$/i.test(basename(n)));
  return loose ? names[normalised.indexOf(loose)] : undefined;
}

export function isProjectZipName(name: string, type = ''): boolean {
  if (/\.zip$/i.test(name)) return true;
  return type === 'application/zip' || type === 'application/x-zip-compressed';
}

/** Plate count written by Export ZIP: `plates/*.dxf`, else `manifest.json`. */
export function zipExportedPlateCount(files: Record<string, Uint8Array>): number | undefined {
  const dxf = Object.keys(files).filter((n) => {
    const p = n.replace(/\\/g, '/');
    return /(?:^|\/)plates\/[^/]+\.dxf$/i.test(p);
  }).length;
  if (dxf) return dxf;
  const manifestKey = Object.keys(files).find((n) => basename(n.replace(/\\/g, '/')).toLowerCase() === 'manifest.json');
  if (!manifestKey) return undefined;
  try {
    const raw = JSON.parse(strFromU8(files[manifestKey])) as { plateCount?: unknown };
    return typeof raw.plateCount === 'number' && Number.isFinite(raw.plateCount) ? raw.plateCount : undefined;
  } catch {
    return undefined;
  }
}

export function projectFromZip(bytes: Uint8Array): { project: Project; entry: string; plateCount?: number } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new ProjectZipError('That file is not a readable zip');
  }
  const names = Object.keys(files);
  const entry = projectZipEntry(names);
  if (!entry) {
    throw new ProjectZipError('This zip has no project.strata.json — export a fabrication zip from Save or Export ZIP.');
  }
  const text = strFromU8(files[entry]).replace(/^\uFEFF/, '');
  try {
    return { project: deserialize(text), entry, plateCount: zipExportedPlateCount(files) };
  } catch (e) {
    throw new ProjectZipError(`Could not read ${entry}: ${(e as Error).message}`);
  }
}

/** Wrap a project as a zip that Open can read (no DXFs). */
export function projectOnlyZip(project: Project): Uint8Array {
  return zipSync({ 'project.strata.json': strToU8(serialize(project)) }, { level: 6 });
}
