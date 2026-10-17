import { describe, expect, it } from 'vitest';
import {
  capabilities,
  helpDocument,
  HELP_URI,
  PHYSICS_CATALOG,
  WORKFLOW_URI,
} from '../src/catalog.js';
import { TOOL_REGISTRY } from '../src/tools.js';
import { OBSERVATION_QUANTITIES, physicsSchema } from '../src/schemas.js';
import { ERROR_CODES } from '../src/errors.js';

describe('discovery catalog alignment', () => {
  it('keeps capabilities, help, and the catalog on the same physics set', () => {
    const kinds = PHYSICS_CATALOG.map((entry) => entry.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(capabilities.physics.map((entry) => entry.kind)).toEqual(kinds);
    expect(helpDocument().physics.map((entry) => entry.kind)).toEqual(kinds);
  });

  it('lists only observation quantities the study schema accepts', () => {
    const accepted = new Set<string>(OBSERVATION_QUANTITIES);
    for (const entry of PHYSICS_CATALOG) {
      expect(entry.quantities.length).toBeGreaterThan(0);
      for (const quantity of entry.quantities)
        expect(accepted.has(quantity), `${entry.kind}:${quantity}`).toBe(true);
      // Help observations must describe exactly the advertised quantities.
      expect(entry.observations.map((observation) => observation.quantity)).toEqual(
        entry.quantities,
      );
      expect(entry.boundaries.map((boundary) => boundary.kind)).toEqual(entry.boundaryKinds);
    }
    expect(helpDocument().enums.observation_quantities).toEqual(OBSERVATION_QUANTITIES);
    expect(helpDocument().enums.error_codes).toEqual(ERROR_CODES);
  });

  it('parses every advertised physics example against the study schema', () => {
    for (const entry of PHYSICS_CATALOG) {
      expect(entry.examples.length, entry.kind).toBeGreaterThan(0);
      for (const example of entry.examples) {
        expect(example.kind, entry.kind).toBe(entry.kind);
        const parsed = physicsSchema.safeParse(example);
        expect(
          parsed.success,
          `${entry.kind}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
        ).toBe(true);
      }
    }
  });

  it('registers exactly the advertised workflow tools', () => {
    const names = TOOL_REGISTRY.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...capabilities.workflow, 'get_capabilities'].sort());
    for (const tool of TOOL_REGISTRY) {
      expect(tool.title.length, tool.name).toBeGreaterThan(0);
      expect(tool.description.length, tool.name).toBeGreaterThan(0);
      expect(tool.outputSchema, tool.name).toBeDefined();
    }
    expect(helpDocument().surface).toContain(`${TOOL_REGISTRY.length} workflow`);
  });

  it('exposes distinct resource URIs', () => {
    expect(HELP_URI).not.toBe(WORKFLOW_URI);
    expect(HELP_URI).toBe('simulation://help');
  });
});
