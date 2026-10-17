"""Simulation protocol v1: one JSON request file, one JSON response file.

Only this installed script is executed. STEP paths and outputs are supplied by
the server after immutable staging. No .geo, Python, SIF, or plugins are inputs.
"""

import json
import math
import re
import sys
from pathlib import Path

import gmsh


def require(condition, message):
    if not condition:
        raise ValueError(message)


def inspect(source):
    text = Path(source).read_text(encoding="ascii", errors="replace")
    require(text.lstrip().startswith("ISO-10303-21;"), "Expected STEP Part 21")
    definitions = re.findall(r"#[0-9]+\s*=\s*(.*?);", text, re.DOTALL)
    length_defs = [d for d in definitions if "LENGTH_UNIT" in d]
    units = set()
    for definition in length_defs:
        match = re.search(
            r"SI_UNIT\s*\(\s*(\$|\.MILLI\.|\.CENTI\.|\.MICRO\.)\s*,\s*\.METRE\.\s*\)",
            definition,
        )
        require(
            match is not None,
            "Unsupported/unknown STEP length unit; supply a STEP with explicit SI length units",
        )
        units.add(
            {"$": "m", ".MILLI.": "mm", ".CENTI.": "cm", ".MICRO.": "um"}[match[1]]
        )
    require(len(units) == 1, "STEP must declare one unambiguous SI length unit")
    unit = next(iter(units))
    gmsh.option.setString("Geometry.OCCTargetUnit", "M")
    gmsh.model.occ.importShapes(source, highestDimOnly=True, format="step")
    gmsh.model.occ.synchronize()
    require(len(gmsh.model.getEntities(3)) > 0, "No solids imported")
    entities = []
    for dim in (2, 3):
        for _, tag in gmsh.model.getEntities(dim):
            adjacent = (
                list(map(int, gmsh.model.getAdjacencies(dim, tag)[0]))
                if dim == 2
                else []
            )
            entities.append(
                {
                    "dimension": dim,
                    "tag": tag,
                    "label": gmsh.model.getEntityName(dim, tag),
                    "bounds": list(gmsh.model.getBoundingBox(dim, tag)),
                    "center": list(gmsh.model.occ.getCenterOfMass(dim, tag)),
                    "measure": gmsh.model.occ.getMass(dim, tag),
                    "measureUnits": "m2" if dim == 2 else "m3",
                    "adjacentVolumes": adjacent,
                }
            )
    return {
        "protocol": 1,
        "gmshVersion": gmsh.__version__,
        "sourceUnits": unit,
        "scaleToMeters": {"m": 1, "mm": 0.001, "cm": 0.01, "um": 0.000001}[unit],
        "idScheme": "gmsh-occ-import-v1",
        "frame": {
            "id": "step-world-si",
            "units": "m",
            "origin": [0, 0, 0],
            "axes": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
            "handedness": "right",
        },
        "entities": entities,
        "diagnostics": [
            "OCC target unit M; placement/world axes preserved. Entity tags are valid only for this revision and Gmsh version.",
            "Labels are hints, not engineering selections. No repair or fragmentation is performed.",
        ],
    }


def mesh(request, inventory):
    controls = request["controls"]
    require(
        controls["units"] == "m"
        and 0 < controls["minSize"] <= controls["maxSize"] <= 1000,
        "Invalid SI mesh controls",
    )
    groups = request["groups"]
    require(len(groups) > 0, "Explicit groups required")
    used, ids, names = set(), set(), set()
    available = {(e["dimension"], e["tag"]) for e in inventory["entities"]}
    for group in groups:
        dim, tag = group["dimension"], group["id"]
        require(
            dim in (2, 3) and type(tag) is int and 1 <= tag <= 999,
            "Invalid physical group",
        )
        require(
            tag not in ids and group["name"] not in names,
            "Group IDs/names must be unique",
        )
        require(
            re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,47}", group["name"]),
            "Unsafe group name",
        )
        ids.add(tag)
        names.add(group["name"])
        require(len(group["entities"]) > 0, "Empty physical group")
        require(
            dim != 3 or len(group["entities"]) == 1,
            "V1 requires one imported solid per volume group",
        )
        for entity in group["entities"]:
            key = (dim, entity)
            require(key in available and key not in used, "Unknown or repeated entity")
            used.add(key)
        gmsh.model.addPhysicalGroup(dim, group["entities"], tag)
        gmsh.model.setPhysicalName(dim, tag, group["name"])
    require(used == available, "Every solid and surface must be explicitly grouped")
    gmsh.option.setNumber("Mesh.MeshSizeMin", controls["minSize"])
    gmsh.option.setNumber("Mesh.MeshSizeMax", controls["maxSize"])
    gmsh.option.setNumber("Mesh.ElementOrder", 1)
    gmsh.option.setNumber("Mesh.MshFileVersion", 2.2)
    gmsh.option.setNumber("Mesh.Binary", 0)
    gmsh.option.setNumber("Mesh.SaveAll", 0)
    gmsh.option.setNumber("General.NumThreads", 1)
    gmsh.model.mesh.generate(3)
    types, tags, _ = gmsh.model.mesh.getElements(3)
    require(list(types) == [4], "Only linear tetrahedral volume meshes are supported")
    quality = list(gmsh.model.mesh.getElementQualities(tags[0], "minSICN"))
    require(
        quality and min(quality) > 0 and all(math.isfinite(q) for q in quality),
        "Invalid mesh quality",
    )
    mapped = []
    for group in groups:
        count = sum(
            sum(
                len(t)
                for t in gmsh.model.mesh.getElements(group["dimension"], entity)[1]
            )
            for entity in group["entities"]
        )
        require(count > 0, "Empty mesh group")
        mapped.append({**group, "elements": count})
    gmsh.write(request["output"])
    return {
        "protocol": 1,
        "inventory": inventory,
        "groups": mapped,
        "nodeCount": len(gmsh.model.mesh.getNodes()[0]),
        "elementCount": len(tags[0]),
        "minimumQuality": min(quality),
    }


def main():
    request = json.loads(Path(sys.argv[1]).read_text())
    require(
        request.get("protocol") == 1
        and request.get("operation") in ("inspect", "mesh"),
        "Unsupported worker protocol",
    )
    gmsh.initialize([])
    try:
        gmsh.option.setNumber("General.Terminal", 1)
        inventory = inspect(request["source"])
        if request["operation"] == "mesh":
            require(
                inventory == request["expectedInventory"],
                "Stale importer/topology inventory",
            )
            result = mesh(request, inventory)
        else:
            result = inventory
        Path(sys.argv[2]).write_text(json.dumps(result, allow_nan=False))
    finally:
        gmsh.finalize()


if __name__ == "__main__":
    main()
