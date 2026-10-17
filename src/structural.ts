import { requireThat } from './errors.js';
import { assertGroupCoverage } from './validate.js';
import {
  modalSchema,
  staticStructuralSchema,
  type Mesh,
  type Modal,
  type StaticStructural,
} from './schemas.js';

export function normalizeStaticStructural(
  input: unknown,
  mesh: Pick<Mesh, 'groups' | 'connectedBodies' | 'boundaryBodies'>,
): StaticStructural {
  const config = staticStructuralSchema.parse(input);
  const volumes = mesh.groups.filter((g) => g.dimension === 3).map((g) => g.id);
  const surfaces = mesh.groups.filter((g) => g.dimension === 2).map((g) => g.id);
  const check = (ids: number[], allowed: number[]) =>
    new Set(ids).size === ids.length &&
    ids.every((id) => allowed.includes(id)) &&
    ids.length === allowed.length &&
    allowed.every((id) => ids.includes(id));
  requireThat(
    check(
      config.materials.map((m) => m.group),
      volumes,
    ),
    'invalid_physics',
    'Materials must uniquely cover every volume group.',
  );
  requireThat(
    check(
      config.boundaries.map((b) => b.group),
      surfaces,
    ),
    'invalid_physics',
    'Boundary conditions must uniquely cover every surface group; use free explicitly.',
  );
  const fixed = new Set(
    config.boundaries
      .filter((b) => b.kind === 'fixed-displacement')
      .flatMap((b) => mesh.boundaryBodies[b.group] ?? []),
  );
  requireThat(
    mesh.connectedBodies.every((component) => component.some((body) => fixed.has(body))),
    'invalid_physics',
    'Each disconnected body component requires a fixed-displacement boundary.',
  );
  return {
    ...config,
    materials: [...config.materials].sort((a, b) => a.group - b.group),
    boundaries: [...config.boundaries].sort((a, b) => a.group - b.group),
  };
}

// Only validated numeric data is interpolated; callers cannot supply SIF fragments.
export function generateStaticStructuralSif(config: StaticStructural): string {
  const bodies = config.materials
    .map(
      (m, i) =>
        `Body ${i + 1}\n  Target Bodies(1) = Integer ${m.group}\n  Equation = 1\n  Material = ${i + 1}\nEnd`,
    )
    .join('\n\n');
  const materials = config.materials
    .map(
      (m, i) =>
        `Material ${i + 1}\n  Youngs Modulus = Real ${m.youngsModulus.value}\n  Poisson Ratio = Real ${m.poissonRatio}\nEnd\n\n`,
    )
    .join('');
  const boundaries = config.boundaries
    .map((b, i) => {
      const rows =
        b.kind === 'fixed-displacement'
          ? '  Displacement 1 = Real 0\n  Displacement 2 = Real 0\n  Displacement 3 = Real 0'
          : b.kind === 'prescribed-displacement'
            ? b.displacement.map((v, j) => `  Displacement ${j + 1} = Real ${v.value}`).join('\n')
            : b.kind === 'uniform-traction'
              ? b.traction.map((v, j) => `  Force ${j + 1} = Real ${v.value}`).join('\n')
              : '';
      return `Boundary Condition ${i + 1}\n  Target Boundaries(1) = Integer ${b.group}\n${rows}${rows ? '\n' : ''}End\n\n`;
    })
    .join('');
  return `Header\n  CHECK KEYWORDS Warn\n  Mesh DB "." "mesh"\n  Include Path ""\n  Results Directory ""\nEnd\n\nSimulation\n  Max Output Level = 5\n  Coordinate System = Cartesian 3D\n  Simulation Type = Steady State\n  Steady State Max Iterations = 1\n  Output Intervals = 1\nEnd\n\nEquation 1\n  Active Solvers(2) = 1 2\n  Stress Analysis = True\nEnd\n\nSolver 1\n  Equation = Linear Elasticity\n  Procedure = "StressSolve" "StressSolver"\n  Variable = -dofs 3 Displacement\n  Variable DOFs = 3\n  Calculate Stresses = True\n  Linear System Solver = Iterative\n  Linear System Iterative Method = BiCGstab\n  Linear System Preconditioning = ILU1\n  Linear System Max Iterations = 2000\n  Linear System Convergence Tolerance = 1.0e-10\n  Linear System Abort Not Converged = True\n  Nonlinear System Max Iterations = 1\nEnd\n\nSolver 2\n  Exec Solver = After Simulation\n  Equation = ResultOutput\n  Procedure = "ResultOutputSolve" "ResultOutputSolver"\n  Output File Name = "result"\n  Vtu Format = Logical True\n  Binary Output = Logical False\n  Save Geometry Ids = Logical True\nEnd\n\n${bodies}\n\n${materials}\n\n${boundaries}`;
}

