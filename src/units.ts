import unitsnet from 'unitsnet-js';

/**
 * Study quantities cross the API boundary in the engineer's unit and are stored
 * in SI. `unitsnet-js` supplies the conversion factors and the special
 * temperature handling; this module only maps the spellings engineers use onto
 * those quantity classes.
 */
const {
  Angle,
  Density,
  Duration,
  DynamicViscosity,
  ElectricConductivity,
  ElectricPotential,
  Force,
  HeatFlux,
  Length,
  Pressure,
  SpecificEntropy,
  Speed,
  Temperature,
  ThermalConductivity,
} = unitsnet;

type Dimension =
  | 'length'
  | 'pressure'
  | 'force'
  | 'density'
  | 'thermalConductivity'
  | 'specificHeat'
  | 'dynamicViscosity'
  | 'electricConductivity'
  | 'heatFlux'
  | 'powerDensity'
  | 'speed'
  | 'potential'
  | 'duration'
  | 'temperature'
  | 'angle'
  | 'dimensionless';

interface UnitDefinition {
  dimension: Dimension;
  toSI: (value: number) => number;
  /** Omitted for linear units, where the inverse factor is enough. */
  fromSI?: (value: number) => number;
}

const units = new Map<string, UnitDefinition>();

function add(
  aliases: readonly string[],
  dimension: Dimension,
  toSI: (value: number) => number,
  fromSI?: (value: number) => number,
): void {
  for (const alias of aliases) units.set(alias, { dimension, toSI, ...(fromSI ? { fromSI } : {}) });
}

add(['m', 'meter', 'meters', 'metre', 'metres'], 'length', (v) => v);
add(
  ['mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres'],
  'length',
  (v) => Length.FromMillimeters(v).Meters,
);
add(
  ['cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres'],
  'length',
  (v) => Length.FromCentimeters(v).Meters,
);
add(
  ['um', 'µm', 'micrometer', 'micrometers', 'micron', 'microns'],
  'length',
  (v) => Length.FromMicrometers(v).Meters,
);
add(['in', 'inch', 'inches', '"'], 'length', (v) => Length.FromInches(v).Meters);
add(['ft', 'foot', 'feet', "'"], 'length', (v) => Length.FromFeet(v).Meters);
add(['mil', 'mils', 'thou'], 'length', (v) => Length.FromMils(v).Meters);

add(['pa', 'pascal', 'pascals', 'n/m2', 'n/m^2', 'n/m²'], 'pressure', (v) => v);
add(['kpa'], 'pressure', (v) => Pressure.FromKilopascals(v).Pascals);
add(['mpa'], 'pressure', (v) => Pressure.FromMegapascals(v).Pascals);
add(['gpa'], 'pressure', (v) => Pressure.FromGigapascals(v).Pascals);
add(
  ['n/mm2', 'n/mm^2', 'n/mm²'],
  'pressure',
  (v) => Pressure.FromNewtonsPerSquareMillimeter(v).Pascals,
);
add(['psi'], 'pressure', (v) => Pressure.FromPoundsForcePerSquareInch(v).Pascals);
add(['ksi'], 'pressure', (v) => Pressure.FromKilopoundsForcePerSquareInch(v).Pascals);
add(
  ['lbf/in2', 'lbf/in^2', 'lbf/in²'],
  'pressure',
  (v) => Pressure.FromPoundsForcePerSquareInch(v).Pascals,
);
add(
  ['kip/in2', 'kip/in^2', 'kip/in²'],
  'pressure',
  (v) => Pressure.FromKilopoundsForcePerSquareInch(v).Pascals,
);

add(['n', 'newton', 'newtons'], 'force', (v) => v);
add(['kn', 'kilonewton', 'kilonewtons'], 'force', (v) => Force.FromKilonewtons(v).Newtons);
add(['lbf', 'pound-force', 'pound force'], 'force', (v) => Force.FromPoundsForce(v).Newtons);
add(['kip', 'kips', 'klbf'], 'force', (v) => Force.FromKilopoundsForce(v).Newtons);

add(['kg/m3', 'kg/m^3', 'kg/m³'], 'density', (v) => v);
add(
  ['g/cm3', 'g/cm^3', 'g/cm³'],
  'density',
  (v) => Density.FromGramsPerCubicCentimeter(v).KilogramsPerCubicMeter,
);
add(
  ['lb/in3', 'lb/in^3', 'lb/in³'],
  'density',
  (v) => Density.FromPoundsPerCubicInch(v).KilogramsPerCubicMeter,
);

add(['w/(m.k)', 'w/m.k', 'w/mk', 'w/(m·k)'], 'thermalConductivity', (v) => v);
add(
  ['btu/(h.ft.f)', 'btu/(h·ft·°f)', 'btu/hr-ft-f', 'btu/(hr.ft.°f)'],
  'thermalConductivity',
  (v) => ThermalConductivity.FromBtusPerHourFootFahrenheit(v).WattsPerMeterKelvin,
);

add(['j/(kg.k)', 'j/kg.k', 'j/(kg·k)', 'j/kgk'], 'specificHeat', (v) => v);
add(
  ['kj/(kg.k)', 'kj/kg.k', 'kj/(kg·k)'],
  'specificHeat',
  (v) => SpecificEntropy.FromKilojoulesPerKilogramKelvin(v).JoulesPerKilogramKelvin,
);
add(
  ['btu/(lb.f)', 'btu/(lb·°f)', 'btu/lb-f'],
  'specificHeat',
  (v) => SpecificEntropy.FromBtusPerPoundFahrenheit(v).JoulesPerKilogramKelvin,
);

