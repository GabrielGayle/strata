import type { MasterOrientation, MasterPresetId } from '../masterPresets';
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