export function normalizeModal(
  input: unknown,
  mesh: Pick<Mesh, 'groups' | 'connectedBodies' | 'boundaryBodies'>,
): Modal {
  const config = modalSchema.parse(input);
  const volumes = mesh.groups.filter((group) => group.dimension === 3).map((group) => group.id);
  const surfaces = mesh.groups.filter((group) => group.dimension === 2).map((group) => group.id);
  assertGroupCoverage(
    config.materials.map((item) => item.group),
    volumes,
    'Modal materials must uniquely cover every volume group.',
  );
  assertGroupCoverage(
    config.boundaries.map((item) => item.group),
    surfaces,
    'Modal boundary conditions must uniquely cover every surface group; use free explicitly.',
  );
  const fixed = new Set(
    config.boundaries
      .filter((boundary) => boundary.kind === 'fixed-displacement')
      .flatMap((boundary) => mesh.boundaryBodies[boundary.group] ?? []),
  );
  requireThat(
    mesh.connectedBodies.every((component) => component.some((body) => fixed.has(body))),
    'invalid_physics',
    'Each disconnected body component requires a fixed-displacement boundary for modal analysis.',
  );
  return {
    ...config,
    materials: [...config.materials].sort((a, b) => a.group - b.group),
    boundaries: [...config.boundaries].sort((a, b) => a.group - b.group),
  };
}

export function generateModalSif(config: Modal): string {
  const bodies = config.materials
    .map(
      (material, index) =>
        `Body ${index + 1}\n  Target Bodies(1) = Integer ${material.group}\n  Equation = 1\n  Material = ${index + 1}\nEnd`,
    )
    .join('\n\n');
  const materials = config.materials
    .map(
      (material, index) =>
        `Material ${index + 1}\n  Youngs Modulus = Real ${material.youngsModulus.value}\n  Poisson Ratio = Real ${material.poissonRatio}\n  Density = Real ${material.density.value}\nEnd`,
    )
    .join('\n\n');
  const boundaries = config.boundaries
    .map(
      (boundary, index) =>
        `Boundary Condition ${index + 1}\n  Target Boundaries(1) = Integer ${boundary.group}\n${boundary.kind === 'fixed-displacement' ? '  Displacement 1 = Real 0\n  Displacement 2 = Real 0\n  Displacement 3 = Real 0\n' : ''}End`,
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
  Equation = "Linear Elasticity"
  Procedure = "ElasticSolve" "ElasticSolver"
  Large Deflection = Logical False
  Variable = Displacement
  Variable DOFs = 3
  Eigen Analysis = Logical True
  Eigen System Values = Integer ${config.modes}
  Eigen System Select = String "Smallest Magnitude"
  Eigen System Convergence Tolerance = Real 1.0e-8
  Linear System Solver = String "Iterative"
  Linear System Iterative Method = String "BiCGstab"
  Linear System Preconditioning = String "ILU1"
  Linear System Max Iterations = Integer 2000
  Linear System Convergence Tolerance = Real 1.0e-10
  Nonlinear System Max Iterations = Integer 1
End

Solver 2
  Equation = "SaveScalars"
  Procedure = "SaveData" "SaveScalars"
  Exec Solver = After Simulation
  Filename = "scalars.dat"
  Save EigenValues = Logical True
  Show Norm Index = Integer 1
End

${bodies}

${materials}

${boundaries}
`;
}
