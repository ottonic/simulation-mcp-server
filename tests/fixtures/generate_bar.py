"""MIT-licensed, deterministic OCC STEP bar fixtures, generated on demand.

Requires the Gmsh Python API. The geometry is one axis-aligned solid with a declared millimetre
length unit, and all six faces are physically selected in tests; the inch variant is the *same
coordinates* under a declared inch unit, which is what its test is about.

Run through `just fixture`; nothing written here is committed. A stored STEP file cannot be
reviewed in a diff, and nothing would regenerate it.
"""

import re
from pathlib import Path

import gmsh

# The bar's longest dimension first. The two fixtures are separate specifications rather than one
# shape in two units: the millimetre bar is 100 x 10 x 10 mm, and the inch bar is 4 x 0.5 x 0.5
# inches (0.1016 m long, 1 in^3), which is what its test asserts.
BARS = {
    "MM": ((100.0, 10.0, 10.0), "100 x 10 x 10 mm"),
    "INCH": ((4.0, 0.5, 0.5), "4 x 0.5 x 0.5 in"),
}
MILLIMETRE_SI = "SI_UNIT(.MILLI.,.METRE.)"
MM_LENGTH_UNIT = f"LENGTH_UNIT() NAMED_UNIT(*) {MILLIMETRE_SI}"

# Gmsh's STEP writer omits unit metadata, so the millimetre file declares its coordinates' unit
# with an injected entity. The id sits above anything Gmsh numbers.
MILLIMETRE_INJECTION = f"#999990 = ( {MM_LENGTH_UNIT} );"

# The inch file instead rewrites the length unit Gmsh itself wrote, because a second *declared*
# unit alongside it is ambiguous: the reader then sees millimetres. The appended entities take
# ids above the file's own highest, and the complex record is ordered the way a real exporter
# writes it — the other order segfaults OCCT's reader.
DATA_END = re.compile(r"\nENDSEC;\nEND-ISO-10303-21;")


def highest_entity_id(text: str) -> int:
    """Return the highest `#id` in a STEP file.

    Args:
        text: the STEP file's text.

    Returns:
        The highest entity id, or 0 when the file has none.
    """
    return max((int(found) for found in re.findall(r"#(\d+)", text)), default=0)


def declare_length_unit(path: Path, unit: str) -> None:
    """Rewrite one written file's length unit without touching its coordinates.

    Args:
        path: the file just written by Gmsh.
        unit: `MM` to inject a millimetre declaration, `INCH` to rewrite Gmsh's own unit.
    """
    text = path.read_text()
    if unit == "MM":
        path.write_text(text.replace("DATA;", f"DATA;\n{MILLIMETRE_INJECTION}", 1))
        return

    highest = highest_entity_id(text)
    conversion, exponents, millimetres = highest + 1, highest + 2, highest + 3
    text = text.replace(
        MM_LENGTH_UNIT,
        f"CONVERSION_BASED_UNIT('INCH',#{conversion}) LENGTH_UNIT() NAMED_UNIT(#{exponents})",
    )
    appended = (
        f"#{conversion} = MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#{millimetres});\n"
        f"#{exponents} = DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);\n"
        f"#{millimetres} = ( {MM_LENGTH_UNIT} );\n"
    )
    match = DATA_END.search(text)
    if match is None:
        raise RuntimeError(f"could not find the data section's end in {path}")
    path.write_text(text[: match.start() + 1] + appended + text[match.start() + 1 :])


def write(path: Path, unit: str) -> None:
    """Write one bar and declare its length unit.

    Args:
        path: the file to write.
        unit: `MM` or `INCH`, selecting the bar's dimensions and its declared unit.
    """
    size, described = BARS[unit]
    gmsh.initialize()
    try:
        gmsh.model.add("analytic_conduction_bar")
        gmsh.model.occ.addBox(0, 0, 0, *size)
        gmsh.model.occ.synchronize()
        gmsh.write(str(path))
    finally:
        gmsh.finalize()
    declare_length_unit(path, unit)
    print(f"  {path.name}: {described}")


directory = Path(__file__).parent
write(directory / "bar.step", "MM")
write(directory / "bar-inch.step", "INCH")
print(f"wrote bar.step and bar-inch.step in {directory}")
