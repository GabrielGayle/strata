import { describe, expect, it } from 'vitest';
import {
  cleanEarthView,
  earthViewCameraLonLat,
  earthViewEnu,
  earthViewToWorldPose,
  earthWorldFrame,
  fitMapBoxToView,
  lookDirectionWorld,
  matchBaseToMapBbox,
  parseEarthView,
  pointViewMessage,
  worldPoseTiltDeg,
  wrapHeadingDeg,
  type EarthView,
} from '../src/core/earthView';
import { bboxContainsPoint } from '../src/core/mapPresets';
import { defaultMapSpec } from '../src/core/mapSpec';
import { evaluateParams } from '../src/core/params';
import { deserialize, newProject, serialize } from '../src/core/project';
import { NEASDEN_FAST_BBOX } from './map-fixtures';

const WOOLWICH =
  'https://earth.google.com/web/search/Woolwich,+London/@51.48946601,0.06689012,19.6383861a,192.84630668d,35y,-75.96181029h,72.70188718t,0r';
const CHARLTON = '@51.48171239,0.04793208,43a,5168.7d,35y,-124.30h,85.33t';

function mustParse(input: string): EarthView {
  const r = parseEarthView(input);
  if (!r.ok) throw new Error(r.error);
  return r.view;
}

function defaultFrame(bbox = NEASDEN_FAST_BBOX) {
  const p = newProject();
  p.images.top = {
    name: 'Map',
    dataUrl: 'data:image/png;base64,xx',
    map: defaultMapSpec({ bbox, title: 'Test' }),
  };
  const v = evaluateParams(p.params).values;
  const frame = earthWorldFrame(p.images.top?.map, v, p.images.top?.depth);
  if (!frame) throw new Error('expected frame');
  return { p, v, frame };
}

