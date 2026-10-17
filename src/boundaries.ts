import { requireThat } from './errors.js';

export type PrescribedBoundaryValues = {
  group: number;
  dofs: Record<string, number>;
};

export function validatePrescribedBoundaryNodes(
  boundaryFile: string,
  conditions: PrescribedBoundaryValues[],
) {
  const byGroup = new Map(conditions.map((condition) => [condition.group, condition.dofs]));
  const byNode = new Map<number, Map<string, number>>();
  for (const line of boundaryFile.trim().split(/\r?\n/).filter(Boolean)) {
    const row = line.trim().split(/\s+/).map(Number);
    requireThat(
      row.length >= 8 && row.every(Number.isFinite),
      'bad_mesh',
      'Malformed native boundary element while checking prescribed conditions.',
    );
    const dofs = byGroup.get(row[1]!);
    if (!dofs) continue;
    for (const node of row.slice(5)) {
      const prescribed = byNode.get(node) ?? new Map<string, number>();
      for (const [dof, value] of Object.entries(dofs)) {
        const previous = prescribed.get(dof);
        requireThat(
          previous === undefined || previous === value,
          'invalid_physics',
          `Conflicting prescribed values for ${dof} at shared mesh node ${node}.`,
        );
        prescribed.set(dof, value);
      }
      byNode.set(node, prescribed);
    }
  }
}
