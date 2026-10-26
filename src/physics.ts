import { requireThat } from './errors.js';
import { generateDcConductionSif, normalizeDcConduction } from './electric.js';
import { generateLaminarFlowSif, normalizeLaminarFlow } from './flow.js';
import { generateSif, normalizeThermal } from './thermal.js';
import {
  generateModalSif,
  generateStaticStructuralSif,
  normalizeModal,
  normalizeStaticStructural,
} from './structural.js';
import {
  parseDcPotentialMetrics,
  parseLaminarFlowVtuMetrics,
  parseStaticStructuralVtuMetrics,
  type ParsedVtu,
} from './results.js';
import type {
  ArtifactRef,
  DcConduction,
  LaminarFlowConfig,
  Mesh,
  Modal,
  StaticStructural,
  Study,
  Summary,
  Thermal,
} from './schemas.js';

export type CaseConfig = Thermal | StaticStructural | Modal | DcConduction | LaminarFlowConfig;
export type StudyPhysics = Study['physics'];
export type MeshContext = Pick<Mesh, 'groups' | 'connectedBodies' | 'boundaryBodies'>;
export type BuildContext = {
  groupId: Map<string, number>;
  surfaces: string[];
};

type SteadyThermalStudy = Extract<StudyPhysics, { kind: 'steady-thermal' }>;
type TransientThermalStudy = Extract<StudyPhysics, { kind: 'transient-thermal' }>;
type ThermalStudy = SteadyThermalStudy | TransientThermalStudy;
type StaticStructuralStudy = Extract<StudyPhysics, { kind: 'static-structural' }>;
type ModalStudy = Extract<StudyPhysics, { kind: 'modal' }>;
type DcStudy = Extract<StudyPhysics, { kind: 'dc-conduction' }>;
type FlowStudy = Extract<StudyPhysics, { kind: 'laminar-flow' }>;

// One entry per physics kind. Keeping normalize/generate, result handling, and
// study-to-case mapping here removes the repeated dispatch chains in the service
// while leaving each physics implementation in its own module.
export type PhysicsDefinition = {
  studyKind: StudyPhysics['kind'];
  casePhysics: CaseConfig['physics'];
  normalize: (input: unknown, mesh: MeshContext) => CaseConfig;
  generate: (config: CaseConfig) => string;
  resultField: { name: string; components: number };
  // Method syntax (bivariant parameters) so a per-kind definition whose build/
  // diagnostics take a narrower physics type still satisfies the table.
  build(physics: StudyPhysics, context: BuildContext): CaseConfig;
  diagnostics(physics: StudyPhysics): string[];
  observationUnits: Record<string, string>;
  metrics?: (vtu: ParsedVtu, source: ArtifactRef, time?: number) => Summary[];
};

// Erases the per-kind physics type so the table is homogeneous; the lookup
// functions guarantee the matching kind is passed to build/diagnostics.
function definePhysics<P extends StudyPhysics>(definition: {
  studyKind: P['kind'];
  casePhysics: CaseConfig['physics'];
  normalize: (input: unknown, mesh: MeshContext) => CaseConfig;
  generate: (config: CaseConfig) => string;
  resultField: { name: string; components: number };
  build: (physics: P, context: BuildContext) => CaseConfig;
  diagnostics: (physics: P) => string[];
  observationUnits: Record<string, string>;
  metrics?: (vtu: ParsedVtu, source: ArtifactRef, time?: number) => Summary[];
}): PhysicsDefinition {
  return definition;
}

// Thermal boundaries default to insulated unless explicitly overridden, so this
// needs the full set of surface selections rather than only assigned ones.
function buildThermalBoundaries(physics: ThermalStudy, { groupId, surfaces }: BuildContext) {
  const assigned = new Map(physics.boundaries.map((boundary) => [boundary.selection, boundary]));
  return surfaces.map((name) => {
    const boundary = assigned.get(name);
    const group = groupId.get(name)!;
    if (!boundary || boundary.kind === 'insulated') return { group, kind: 'insulated' as const };
    if (boundary.kind === 'inward-heat-flux')
      return { group, kind: 'flux' as const, inwardFlux: boundary.flux };
    return {
      group,
      kind: 'temperature' as const,
      temperature: boundary.temperature,
    };
  });
}

