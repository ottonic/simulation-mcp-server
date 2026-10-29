default:
	just --list

# Dependency installation is explicit; npm scripts do not run solvers.
setup:
	npm install --ignore-scripts

dev:
	npm run dev

start:
	npm start

build:
	npm run build

test:
	npm test

# Native solver integration and qualification (requires Gmsh + Elmer). The fixtures are
# regenerated first: they are build products, not sources.
test-integration: fixture
	npm run test:integration

typecheck:
	npm run typecheck

lint:
	npm run lint

fmt:
	npm run fmt

fmt-check:
	npm run fmt:check

check: fmt-check lint typecheck test

fixture:
	python3 tests/fixtures/generate_bar.py

# Removing run evidence is deliberately not part of clean/build/setup.
clean:
	rm -rf dist
