import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist/contracts', { recursive: true });
await cp('contracts/artifact-ref.schema.json', 'dist/contracts/artifact-ref.schema.json');
await mkdir('dist/worker', { recursive: true });
await cp('worker/gmsh_worker.py', 'dist/worker/gmsh_worker.py');
