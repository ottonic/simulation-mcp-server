import { requireThat } from './errors.js';
import { assertGroupCoverage } from './validate.js';
import { laminarFlowConfigSchema, type LaminarFlowConfig, type Mesh } from './schemas.js';

export function normalizeLaminarFlow(
  input: unknown,
  mesh: Pick<Mesh, 'groups' | 'connectedBodies' | 'boundaryBodies'>,
): LaminarFlowConfig {
  const config = laminarFlowConfigSchema.parse(input);
  const volumes = mesh.groups.filter((group) => group.dimension === 3).map((group) => group.id);
  const surfaces = mesh.groups.filter((group) => group.dimension === 2).map((group) => group.id);
  assertGroupCoverage(
    config.materials.map((material) => material.group),
    volumes,
    'Assign density and dynamic viscosity exactly once to every fluid volume.',
  );
  assertGroupCoverage(
    config.boundaries.map((boundary) => boundary.group),
    surfaces,
    'Every fluid surface needs an explicit prescribed pressure or no-slip wall.',
  );
  requireThat(
    mesh.connectedBodies.every((component) => {
      const componentSurfaces = new Set(
        Object.entries(mesh.boundaryBodies)
          .filter(([, bodies]) => bodies.some((body) => component.includes(body)))
          .map(([group]) => Number(group)),
      );
      const pressureValues = config.boundaries
        .filter(
          (
            boundary,
          ): boundary is Extract<LaminarFlowConfig['boundaries'][number], { kind: 'pressure' }> =>
            boundary.kind === 'pressure' && componentSurfaces.has(boundary.group),
        )
        .map((boundary) => boundary.pressure.value);
      return pressureValues.length >= 2 && new Set(pressureValues).size >= 2;
    }),
    'invalid_physics',
    'Each disconnected fluid volume requires at least two distinct prescribed pressures.',
  );
  if (config.regime.mode === 'transient')
    requireThat(
      config.regime.initialVelocity.every((value) => value.value === 0),
      'unsupported_condition',
      'The validated transient-flow model currently requires explicit quiescent initial velocity [0, 0, 0] m/s.',
    );
  return {
    ...config,
    materials: [...config.materials].sort((a, b) => a.group - b.group),
    boundaries: [...config.boundaries].sort((a, b) => a.group - b.group),
  };
}

// Solver choice: Elmer's monolithic `FlowSolve` module with streamline-upwind
// stabilization (`Stabilize`, `GradP Discretization`) and a coupled
// velocity/pressure block. This is the module exercised by the pinned upstream
// transient Navier-Stokes regression and is qualified here against the analytic
// square-duct solution for both steady and transient startup flow, including
// flux conservation and mesh/timestep refinement (see
// tests/flow-qualification.test.ts). Elmer also ships the segregated
// `IncompressibleNS` module, but a straightforward configuration with the same
// pressure/no-slip boundaries did not reproduce the analytic solution (about 88%
// relative L2 velocity error and non-conservative flux) and is not qualified;
// switching formulations would require its own benchmark before it could back a
// release claim.
//
// Transient runs use first-order BDF deliberately: it is unconditionally stable
// for this diffusion-dominated regime and the timestep-sensitivity study shows
// the temporal contribution is small relative to the spatial error. Higher-order
// time integration is a deliberate ceiling, not an oversight.
export function generateLaminarFlowSif(config: LaminarFlowConfig): string {
  const regimeConfig = config.regime;
  const transient = regimeConfig.mode === 'transient';
  const bodies = config.materials
    .map(
      (material, index) =>
        `Body ${index + 1}\n  Target Bodies(1) = Integer ${material.group}\n  Equation = 1\n  Material = ${index + 1}${transient ? '\n  Initial Condition = 1' : ''}\nEnd`,
    )
    .join('\n\n');
  const materials = config.materials
    .map(
      (material, index) =>
        `Material ${index + 1}\n  Density = Real ${material.density.value}\n  Viscosity = Real ${material.dynamicViscosity.value}\nEnd`,
    )
    .join('\n\n');
  const boundaries = config.boundaries
    .map((boundary, index) =>
      boundary.kind === 'pressure'
        ? `Boundary Condition ${index + 1}\n  Target Boundaries(1) = Integer ${boundary.group}\n  Pressure = Real ${boundary.pressure.value}\nEnd`
        : `Boundary Condition ${index + 1}\n  Target Boundaries(1) = Integer ${boundary.group}\n  Velocity 1 = Real 0\n  Velocity 2 = Real 0\n  Velocity 3 = Real 0\nEnd`,
    )
    .join('\n\n');
  const regime =
    regimeConfig.mode === 'transient'
      ? `Simulation Type = Transient
  Timestepping Method = BDF
  BDF Order = 1
  Timestep Sizes = Real ${regimeConfig.time.timestep.value}
  Timestep Intervals = ${regimeConfig.time.steps}`
      : `Simulation Type = Steady State
  Steady State Max Iterations = 1`;
  const initial = transient
    ? `Initial Condition 1
  Velocity 1 = Real ${regimeConfig.mode === 'transient' ? regimeConfig.initialVelocity[0].value : 0}
  Velocity 2 = Real ${regimeConfig.mode === 'transient' ? regimeConfig.initialVelocity[1].value : 0}
  Velocity 3 = Real ${regimeConfig.mode === 'transient' ? regimeConfig.initialVelocity[2].value : 0}
  Pressure = Real 0
End

`
    : '';
  return `Header
  CHECK KEYWORDS Warn
  Mesh DB "." "mesh"
  Include Path ""
  Results Directory ""
End

Simulation
  Max Output Level = 5
  Coordinate System = Cartesian 3D
  ${regime}
  Output Intervals = 1
End

${initial}Equation 1
  Active Solvers(2) = 1 2
End

Solver 1
  Equation = "Navier-Stokes"
  Procedure = "FlowSolve" "FlowSolver"
  Variable = Flow Solution[Velocity:3 Pressure:1]
  Flow Model = String "Full"
  Stabilize = Logical True
  GradP Discretization = Logical True
  Linear System Solver = Iterative
  Linear System Iterative Method = BiCGStab
  Linear System Preconditioning = ILU1
  Linear System Max Iterations = Integer 2000
  Linear System Convergence Tolerance = Real 1.0e-10
  Linear System Abort Not Converged = Logical True
  Nonlinear System Max Iterations = Integer 30
  Nonlinear System Convergence Tolerance = Real 1.0e-7
  Nonlinear System Newton After Iterations = Integer 5
  Nonlinear System Newton After Tolerance = Real 1.0e-3
  Nonlinear System Relaxation Factor = Real 1.0
  Steady State Convergence Tolerance = Real 1.0e-7
End

Solver 2
  Exec Solver = ${transient ? 'After Timestep' : 'After Simulation'}
  Equation = "ResultOutput"
  Procedure = "ResultOutputSolve" "ResultOutputSolver"
  Output File Name = "result"
  Vtu Format = Logical True
  Binary Output = Logical False
  Save Geometry Ids = Logical True
End

${bodies}

${materials}

${boundaries}
`;
}
