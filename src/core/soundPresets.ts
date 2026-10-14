// Templates built on sound: tuned chimes (each plate rings a note) and stacks
// shaped by a tone's loudness or spectrum. Listed under "Sound" in Presets.
import type { Preset } from './project';
import { DEFAULT_SOUND, type SoundSpec } from './sound';
import type { RawValue } from './params';

export interface SoundPreset extends Preset {
  /** A sound picture drawn into one image slot when the preset loads. */
  sound?: { slot: 'side' | 'top' | 'front'; spec: SoundSpec };
}

/** A clean stand of chime plates: flat-topped, no insert, no erosion. */
const CHIMES: Record<string, RawValue> = {
  insShape: 'none',
  thickness: '6',
  baseHeight: '100',
  embedDepth: '40',
  anchorHoles: '2',
  anchorDia: '8',
  sideMargin: '20',
  edgeRound: '1.5',
  tuneAllowance: '2',
};

export const SOUND_PRESETS: SoundPreset[] = [
  {
    name: 'Chime scale',
    note: '8 plates tuned to C major, C3 to C4',
    params: {
      ...CHIMES, tuneMode: 'scale', tuneRoot: 'C3', tuneScale: 'major', tuneOrder: 'down',
      spacingMode: 'gapCount', plateCount: '8', plateGap: '22', baseLength: '280', baseWidth: '160',
    },
  },
  {
    name: 'Pentatonic arch',
    note: '11 plates in A minor pentatonic, tallest in the middle',
    params: {
      ...CHIMES, tuneMode: 'scale', tuneRoot: 'A2', tuneScale: 'pentaMinor', tuneOrder: 'middle',
      spacingMode: 'gapCount', plateCount: '11', plateGap: '20', baseLength: '340', baseWidth: '160',
    },
  },
  {
    name: 'Chord spiral',
    note: '12 radial plates spiralling up an A minor 7th',
    params: {
      ...CHIMES, sliceMode: 'radial', radialCount: '12', radialHub: '45', tuneMode: 'chord', tuneRoot: 'A2', tuneChord: 'min7', tuneOrder: 'up',
      baseLength: '440', baseWidth: '440',
    },
  },
  {
    name: 'Waveform ridge',
    note: 'A pulsing chord as a sound-wave sculpture, one bar per plate',
    params: {
      insShape: 'none', plateCount: '64', thickness: '1.5', baseLength: '700', baseWidth: '180', endMargin: '30',
      imgSideMode: 'heightmap', imgMix: '1', imgRange: '170', imgContrast: '1', imgSmooth: '0', stackHeight: '115', crest: '0', erosionAmp: '0', banding: '0',
    },
    sound: { slot: 'side', spec: { ...DEFAULT_SOUND, notes: 'A2 E3', beat: 2.5, seconds: 2, attack: 0.02, release: 0.75, view: 'bars', drawn: false, smooth: 0.015, aspect: 3 } },
  },
  {
    name: 'Spectrum field',
    note: "A rising saw-wave chord's harmonics pressed into the top, time along the stack",
    params: {
      insShape: 'none', plateCount: '60', thickness: '3', baseLength: '600', baseWidth: '240', endMargin: '30',
      stackHeight: '150', erosionAmp: '6', crest: '0', banding: '0',
      imgTopMode: 'carve', topProfile: 'tone', topSteps: '4', topDepth: '28', topThreshold: '0.05', topScale: '1', topRotate: '90', topMargin: '8',
      imgSmooth: '3', cutSmooth: '1.5',
    },
    sound: { slot: 'top', spec: { ...DEFAULT_SOUND, notes: 'C3 G3', wave: 'saw', glide: 7, beat: 0, seconds: 3, attack: 0.15, release: 0.5, view: 'spectrum', drawn: false, smooth: 0.01, aspect: 2.6 } },
  },
];