add(['pa.s', 'pa·s', 'n.s/m2'], 'dynamicViscosity', (v) => v);
add(
  ['mpa.s', 'mpa·s'],
  'dynamicViscosity',
  (v) => DynamicViscosity.FromMillipascalSeconds(v).PascalSeconds,
);
add(
  ['cp', 'centipoise'],
  'dynamicViscosity',
  (v) => DynamicViscosity.FromCentipoise(v).PascalSeconds,
);

add(['s/m', 'siemens/m'], 'electricConductivity', (v) => v);
// 1 S/mm is one siemens per millimetre of path, i.e. 1000 S/m.
add(['s/mm', 'siemens/mm'], 'electricConductivity', (v) => v * 1000);
add(
  ['s/cm', 'siemens/cm'],
  'electricConductivity',
  (v) => ElectricConductivity.FromSiemensPerCentimeter(v).SiemensPerMeter,
);

add(['w/m2', 'w/m^2', 'w/m²'], 'heatFlux', (v) => v);
add(
  ['w/mm2', 'w/mm^2', 'w/mm²'],
  'heatFlux',
  (v) => HeatFlux.FromWattsPerSquareMillimeter(v).WattsPerSquareMeter,
);
add(
  ['btu/(h.ft2)', 'btu/(h·ft²)'],
  'heatFlux',
  (v) => HeatFlux.FromBtusPerHourSquareFoot(v).WattsPerSquareMeter,
);

add(['w/m3', 'w/m^3', 'w/m³'], 'powerDensity', (v) => v);
// 1 W/mm^3 is 10^9 W/m^3; UnitsNet has no cubic-millimetre member.
add(['w/mm3', 'w/mm^3', 'w/mm³'], 'powerDensity', (v) => v * 1e9);

add(['m/s'], 'speed', (v) => v);
add(['mm/s'], 'speed', (v) => Speed.FromMillimetersPerSecond(v).MetersPerSecond);
add(['in/s'], 'speed', (v) => Speed.FromInchesPerSecond(v).MetersPerSecond);
add(['ft/s'], 'speed', (v) => Speed.FromFeetPerSecond(v).MetersPerSecond);

add(['v', 'volt', 'volts'], 'potential', (v) => v);
add(
  ['mv', 'millivolt', 'millivolts'],
  'potential',
  (v) => ElectricPotential.FromMillivolts(v).Volts,
);

add(['s', 'sec', 'second', 'seconds'], 'duration', (v) => v);
add(['ms', 'millisecond', 'milliseconds'], 'duration', (v) => Duration.FromMilliseconds(v).Seconds);
add(['min', 'minute', 'minutes'], 'duration', (v) => Duration.FromMinutes(v).Seconds);
add(['h', 'hr', 'hour', 'hours'], 'duration', (v) => Duration.FromHours(v).Seconds);

add(
  ['k', 'kelvin', 'kelvins'],
  'temperature',
  (v) => v,
  (v) => v,
);
add(
  ['degc', '°c', 'celsius'],
  'temperature',
  (v) => Temperature.FromDegreesCelsius(v).Kelvins,
  (v) => Temperature.FromKelvins(v).DegreesCelsius,
);
add(
  ['degf', '°f', 'fahrenheit'],
  'temperature',
  (v) => Temperature.FromDegreesFahrenheit(v).Kelvins,
  (v) => Temperature.FromKelvins(v).DegreesFahrenheit,
);
add(
  ['rankine', 'deg r', '°r'],
  'temperature',
  (v) => Temperature.FromDegreesRankine(v).Kelvins,
  (v) => Temperature.FromKelvins(v).DegreesRankine,
);

add(['deg', 'degree', 'degrees', '°'], 'angle', (v) => Angle.FromDegrees(v).Radians);
add(['rad', 'radian', 'radians'], 'angle', (v) => v);

add(['1', 'dimensionless', '-'], 'dimensionless', (v) => v);

/** Normalize spelling and common engineering symbols before lookup. */
function key(unit: string): string {
  return unit
    .trim()
    .toLowerCase()
    .replaceAll('²', '2')
    .replaceAll('³', '3')
    .replaceAll('·', '.')
    .replaceAll('*', '.')
    .replace(/\s+/g, '');
}

/** Canonical target units used by the study schema. */
const canonical: Record<string, Dimension> = {
  m: 'length',
  pa: 'pressure',
  'n/m2': 'pressure',
  n: 'force',
  'kg/m3': 'density',
  'w/(m.k)': 'thermalConductivity',
  'j/(kg.k)': 'specificHeat',
  'pa.s': 'dynamicViscosity',
  's/m': 'electricConductivity',
  'w/m2': 'heatFlux',
  'w/m3': 'powerDensity',
  'm/s': 'speed',
  v: 'potential',
  s: 'duration',
  k: 'temperature',
  rad: 'angle',
  '1': 'dimensionless',
};

export interface ConvertedQuantity {
  value: number;
  dimension: Dimension;
}

/** Convert one quantity to its canonical SI value. Unknown combinations throw. */
export function toSI(value: number, unit: string): ConvertedQuantity {
  const definition = units.get(key(unit));
  if (!definition) throw new Error(`unsupported unit '${unit}'`);
  if (!Number.isFinite(value)) throw new Error('quantity value must be finite');
  return { value: definition.toSI(value), dimension: definition.dimension };
}

export function dimensionOfCanonical(unit: string): Dimension | undefined {
  return canonical[key(unit)];
}

/** Convert a canonical SI value into the requested display unit. */
export function fromSI(value: number, unit: string): number {
  const definition = units.get(key(unit));
  if (!definition) throw new Error(`unsupported unit '${unit}'`);
  if (definition.fromSI) return definition.fromSI(value);
  return value / definition.toSI(1);
}
