"""STL export."""


def export_stl(mesh, path):
    if not path.lower().endswith(".stl"):
        path += ".stl"
    mesh.export(path)
    return path
