import { requireThat } from './errors.js';
import { assertGroupCoverage } from './validate.js';
import { dcConductionSchema, type DcConduction, type Mesh } from './schemas.js';

export function normalizeDcConduction(
  input: unknown,
  mesh: Pick<Mesh, 'groups' | 'connectedBodies' | 'boundaryBodies'>,
): DcConduction {
  const config = dcConductionSchema.parse(input);
  const volumes = mesh.groups.filter((group) => group.dimension === 3).map((group) => group.id);
  const surfaces = mesh.groups.filter((group) => group.dimension === 2).map((group) => group.id);
  assertGroupCoverage(
    config.materials.map((material) => material.group),
    volumes,
    'Electrical conductivity must be assigned exactly once to every volume group.',
  );
  assertGroupCoverage(
    config.boundaries.map((boundary) => boundary.group),
    surfaces,
    'Every surface group requires an explicit potential or insulated condition.',
  );
  requireThat(
    mesh.connectedBodies.every((component) => {
      const componentBoundaries = new Set(
        Object.entries(mesh.boundaryBodies)
          .filter(([, bodies]) => bodies.some((body) => component.includes(body)))
          .map(([group]) => Number(group)),
      );
      const potentials = config.boundaries
        .filter(
          (
            boundary,
          ): boundary is Extract<DcConduction['boundaries'][number], { kind: 'potential' }> =>
            boundary.kind === 'potential' && componentBoundaries.has(boundary.group),
        )
        .map((boundary) => boundary.potential.value);
      return potentials.length >= 2 && new Set(potentials).size >= 2;
    }),
    'invalid_physics',
    'Each disconnected conductive component requires at least two distinct prescribed potentials.',
  );
  return {
    ...config,
    materials: [...config.materials].sort((a, b) => a.group - b.group),
    boundaries: [...config.boundaries].sort((a, b) => a.group - b.group),
  };
}

export function generateDcConductionSif(config: DcConduction): string {
  const bodies = config.materials
    .map(
      (material, index) =>
        `Body ${index + 1}\n  Target Bodies(1) = Integer ${material.group}\n  Equation = 1\n  Material = ${index + 1}\nEnd`,
    )
    .join('\n\n');
  const materials = config.materials
    .map(
      (material, index) =>
        `Material ${index + 1}\n  Electric Conductivity = Real ${material.electricalConductivity.value}\nEnd`,
    )
    .join('\n\n');
  const boundaries = config.boundaries
    .filter((boundary) => boundary.kind === 'potential')
    .map(
      (boundary, index) =>
        `Boundary Condition ${index + 1}\n  Target Boundaries(1) = Integer ${boundary.group}\n  Potential = Real ${boundary.potential.value}\nEnd`,
    )
    .join('\n\n');
  return `Header
  CHECK KEYWORDS Warn
  Mesh DB "." "mesh"
  Include Path ""
  Results Directory ""
End

Simulation
  Max Output Level = 5
  Coordinate System = Cartesian 3D
  Simulation Type = Steady State
  Steady State Max Iterations = 1
  Output Intervals = 1
End

Equation 1
  Active Solvers(2) = 1 2
End

Solver 1
  Equation = "Static Current"
  Procedure = "StatCurrentSolve" "StatCurrentSolver"
  Variable = Potential
  Variable DOFs = 1
  Linear System Solver = Iterative
  Linear System Iterative Method = BiCGStab
  Linear System Preconditioning = ILU1
  Linear System Max Iterations = 2000
  Linear System Convergence Tolerance = 1.0e-10
  Linear System Abort Not Converged = True
  Nonlinear System Max Iterations = 1
End

Solver 2
  Exec Solver = After Simulation
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
