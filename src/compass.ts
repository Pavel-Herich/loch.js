import type { Point } from './lox';
import { SHOT_DUPLICATE, SHOT_SPLAY, SHOT_SURFACE } from './lox-shots';
import { SurveyModel, surveyText } from './survey-model';

const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const COORDINATES = new RegExp(`^\\s*(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})(?:\\s+(.*))?$`);
const METRES_PER_FOOT = 0.3048;

/** Compass plot commands; https://www.fountainware.com/compass/HTML_Help/Compass_Viewer/plotfileformat.htm */
export function parseCompass(buffer: ArrayBuffer) {
  const text = surveyText(new Uint8Array(buffer)).split('\x1a', 1)[0], model = new SurveyModel();
  let current: Point | undefined, survey = '', section = '', title = '', firstSurvey = '', feature = false;
  const lines = text.split(/\r\n|\n|\r/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    const command = line[0], body = line.slice(1).trim();
    if (command === 'S') { section = body; title ||= body; current = undefined; feature = false; continue; }
    if (command === 'N') { survey = body.split(/\s/, 1)[0]; firstSurvey ||= survey; feature = false; continue; }
    if (command === 'F') { feature = true; current = undefined; continue; }
    if (feature || 'ZXPLOGCRT'.includes(command)) continue;
    if (!['M', 'D', 'd'].includes(command)) throw new Error(`Invalid Compass .plt command on line ${index + 1}: ${command}`);
    const match = COORDINATES.exec(body);
    if (!match) throw new Error(`Invalid Compass .plt coordinates on line ${index + 1}`);
    // Compass coordinates are North, East, Up in feet; the viewer uses East, North, Up in metres.
    const point: Point = [Number(match[2]) * METRES_PER_FOOT, Number(match[1]) * METRES_PER_FOOT, Number(match[3]) * METRES_PER_FOOT];
    const options = (match[4] ?? '').split('"', 1)[0];
    const name = /(?:^|\s)S(\S+)/.exec(options)?.[1];
    if (!name) throw new Error(`Missing Compass station name on line ${index + 1}`);
    const flags = /(?:^|\s)F([A-Z]*)/.exec(options)?.[1] ?? '';
    const shotFlags = (command === 'd' || flags.includes('P') ? SHOT_SURFACE : 0)
      | (flags.includes('L') ? SHOT_DUPLICATE : 0) | (flags.includes('S') ? SHOT_SPLAY : 0);
    model.station(name, point, [section, survey].filter(Boolean));
    // The P shot flag and lowercase d represent plot-excluded (conventionally surface) shots, matching Survex img.
    if (command !== 'M' && current && !flags.includes('X')) model.shot(current, point, shotFlags);
    current = model.point(point);
  }
  return model.finish(title || firstSurvey);
}