export const PHYSICS: PhysicsDefinition[] = [
  definePhysics<SteadyThermalStudy>({
    studyKind: 'steady-thermal',
    casePhysics: 'steady-heat-conduction',
    normalize: normalizeThermal,
    generate: (config) => generateSif(config as Thermal),
    resultField: { name: 'temperature', components: 1 },
    build: (physics, context) => ({
      physics: 'steady-heat-conduction' as const,
      materials: physics.materials.map((material) => ({
        group: context.groupId.get(material.selection)!,
        conductivity: material.conductivity,
        ...(material.reference === undefined ? {} : { reference: material.reference }),
      })),
      sources: physics.sources.map((source) => ({
        group: context.groupId.get(source.selection)!,
        heat: source.volumetricHeat,
      })),
      boundaries: buildThermalBoundaries(physics, context),
    }),
    diagnostics: () => ['Steady isotropic thermal conduction; linear tetrahedra; SI units.'],
    observationUnits: {
      temperature_min: 'K',
      temperature_max: 'K',
      temperature_mean: 'K',
      heat_flux_magnitude_mean: 'W/m2',
    },
  }),
  definePhysics<TransientThermalStudy>({
    studyKind: 'transient-thermal',
    casePhysics: 'transient-heat-conduction',
    normalize: normalizeThermal,
    generate: (config) => generateSif(config as Thermal),
    resultField: { name: 'temperature', components: 1 },
    build: (physics, context) => ({
      physics: 'transient-heat-conduction' as const,
      materials: physics.materials.map((material) => ({
        group: context.groupId.get(material.selection)!,
        conductivity: material.conductivity,
        density: material.density,
        heatCapacity: material.heatCapacity,
        ...(material.reference === undefined ? {} : { reference: material.reference }),
      })),
      sources: physics.sources.map((source) => ({
        group: context.groupId.get(source.selection)!,
        heat: source.volumetricHeat,
      })),
      boundaries: buildThermalBoundaries(physics, context),
      initialTemperature: physics.initialTemperature,
      time: physics.time,
    }),
    diagnostics: () => [
      'Transient isotropic thermal conduction; linear tetrahedra; SI units; uniform initial temperature and fixed timestep.',
    ],
    observationUnits: {
      temperature_min: 'K',
      temperature_max: 'K',
      temperature_mean: 'K',
      heat_flux_magnitude_mean: 'W/m2',
    },
  }),
  definePhysics<StaticStructuralStudy>({
    studyKind: 'static-structural',
    casePhysics: 'static-structural',
    normalize: normalizeStaticStructural,
    generate: (config) => generateStaticStructuralSif(config as StaticStructural),
    resultField: { name: 'displacement', components: 3 },
    build: (physics, { groupId }) => ({
      physics: 'static-structural' as const,
      materials: physics.materials.map((material) => ({
        group: groupId.get(material.selection)!,
        youngsModulus: material.youngsModulus,
        poissonRatio: material.poissonRatio,
        ...(material.reference === undefined ? {} : { reference: material.reference }),
      })),
      boundaries: physics.boundaries.map((boundary) => {
        const group = groupId.get(boundary.selection)!;
        switch (boundary.kind) {
          case 'fixed-displacement':
            return { group, kind: 'fixed-displacement' as const };
          case 'free':
            return { group, kind: 'free' as const };
          case 'prescribed-displacement':
            return {
              group,
              kind: 'prescribed-displacement' as const,
              displacement: boundary.displacement,
            };
          default:
            return {
              group,
              kind: 'uniform-traction' as const,
              traction: boundary.traction,
            };
        }
      }),
    }),
    diagnostics: () => [
      'Static, isotropic, linear small-strain elasticity; explicit SI material and surface conditions; linear tetrahedra.',
    ],
    observationUnits: {
      displacement_magnitude_min: 'm',
      displacement_magnitude_max: 'm',
      displacement_magnitude_mean: 'm',
      stress_xx_min: 'Pa',
      stress_xx_max: 'Pa',
      stress_xx_mean: 'Pa',
      von_mises_stress_max: 'Pa',
    },
    metrics: (vtu, source) => parseStaticStructuralVtuMetrics(vtu, source),
  }),
  definePhysics<ModalStudy>({
    studyKind: 'modal',
    casePhysics: 'modal',
    normalize: normalizeModal,
    generate: (config) => generateModalSif(config as Modal),
    resultField: { name: 'temperature', components: 1 },
    build: (physics, { groupId }) => ({
      physics: 'modal' as const,
      materials: physics.materials.map((material) => ({
        group: groupId.get(material.selection)!,
        youngsModulus: material.youngsModulus,
        poissonRatio: material.poissonRatio,
        density: material.density,
        ...(material.reference === undefined ? {} : { reference: material.reference }),
      })),
      boundaries: physics.boundaries.map((boundary) => {
        const group = groupId.get(boundary.selection)!;
        return boundary.kind === 'fixed-displacement'
          ? { group, kind: 'fixed-displacement' as const }
          : { group, kind: 'free' as const };
      }),
      modes: physics.modes,
    }),
    diagnostics: (physics) => [
      `Undamped, unloaded linear-elastic modal analysis; ${physics.modes} requested modes; frequencies derived from Elmer eigenvalues.`,
    ],
    observationUnits: { eigenfrequency: 'Hz' },
  }),
  definePhysics<DcStudy>({
    studyKind: 'dc-conduction',
    casePhysics: 'dc-conduction',
    normalize: normalizeDcConduction,
    generate: (config) => generateDcConductionSif(config as DcConduction),
    resultField: { name: 'potential', components: 1 },
    build: (physics, { groupId }) => ({
      physics: 'dc-conduction' as const,
      materials: physics.materials.map((material) => ({
        group: groupId.get(material.selection)!,
        electricalConductivity: material.electricalConductivity,
        ...(material.reference === undefined ? {} : { reference: material.reference }),
      })),
      boundaries: physics.boundaries.map((boundary) => {
        const group = groupId.get(boundary.selection)!;
        return boundary.kind === 'potential'
          ? { group, kind: 'potential' as const, potential: boundary.potential }
          : { group, kind: 'insulated' as const };
      }),
    }),
    diagnostics: () => [
      'Steady scalar DC conduction; explicit isotropic electrical conductivity and potential/insulated surface conditions; Joule heating and electromagnetic coupling are not modeled.',
    ],
    observationUnits: {
      potential_min: 'V',
      potential_max: 'V',
      potential_mean: 'V',
    },
    metrics: (vtu, source) => parseDcPotentialMetrics(vtu, source),
  }),
  definePhysics<FlowStudy>({
    studyKind: 'laminar-flow',
    casePhysics: 'laminar-flow',
    normalize: normalizeLaminarFlow,
    generate: (config) => generateLaminarFlowSif(config as LaminarFlowConfig),
    resultField: { name: 'velocity', components: 3 },
    build: (physics, { groupId }) => ({
      physics: 'laminar-flow' as const,
      materials: physics.materials.map((material) => ({
        group: groupId.get(material.selection)!,
        density: material.density,
        dynamicViscosity: material.dynamicViscosity,
        ...(material.reference === undefined ? {} : { reference: material.reference }),
      })),
      boundaries: physics.boundaries.map((boundary) => {
        const group = groupId.get(boundary.selection)!;
        return boundary.kind === 'pressure'
          ? { group, kind: 'pressure' as const, pressure: boundary.pressure }
          : { group, kind: 'no-slip' as const };
      }),
      regime: physics.regime,
    }),
    diagnostics: (physics) => [
      'Incompressible Newtonian laminar flow; explicit density, dynamic viscosity, pressure boundaries, and no-slip walls; no turbulence or multiphysics coupling.',
      'Laminar validity is not verified: confirm the Reynolds number is within the intended regime before relying on the result.',
      ...(physics.regime.mode === 'transient'
        ? ['Transient flow uses first-order BDF and requires explicit quiescent initial velocity.']
        : []),
    ],
    observationUnits: {
      velocity_magnitude_max: 'm/s',
      velocity_x_max: 'm/s',
      pressure_min: 'Pa',
      pressure_max: 'Pa',
    },
    metrics: (vtu, source, time) => parseLaminarFlowVtuMetrics(vtu, source, time),
  }),
];

