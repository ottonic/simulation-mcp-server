import { requireThat } from './errors.js';
import type { Group, Inventory } from './schemas.js';

export const meshFiles = ['mesh.header', 'mesh.nodes', 'mesh.elements', 'mesh.boundary'] as const;
const rows = (text: string) =>
  text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/).map(Number));
export function validateGroups(groups: Group[], inventory: Inventory) {
  const seen = new Set<string>(),
    ids = new Set<number>(),
    names = new Set<string>();
  const all = new Set(inventory.entities.map((e) => `${e.dimension}:${e.tag}`));
  for (const group of groups) {
    requireThat(
      group.dimension !== 3 || group.entities.length === 1,
      'bad_groups',
      'V1 requires one imported solid per volume group so disconnected constraints remain explicit.',
    );
    requireThat(
      !ids.has(group.id) && !names.has(group.name),
      'bad_groups',
      'Group IDs and names must be unique across dimensions.',
    );
    ids.add(group.id);
    names.add(group.name);
    for (const entity of group.entities) {
      const key = `${group.dimension}:${entity}`;
      requireThat(
        all.has(key) && !seen.has(key),
        'bad_groups',
        'Unknown or multiply assigned entity.',
      );
      seen.add(key);
    }
  }
  requireThat(
    seen.size === all.size,
    'bad_groups',
    'Explicitly assign every imported volume and surface, including insulated surfaces.',
  );
}

