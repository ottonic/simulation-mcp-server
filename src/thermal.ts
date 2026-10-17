import { thermalSchema, type Mesh, type Thermal } from './schemas.js';
import { requireThat } from './errors.js';
import { assertGroupCoverage, assertGroupSubset } from './validate.js';

export function normalizeThermal(
  input: unknown,
  mesh: Pick<Mesh, 'groups' | 'connectedBodies' | 'boundaryBodies'>,
): Thermal {
  const config = thermalSchema.parse(input);
  const volumes = mesh.groups.filter((g) => g.dimension === 3).map((g) => g.id);
  const surfaces = mesh.groups.filter((g) => g.dimension === 2).map((g) => g.id);
  assertGroupCoverage(
    config.materials.map((m) => m.group),
    volumes,
    'Assign exactly one material to every volume group.',
  );
  assertGroupSubset(
    config.sources.map((m) => m.group),
    volumes,
    'Heat sources must reference known volume groups.',
  );
  assertGroupCoverage(
    config.boundaries.map((m) => m.group),
    surfaces,
    'Assign exactly one condition to every surface group.',
  );
  if (config.physics === 'steady-heat-conduction') {
    const constrained = new Set(
      config.boundaries
        .filter((b) => b.kind === 'temperature')
        .flatMap((b) => mesh.boundaryBodies[b.group] ?? []),
    );
    requireThat(
      mesh.connectedBodies.every((component) => component.some((body) => constrained.has(body))),
      'invalid_physics',
      'Each disconnected body component needs at least one fixed-temperature boundary.',
    );
  }
  return {
    ...config,
    materials: config.materials.sort((a, b) => a.group - b.group),
    sources: config.sources.sort((a, b) => a.group - b.group),
    boundaries: config.boundaries.sort((a, b) => a.group - b.group),
  } as Thermal;
}

// All interpolated values are finite validated numbers. Names, expressions,
// procedure strings, output paths and executable names are never caller inputs.
export function generateSif(config: Thermal): string {
  const transient = config.physics === 'transient-heat-conduction';
  const parts = [
    `Header
  CHECK KEYWORDS Warn
  Mesh DB "." "mesh"
  Include Path ""
  Results Directory ""
End

Simulation
  Max Output Level = 5
  Coordinate System = Cartesian 3D
  Simulation Type = ${transient ? 'Transient' : 'Steady State'}
${transient ? `  Timestep Sizes = ${config.time.timestep.value}\n  Timestep Intervals = ${config.time.steps}\n  Timestepping Method = BDF\n  BDF Order = 1\n  Output Intervals = 1` : '  Steady State Max Iterations = 1\n  Output Intervals = 1'}
End

Equation 1
  Active Solvers(4) = 1 2 3 4
End

Solver 1
  Equation = Heat Equation
  Procedure = "HeatSolve" "HeatSolver"
  Variable = Temperature
  Variable Dofs = 1
  Linear System Solver = Iterative
  Linear System Iterative Method = CG
  Linear System Preconditioning = ILU0
  Linear System Max Iterations = 2000
  Linear System Convergence Tolerance = 1.0e-10
  Linear System Abort Not Converged = True
  Nonlinear System Max Iterations = 3
  Nonlinear System Convergence Tolerance = 1.0e-9
${transient ? '  Nonlinear System Abort Not Converged = False' : '  Steady State Convergence Tolerance = 1.0e-9'}
End

Solver 2
  Equation = ComputeFlux
  Procedure = "FluxSolver" "FluxSolver"
  Target Variable = String Temperature
  Flux Coefficient = String "Heat Conductivity"
  Calculate Flux = Logical True
  Calculate Flux Magnitude = Logical True
  Linear System Solver = Iterative
  Linear System Iterative Method = CG
  Linear System Preconditioning = ILU0
  Linear System Max Iterations = 2000
  Linear System Convergence Tolerance = 1.0e-10
  Linear System Abort Not Converged = True
End

Solver 3
  Exec Solver = ${transient ? 'After Timestep' : 'After Simulation'}
  Equation = SaveScalars
  Procedure = "SaveData" "SaveScalars"
  Filename = "scalars.dat"
  Variable 1 = String Temperature
  Operator 1 = String min
  Variable 2 = String Temperature
  Operator 2 = String max
  Variable 3 = String Temperature
  Operator 3 = String mean
  Variable 4 = String "Temperature Flux_mag"
  Operator 4 = String mean
  Variable 5 = String Temperature
  Operator 5 = String "nonlin converged"
End

Solver 4
  Exec Solver = ${transient ? 'After Timestep' : 'After Simulation'}
  Equation = ResultOutput
  Procedure = "ResultOutputSolve" "ResultOutputSolver"
  Output File Name = "result"
  Vtu Format = Logical True
  Binary Output = Logical False
  Save Geometry Ids = Logical True
End`,
  ];
  config.materials.forEach((material, i) => {
    const source = config.sources.find((s) => s.group === material.group);
    parts.push(
      `Body ${i + 1}\n  Target Bodies(1) = ${material.group}\n  Equation = 1\n  Material = ${i + 1}${source ? `\n  Body Force = ${i + 1}` : ''}${transient ? '\n  Initial Condition = 1' : ''}\nEnd`,
    );
    const transientMaterial = transient
      ? (material as Extract<
          Thermal,
          { physics: 'transient-heat-conduction' }
        >['materials'][number])
      : undefined;
    parts.push(
      `Material ${i + 1}\n  Heat Conductivity = ${material.conductivity.value}${transientMaterial ? `\n  Density = ${transientMaterial.density.value}\n  Heat Capacity = ${transientMaterial.heatCapacity.value}` : ''}\nEnd`,
    );
    if (source)
      parts.push(`Body Force ${i + 1}\n  Volumetric Heat Source = ${source.heat.value}\nEnd`);
  });
  config.boundaries.forEach((boundary, i) => {
    const condition =
      boundary.kind === 'temperature'
        ? `Temperature = ${boundary.temperature.value}`
        : `Heat Flux = ${boundary.kind === 'flux' ? boundary.inwardFlux.value : 0}`;
    parts.push(
      `Boundary Condition ${i + 1}\n  Target Boundaries(1) = ${boundary.group}\n  ${condition}\nEnd`,
    );
  });
  if (transient)
    parts.push(`Initial Condition 1\n  Temperature = ${config.initialTemperature.value}\nEnd`);
  return parts.join('\n\n') + '\n';
}