describe('Google Earth view parser', () => {
  it('reads the Woolwich / Shooters Hill URL', () => {
    const v = mustParse(WOOLWICH);
    expect(v.lat).toBeCloseTo(51.48946601, 7);
    expect(v.lon).toBeCloseTo(0.06689012, 7);
    expect(v.altitude).toBeCloseTo(19.6383861, 5);
    expect(v.distance).toBeCloseTo(192.84630668, 5);
    expect(v.fov).toBe(35);
    expect(v.heading).toBeCloseTo(-75.96181029, 5);
    expect(v.tilt).toBeCloseTo(72.70188718, 5);
    expect(v.roll).toBe(0);
  });

  it('reads the Charlton @ fragment', () => {
    const v = mustParse(CHARLTON);
    expect(v.lat).toBeCloseTo(51.48171239, 7);
    expect(v.lon).toBeCloseTo(0.04793208, 7);
    expect(v.altitude).toBe(43);
    expect(v.distance).toBeCloseTo(5168.7, 5);
    expect(v.heading).toBeCloseTo(-124.3, 5);
    expect(v.tilt).toBeCloseTo(85.33, 5);
    expect(v.fov).toBe(35);
  });

  it('defaults missing FOV to 35 and missing roll to 0', () => {
    const v = mustParse('@51.5,0.1,20a,100d,-80h,70t');
    expect(v.fov).toBe(35);
    expect(v.roll).toBe(0);
    expect(v.heading).toBeCloseTo(-80, 5);
  });

  it('accepts a negative heading', () => {
    const v = mustParse('@51.5,-0.1,10a,-75.96h,60t');
    expect(v.heading).toBeCloseTo(-75.96, 5);
  });

  it('normalises heading > 360', () => {
    expect(wrapHeadingDeg(400)).toBeCloseTo(40, 8);
    const v = mustParse('@51.5,0.1,10a,400h,45t');
    expect(v.heading).toBeCloseTo(40, 8);
  });

  it('accepts + signs', () => {
    const v = mustParse('@+51.5,+0.06,12a,+90h,45t');
    expect(v.lat).toBeCloseTo(51.5, 6);
    expect(v.lon).toBeCloseTo(0.06, 6);
    expect(v.heading).toBeCloseTo(90, 6);
  });

  it('treats typed lat, lon, altitude, heading, tilt as the camera (no distance)', () => {
    const v = mustParse('51.489, 0.067, 20, -76, 73');
    expect(v.lat).toBeCloseTo(51.489, 5);
    expect(v.lon).toBeCloseTo(0.067, 5);
    expect(v.altitude).toBe(20);
    expect(v.heading).toBeCloseTo(-76, 5);
    expect(v.tilt).toBe(73);
    expect(v.distance).toBeUndefined();
    expect(v.fov).toBe(35);
  });

  it('rejects garbage with a friendly message', () => {
    for (const bad of ['', 'hello', 'https://example.com/', '91,0', '51.5']) {
      const r = parseEarthView(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(8);
    }
  });
});

describe('Earth URL camera vs look-at', () => {
  it('places the Woolwich camera above the look-at, not underground', () => {
    const v = mustParse(WOOLWICH);
    const { camera, lookAt } = earthViewEnu(v);
    expect(lookAt.up).toBeCloseTo(19.6383861, 5);
    expect(camera.up).toBeGreaterThan(lookAt.up + 40);
    expect(camera.up).toBeLessThan(lookAt.up + 90);
    // Heading −76° looks WNW, so the camera sits ESE of the target.
    expect(camera.east).toBeGreaterThan(100);
    expect(camera.north).toBeLessThan(0);
  });

  it('places the long Charlton camera hundreds of metres up', () => {
    const v = mustParse(CHARLTON);
    const { camera, lookAt } = earthViewEnu(v);
    expect(lookAt.up).toBe(43);
    expect(camera.up).toBeGreaterThan(400);
    expect(camera.up).toBeLessThan(550);
  });
});

describe('camera math in +X south / +Z west', () => {
  it('heading 0 looks north (−X); heading 90 looks east (−Z); tilt 0 looks down (−Y)', () => {
    const north = lookDirectionWorld(0, 90);
    expect(north.x).toBeCloseTo(-1, 5);
    expect(north.y).toBeCloseTo(0, 5);
    expect(north.z).toBeCloseTo(0, 5);

    const east = lookDirectionWorld(90, 90);
    expect(east.x).toBeCloseTo(0, 5);
    expect(east.y).toBeCloseTo(0, 5);
    expect(east.z).toBeCloseTo(-1, 5);

    const down = lookDirectionWorld(0, 0);
    expect(down.x).toBeCloseTo(0, 5);
    expect(down.y).toBeCloseTo(-1, 5);
    expect(down.z).toBeCloseTo(0, 5);
  });

  it('with a known target and heading 0, the camera looks north', () => {
    const { frame } = defaultFrame();
    const view: EarthView = {
      lat: (NEASDEN_FAST_BBOX[1] + NEASDEN_FAST_BBOX[3]) / 2,
      lon: (NEASDEN_FAST_BBOX[0] + NEASDEN_FAST_BBOX[2]) / 2,
      altitude: 40,
      distance: 120,
      heading: 0,
      tilt: 60,
      fov: 35,
      roll: 0,
    };
    const pose = earthViewToWorldPose(view, frame);
    const lx = pose.target[0] - pose.position[0];
    const ly = pose.target[1] - pose.position[1];
    const lz = pose.target[2] - pose.position[2];
    expect(lx, 'looks toward −X (north)').toBeLessThan(0);
    expect(Math.abs(lz)).toBeLessThan(Math.abs(lx) * 0.15);
    expect(ly).toBeLessThan(0);
    expect(pose.position[0], 'camera sits south of the target (+X)').toBeGreaterThan(pose.target[0]);
  });

  it('heading 90 puts the camera west of the target looking east', () => {
    const { frame } = defaultFrame();
    const view: EarthView = {
      lat: (NEASDEN_FAST_BBOX[1] + NEASDEN_FAST_BBOX[3]) / 2,
      lon: (NEASDEN_FAST_BBOX[0] + NEASDEN_FAST_BBOX[2]) / 2,
      altitude: 40,
      distance: 120,
      heading: 90,
      tilt: 70,
      fov: 35,
      roll: 0,
    };
    const pose = earthViewToWorldPose(view, frame);
    const lz = pose.target[2] - pose.position[2];
    expect(lz, 'looks toward −Z (east)').toBeLessThan(0);
    expect(pose.position[2], 'camera sits west of the target (+Z)').toBeGreaterThan(pose.target[2]);
  });
});

describe('tilt is independent of vertical exaggeration', () => {
  it('keeps Earth tilt at ×1, ×4 and ×10', () => {
    const view = mustParse(WOOLWICH);
    const { frame } = defaultFrame();
    const tilts: number[] = [];
    for (const exaggeration of [1, 4, 10]) {
      const pose = earthViewToWorldPose(view, { ...frame, exaggeration });
      const tilt = worldPoseTiltDeg(pose);
      tilts.push(tilt);
      expect(tilt, `×${exaggeration}`).toBeCloseTo(view.tilt, 5);
      expect(pose.position[1]).toBeGreaterThan(pose.target[1]);
    }
    expect(Math.max(...tilts) - Math.min(...tilts)).toBeLessThan(1e-6);
  });
});

describe('fit map box to view', () => {
  it('Woolwich bbox contains the camera and extends WNW toward the Thames', () => {
    const v = mustParse(WOOLWICH);
    const bbox = fitMapBoxToView(v, { aspect: 16 / 9 });
    const cam = earthViewCameraLonLat(v);
    expect(bboxContainsPoint(bbox, cam.lon, cam.lat)).toBe(true);
    expect(bboxContainsPoint(bbox, v.lon, v.lat)).toBe(true);
    const [w, s, e, n] = bbox;
    const westSpan = cam.lon - w;
    const eastSpan = e - cam.lon;
    const northSpan = n - cam.lat;
    const southSpan = cam.lat - s;
    expect(westSpan, 'footprint runs west of the camera').toBeGreaterThan(eastSpan);
    expect(northSpan, 'footprint runs north of the camera (WNW)').toBeGreaterThan(southSpan * 0.4);
    expect(w).toBeLessThan(v.lon);
    expect(n).toBeGreaterThan(v.lat - 0.002);
  });

  it('Match base to map shape keeps the long side and resizes the short one', () => {
    const v = mustParse(WOOLWICH);
    const bbox = fitMapBoxToView(v, { aspect: 16 / 9 });
    const outline = matchBaseToMapBbox(bbox, { baseLength: 800, baseWidth: 300 });
    expect(outline).toBeTruthy();
    const length = Number(outline!.baseLength);
    const width = Number(outline!.baseWidth);
    expect(Math.max(length, width)).toBeCloseTo(800, 2);
    expect(Math.min(length, width)).toBeLessThan(800);
    expect(Math.min(length, width)).toBeGreaterThan(20);
    // Woolwich looks WNW, so the footprint is wider E–W than N–S → landscape base.
    expect(width, 'E–W is the long millimetre').toBeGreaterThan(length);
  });

  it('warns when the point is outside the current bbox', () => {
    const v = mustParse(WOOLWICH);
    expect(pointViewMessage(v, undefined)).toMatch(/No map box/i);
    expect(pointViewMessage(v, NEASDEN_FAST_BBOX)).toMatch(/outside the current map box/i);
    const around = fitMapBoxToView(v);
    expect(pointViewMessage(v, around)).toBeNull();
  });
});

describe('saved view round-trip', () => {
  it('survives serialize / deserialize and is absent on old saves', () => {
    const view = mustParse(WOOLWICH);
    const p = { ...newProject(), savedView: view };
    const back = deserialize(serialize(p));
    expect(back.savedView).toEqual(cleanEarthView(view));
    const old = deserialize(serialize(newProject()));
    expect(old.savedView).toBeUndefined();
    expect(cleanEarthView({ lat: 'nope' })).toBeUndefined();
  });
});
