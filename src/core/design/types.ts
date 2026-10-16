import type { DepthFace } from '../autoDimension';
import type { MasterOrientation, MasterPresetId } from '../masterPresets';
import type { MapSpec } from '../mapSpec';
import type { Project } from '../project';
import type { RawValue } from '../params';

/** Character range in the original instruction text. */
export interface Span {
  start: number;
  end: number;
}

export interface ProjectPatch {
  params?: Record<string, RawValue>;
  preset?: string;
  masterSize?: { id: string; orientation?: MasterOrientation };
  name?: string;
  /** Run auto-dimension on faces after other patch fields (needs metric depth on that image). */
  autoDimension?: { faces: DepthFace[]; reliefExaggeration?: number };
  /** Map function spec for the top face (ticket T18). */
  map?: Partial<MapSpec> & { bbox?: MapSpec['bbox'] };
}

export interface ParseContext {
  project: Project;
}

export interface ParseResult {
  patch: ProjectPatch;
  matched: Span[];
  unrecognised: Span[];
  notes: string[];
}

export interface DesignParser {
  parse(text: string, ctx: ParseContext): ParseResult;
}

export type { MasterPresetId };