// Run-start diagnostic per case physics (recorded before the solver runs).
export const RUN_DIAGNOSTICS: Record<CaseConfig['physics'], string> = {
  'steady-heat-conduction':
    'Serial linear steady conduction in SI units; no contact resistance or radiation.',
  'transient-heat-conduction':
    'Transient linear heat conduction in SI units with constant properties and fixed timesteps; no time-varying loads, contact resistance or radiation.',
  'static-structural':
    'Static isotropic linear small-strain elasticity in SI units; no plasticity, geometric nonlinearity, contact, or fracture.',
  modal:
    'Undamped, unloaded linear-elastic modal analysis; eigenfrequencies only; fixed-displacement constraints and constant isotropic material properties.',
  'dc-conduction':
    'Steady scalar DC conduction with explicitly assigned isotropic conductivity and prescribed-potential boundaries; insulated surfaces use natural zero-current conditions.',
  'laminar-flow':
    'Incompressible Newtonian laminar flow in SI units; no turbulence, compressibility, or multiphysics coupling.',
};

// Necessary (but not sufficient) study-level conditions that do not need the
// mesh. The per-component requirements need mesh topology and are checked during
// preparation; this catches the common mistakes at validate_study time.
export function necessaryStudyCondition(physics: StudyPhysics): string | undefined {
  const duplicates = (selections: string[], label: string) =>
    new Set(selections).size === selections.length
      ? undefined
      : `${label} must not reference the same selection more than once.`;
  switch (physics.kind) {
    case 'steady-thermal':
    case 'transient-thermal': {
      const duplicate = duplicates(
        [
          ...physics.materials.map((item) => item.selection),
          ...physics.sources.map((item) => item.selection),
        ],
        'Material and source assignments',
      );
      if (duplicate) return duplicate;
      if (
        physics.kind === 'steady-thermal' &&
        !physics.boundaries.some((boundary) => boundary.kind === 'temperature')
      )
        return 'A steady thermal study needs at least one fixed-temperature boundary.';
      return undefined;
    }
    case 'static-structural': {
      const duplicate = duplicates(
        physics.materials.map((item) => item.selection),
        'Material assignments',
      );
      if (duplicate) return duplicate;
      return physics.boundaries.some((boundary) => boundary.kind === 'fixed-displacement')
        ? undefined
        : 'A static structural study needs at least one fixed-displacement boundary.';
    }
    case 'modal': {
      const duplicate = duplicates(
        physics.materials.map((item) => item.selection),
        'Material assignments',
      );
      if (duplicate) return duplicate;
      return physics.boundaries.some((boundary) => boundary.kind === 'fixed-displacement')
        ? undefined
        : 'A modal study needs at least one fixed-displacement boundary.';
    }
    case 'dc-conduction': {
      const potentials = physics.boundaries
        .filter((boundary) => boundary.kind === 'potential')
        .map((boundary) => boundary.potential.value);
      return new Set(potentials).size >= 2
        ? undefined
        : 'A DC conduction study needs at least two distinct prescribed potentials.';
    }
    case 'laminar-flow': {
      const pressures = physics.boundaries
        .filter((boundary) => boundary.kind === 'pressure')
        .map((boundary) => boundary.pressure.value);
      return new Set(pressures).size >= 2
        ? undefined
        : 'A laminar-flow study needs at least two distinct prescribed pressures.';
    }
  }
}

export function physicsByStudy(kind: StudyPhysics['kind']): PhysicsDefinition {
  const definition = PHYSICS.find((entry) => entry.studyKind === kind);
  requireThat(definition, 'invalid_input', `Unsupported study physics '${kind}'.`);
  return definition;
}

export function physicsByCase(physics: CaseConfig['physics']): PhysicsDefinition {
  const definition = PHYSICS.find((entry) => entry.casePhysics === physics);
  requireThat(definition, 'invalid_input', `Unsupported case physics '${physics}'.`);
  return definition;
}