// Compare connectivity AND group IDs against MSH2.2, independent of node/element
// renumbering by ElmerGrid. Coordinate keys avoid relying on label preservation.
export function validateConversion(
  msh: string,
  files: Record<(typeof meshFiles)[number], string>,
  groups: (Group & { elements: number })[],
) {
  const section = (name: string) => {
    const match = msh.match(new RegExp(`\\$${name}\\r?\\n([\\s\\S]*?)\\$End${name}`));
    requireThat(match, 'bad_mesh', `Missing MSH ${name}.`);
    const data = rows(match[1]!);
    requireThat(data[0]?.[0] === data.length - 1, 'bad_mesh', `Malformed MSH ${name} count.`);
    return data.slice(1);
  };
  requireThat(msh.includes('2.2 0 8'), 'bad_mesh', 'Expected ASCII MSH 2.2.');
  // The first column of every node row is the node id.
  const nodeMap = (data: number[][], from: number) =>
    new Map(data.map((r) => [r[0]!, r.slice(from)]));
  const sourceNodes = nodeMap(section('Nodes'), 1);
  const nativeNodes = nodeMap(rows(files['mesh.nodes']), 2);
  const coordinate = (xyz: number[] | undefined) => {
    requireThat(
      xyz?.length === 3 && xyz.every(Number.isFinite),
      'bad_mesh',
      'Invalid node coordinate.',
    );
    return xyz.map((n) => (n === 0 ? '0' : n.toPrecision(12))).join(',');
  };
  const signature = (group: number, nodes: number[], map: Map<number, number[]>) =>
    `${group}:${nodes
      .map((n) => coordinate(map.get(n)))
      .sort()
      .join(';')}`;
  const expected = new Map<string, number>();
  for (const row of section('Elements')) {
    const [, type, tags] = row;
    requireThat(
      type !== undefined &&
        tags !== undefined &&
        (type === 2 || type === 4) &&
        tags >= 2 &&
        row.length === 3 + tags + (type === 2 ? 3 : 4),
      'bad_mesh',
      'Unexpected MSH element.',
    );
    const key = signature(row[3]!, row.slice(3 + tags), sourceNodes);
    expected.set(key, (expected.get(key) ?? 0) + 1);
  }
  const volumes = rows(files['mesh.elements']);
  const boundaries = rows(files['mesh.boundary']);
  const header = rows(files['mesh.header'])[0];
  requireThat(
    header?.[0] === nativeNodes.size &&
      header[1] === volumes.length &&
      header[2] === boundaries.length &&
      nativeNodes.size === sourceNodes.size,
    'bad_mesh',
    'Native mesh header/count mismatch.',
  );
  const counts = new Map<number, number>();
  const bodyByElement = new Map<number, number>();
  const bodiesAtNode = new Map<number, Set<number>>();
  const consume = (row: number[], dimension: number) => {
    const offset = dimension === 3 ? 3 : 5;
    const [elementId, group] = row;
    const type = row[offset - 1];
    requireThat(
      elementId !== undefined &&
        group !== undefined &&
        row.every(Number.isFinite) &&
        type === (dimension === 3 ? 504 : 303) &&
        row.length === offset + (dimension === 3 ? 4 : 3),
      'bad_mesh',
      'Unexpected native element.',
    );
    requireThat(
      groups.some((g) => g.id === group && g.dimension === dimension),
      'bad_groups',
      'Native element has unknown physical group.',
    );
    const key = signature(group, row.slice(offset), nativeNodes);
    requireThat(
      (expected.get(key) ?? 0) > 0,
      'bad_groups',
      'ElmerGrid changed group membership/connectivity.',
    );
    expected.set(key, expected.get(key)! - 1);
    counts.set(group, (counts.get(group) ?? 0) + 1);
    if (dimension === 3) {
      requireThat(!bodyByElement.has(elementId), 'bad_mesh', 'Duplicate native element ID.');
      bodyByElement.set(elementId, group);
      for (const node of row.slice(offset)) {
        const bodies = bodiesAtNode.get(node) ?? new Set<number>();
        bodies.add(group);
        bodiesAtNode.set(node, bodies);
      }
    }
  };
  volumes.forEach((r) => consume(r, 3));
  boundaries.forEach((r) => consume(r, 2));
  requireThat(
    [...expected.values()].every((n) => n === 0),
    'bad_groups',
    'ElmerGrid lost elements.',
  );
  for (const group of groups)
    requireThat(
      counts.get(group.id) === group.elements,
      'bad_groups',
      'Converted group count mismatch.',
    );
  const boundaryBodies: Record<string, number[]> = {};
  for (const row of boundaries) {
    // V1 supports external thermal BCs only. Internal interfaces must be
    // conformal but cannot carry conflicting user-selected surface conditions.
    const [boundaryId, group, body] = row;
    // V1 supports external thermal BCs only. Internal interfaces must be
    // conformal but cannot carry conflicting user-selected surface conditions.
    requireThat(
      boundaryId !== undefined &&
        group !== undefined &&
        body !== undefined &&
        body > 0 &&
        row[3] === 0,
      'bad_mesh',
      'V1 requires exterior boundary groups; internal/orphan boundaries are unsupported.',
    );
    const bodyId = bodyByElement.get(body);
    requireThat(
      bodyId !== undefined,
      'bad_mesh',
      'V1 requires exterior boundary groups; internal/orphan boundaries are unsupported.',
    );
    boundaryBodies[group] = [...new Set([...(boundaryBodies[group] ?? []), bodyId])].sort(
      (a, b) => a - b,
    );
  }
  // Union-find over volume-group ids sharing a node (O(nodes·α)); the
  // representative is always the smallest id so grouping order is stable.
  const bodyIds = groups.filter((g) => g.dimension === 3).map((g) => g.id);
  const parent = new Map<number, number>(bodyIds.map((id) => [id, id]));
  const find = (start: number): number => {
    let root = start;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let current = start;
    while (parent.get(current) !== root) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    if (rootA < rootB) parent.set(rootB, rootA);
    else parent.set(rootA, rootB);
  };
  for (const shared of bodiesAtNode.values()) {
    const ids = [...shared];
    for (const id of ids.slice(1)) union(ids[0]!, id);
  }
  const grouped = new Map<number, number[]>();
  for (const id of bodyIds) {
    const root = find(id);
    const list = grouped.get(root);
    if (list) list.push(id);
    else grouped.set(root, [id]);
  }
  return {
    nodeCount: nativeNodes.size,
    elementCount: volumes.length,
    connectedBodies: [...grouped.values()].map((c) => [...c].sort((a, b) => a - b)),
    boundaryBodies,
  };
}
