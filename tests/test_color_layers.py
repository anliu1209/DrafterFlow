"""Regression coverage for Color Layer Mode's image -> stepped STL pipeline.

Run with:
    .venv/bin/python -m unittest tests.test_color_layers
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np
import trimesh
from shapely.geometry import Polygon, Point

from color_layers import analyze_color_image, color_regions, resolve_color_layers, ColorLayerError
from export import export_stl
from model_builder import build_color_layer_model
from vectorize import base_polygons, color_polygons


class ColorLayerPipelineTests(unittest.TestCase):
    def test_custom_layer_thicknesses_and_independent_tab_height(self):
        analysis = analyze_color_image(str(self.write_png('custom-heights.png', self.make_rectangles())), palette_size=4)
        masks = [entry.mask for entry in analysis.palette]
        def build(thicknesses, hole=None):
            return build_color_layer_model(base_polygons(np.logical_or.reduce(masks).astype(np.uint8)), [color_polygons(mask) for mask in masks], analysis.width_px, analysis.height_px, width_mm=80, base_thickness=.4, height_increment=.2, layer_thicknesses=thicknesses, base_hole=hole)
        mesh, heights = build([.2, .6, .1, .3])
        np.testing.assert_allclose(heights, [.6, 1.2, 1.3, 1.6])
        self.assertTrue(mesh.is_volume)
        self.assertAlmostEqual(mesh.bounds[1, 2], 1.6, places=5)
        for mask, top in zip(masks, heights):
            ys, xs = np.where(mask)
            x = (xs.mean() - analysis.width_px / 2) * 80 / analysis.width_px
            y = (analysis.height_px / 2 - ys.mean()) * 80 / analysis.width_px
            horizontal = np.all(np.abs(mesh.triangles[:, :, 2] - top) < 1e-5, axis=1)
            triangles = mesh.triangles[horizontal, :, :2]
            a, b, c = triangles[:, 0], triangles[:, 1], triangles[:, 2]
            p = np.array([x, y])
            cross = lambda u, v: u[:, 0] * v[:, 1] - u[:, 1] * v[:, 0]
            signs = np.array([cross(b-a, p-a), cross(c-b, p-b), cross(a-c, p-c)])
            self.assertTrue(np.any(np.all(signs >= -1e-6, axis=0) | np.all(signs <= 1e-6, axis=0)))
        for tab_height in [.2, .95, 3]:
            tab, same_heights = build([.2, .6, .1, .3], {'x': 0, 'y': 22.5, 'diameter': 4, 'height': tab_height})
            self.assertTrue(tab.is_volume)
            np.testing.assert_allclose(same_heights, heights)
            self.assertAlmostEqual(tab.bounds[1, 2], max(1.6, tab_height), places=5)
        for invalid in [[.2], [.2, 0, .2, .2], [.2, float('nan'), .2, .2]]:
            with self.assertRaises(Exception):
                build(invalid)

    def test_base_only_hole_does_not_cut_colour_slabs(self):
        analysis = analyze_color_image(str(self.write_png('hole.png', self.make_rectangles())), palette_size=4)
        masks = [entry.mask for entry in analysis.palette]
        def build(hole):
            return build_color_layer_model(base_polygons(np.logical_or.reduce(masks).astype(np.uint8)), [color_polygons(mask) for mask in masks], analysis.width_px, analysis.height_px, width_mm=80, base_thickness=.4, height_increment=.2, base_hole=hole)[0]
        mesh = build({'x':0,'y':0,'diameter':4})
        self.assertTrue(mesh.is_volume)
        def filled_at(z, x=0, y=0):
            section = mesh.section(plane_origin=[0,0,z],plane_normal=[0,0,1])
            crossings = 0
            for entity in section.entities:
                vertices = section.vertices[entity.points]
                for a, b in zip(vertices[:-1], vertices[1:]):
                    if (a[1] > y) != (b[1] > y) and a[0] + (y-a[1])*(b[0]-a[0])/(b[1]-a[1]) > x:
                        crossings += 1
            return crossings % 2 == 1
        self.assertFalse(filled_at(.2))
        self.assertTrue(filled_at(.5))  # colour above the backing stays intact
        tab = build({'x':0,'y':22.5,'diameter':4})
        self.assertTrue(tab.is_volume)
        self.assertGreater(tab.bounds[1,1], 25)
        thick = build({'x':0,'y':22.5,'diameter':4,'height':3})
        self.assertTrue(thick.is_volume)
        self.assertAlmostEqual(thick.bounds[1,2], 3, places=5)
        mesh = thick
        self.assertFalse(filled_at(2, 0, 22.5))  # through the entire thick tab
        self.assertTrue(filled_at(2, 3, 22.5))   # ring wall exists above base
        self.assertFalse(filled_at(2, 10, 0))   # artwork not raised to tab height
        self.assertTrue(filled_at(.5, 0, 0))    # original colour slabs preserved
        mesh = build({'x':0,'y':22.5,'diameter':4,'height':.2})
        self.assertTrue(mesh.is_volume)
        self.assertTrue(filled_at(.1, 3, 22.5))
        self.assertFalse(filled_at(.3, 3, 22.5))
        with self.assertRaises(Exception):
            build({'x':100,'y':100,'diameter':4})

    def test_dark_white_antialias_does_not_become_blue_relief(self):
        image = np.zeros((80, 120, 4), dtype=np.uint8)
        image[:, :, 3] = 255
        image[:, :40, :3] = (76, 65, 63)
        image[:, 40:80, :3] = (247, 238, 240)
        image[:, 80:, :3] = (228, 192, 182)
        image[:, 39:41, :3] = (177, 168, 167)  # mixed dark/white edge, not a blue fill
        image[20:23, 15:18, :3] = (247, 238, 240)  # preserve tiny white highlight
        result = analyze_color_image(str(self.write_png('antialias.png', image)), palette_size=3)
        blue = min(result.palette, key=lambda entry: np.linalg.norm(np.asarray(entry.rgb) - [182,192,228]))
        white = min(result.palette, key=lambda entry: np.linalg.norm(np.asarray(entry.rgb) - [240,238,247]))
        self.assertFalse(blue.mask[:, 38:42].any())
        self.assertTrue(blue.mask[:, 85:115].all())
        self.assertTrue(white.mask[20:23,15:18].all())
        self.assertTrue(np.logical_or.reduce([entry.mask for entry in result.palette]).all())

    def test_same_pigment_can_have_disjoint_height_groups(self):
        image = np.zeros((60, 100, 4), dtype=np.uint8)
        image[5:25, 5:35] = (255, 255, 255, 255)
        image[35:45, 65:75] = (255, 255, 255, 255)
        image[40:43, 30:33] = (255, 255, 255, 255)
        analysis = analyze_color_image(str(self.write_png('highlights.png', image)), palette_size=2)
        regions, _ = color_regions(analysis)
        color = analysis.palette[0]
        seed = min(regions, key=lambda r: r['pixel_count'])['seed']
        groups = [{'id': color.id, 'excluded_region_seeds': [seed]}, {'id': 'highlights', 'source_color_id': color.id, 'region_seeds': [seed]}]
        resolved = resolve_color_layers(analysis, groups)
        self.assertEqual(len(resolved), 2)
        self.assertFalse(np.any(resolved[0][1] & resolved[1][1]))
        self.assertEqual(int(np.logical_or(resolved[0][1], resolved[1][1]).sum()), color.pixel_count)
        # Adding a small region to an EXISTING highlights layer must preserve
        # its previous regions and remove exactly that region from the parent.
        extra = next(region['seed'] for region in regions if region['pixel_count'] == 100)
        groups[0]['excluded_region_seeds'].append(extra)
        groups[1]['region_seeds'].append(extra)
        moved = resolve_color_layers(analysis, groups)
        self.assertEqual(int(moved[1][1].sum()), 109)
        self.assertFalse(np.any(moved[0][1] & moved[1][1]))
        self.assertEqual(int(np.logical_or(moved[0][1], moved[1][1]).sum()), color.pixel_count)
        with self.assertRaises(ColorLayerError):
            resolve_color_layers(analysis, [{'id': color.id}, {'id': 'copy', 'source_color_id': color.id}])

    def test_reordered_layers_remain_closed(self):
        analysis = analyze_color_image(str(self.write_png('order.png', self.make_rectangles())), palette_size=4)
        for order in ([3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]):
            masks = [analysis.palette[i].mask for i in order]
            mesh, _ = build_color_layer_model(base_polygons(np.logical_or.reduce(masks).astype(np.uint8)), [color_polygons(mask) for mask in masks], analysis.width_px, analysis.height_px, width_mm=80, base_thickness=3, height_increment=1)
            self.assertTrue(mesh.is_volume)
            self.assertTrue(trimesh.load_mesh(__import__('io').BytesIO(mesh.export(file_type='stl')), file_type='stl').is_volume)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="df_color_test_")
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def write_png(self, name, image):
        path = self.root / name
        self.assertTrue(cv2.imwrite(str(path), image))
        return path

    @staticmethod
    def make_rectangles():
        image = np.zeros((80, 160, 4), dtype=np.uint8)
        image[:, :, 3] = 255
        # BGR, four large non-overlapping blocks.
        image[:, :40, :3] = (20, 50, 230)
        image[:, 40:80, :3] = (30, 180, 50)
        image[:, 80:120, :3] = (220, 80, 30)
        image[:, 120:, :3] = (20, 20, 20)
        return image

    def build(self, path, palette_size=4):
        analysis = analyze_color_image(str(path), palette_size=palette_size, width_mm=80)
        masks = [entry.mask for entry in analysis.palette]
        base_mask = np.logical_or.reduce(masks).astype(np.uint8)
        mesh, heights = build_color_layer_model(
            base_polygons(base_mask),
            [color_polygons(mask) for mask in masks],
            analysis.width_px,
            analysis.height_px,
            width_mm=80,
            base_thickness=0.4,
            height_increment=0.2,
        )
        return analysis, mesh, heights

    def test_four_coloured_rectangles_have_four_masks_and_a_solid_stl(self):
        analysis, mesh, heights = self.build(self.write_png("rectangles.png", self.make_rectangles()))
        self.assertEqual(len(analysis.palette), 4)
        self.assertEqual(sum(entry.pixel_count for entry in analysis.palette), 80 * 160)
        self.assertEqual([round(height, 5) for height in heights], [0.6, 0.8, 1.0, 1.2])
        self.assertTrue(mesh.is_volume)
        self.assertAlmostEqual(float(mesh.bounds[1, 2]), 1.2, places=5)
        out = export_stl(mesh, str(self.root / "rectangles"))
        restored = trimesh.load(out, force="mesh")
        self.assertTrue(restored.is_volume)

    def test_nested_shapes_reach_successively_higher_final_heights(self):
        image = np.zeros((160, 160, 4), dtype=np.uint8)
        # Explicit alpha preserves the transparent canvas when drawing into RGBA.
        cv2.circle(image, (80, 80), 70, (50, 100, 220, 255), thickness=-1)
        cv2.circle(image, (80, 80), 52, (230, 230, 230, 255), thickness=-1)
        cv2.circle(image, (80, 80), 34, (220, 100, 20, 255), thickness=-1)
        cv2.circle(image, (80, 80), 16, (20, 20, 20, 255), thickness=-1)
        _analysis, mesh, heights = self.build(self.write_png("nested.png", image))
        self.assertAlmostEqual(heights[-1], 1.2, places=5)
        self.assertTrue(mesh.is_volume)
        self.assertAlmostEqual(float(mesh.bounds[1, 2]), 1.2, places=5)

    def test_transparent_pixels_never_become_geometry(self):
        image = np.zeros((100, 120, 4), dtype=np.uint8)
        cv2.rectangle(image, (30, 20), (90, 80), (40, 90, 220, 255), thickness=-1)
        analysis, mesh, _heights = self.build(self.write_png("transparent.png", image), palette_size=2)
        self.assertEqual((analysis.width_px, analysis.height_px), (61, 61))
        self.assertIsNone(analysis.background_id)
        self.assertTrue(mesh.is_volume)

    def test_cleanup_drops_a_tiny_isolated_colour_region(self):
        image = np.zeros((100, 100, 4), dtype=np.uint8)
        image[:, :, 3] = 255
        image[:, :, :3] = (230, 230, 230)
        cv2.rectangle(image, (15, 15), (85, 85), (20, 20, 20), thickness=-1)
        image[5, 5, :3] = (20, 20, 20)  # intentional one-pixel isolated speck
        path = self.write_png("speck.png", image)
        raw = analyze_color_image(str(path), palette_size=2, cleanup_min_area_px=0)
        clean = analyze_color_image(str(path), palette_size=2, cleanup_min_area_px=4)
        raw_dark = min(entry.pixel_count for entry in raw.palette)
        clean_dark = min(entry.pixel_count for entry in clean.palette)
        self.assertGreater(raw_dark, clean_dark)

    def test_many_source_colours_are_quantized_to_requested_palette(self):
        image = np.zeros((40, 160, 4), dtype=np.uint8)
        image[:, :, 3] = 255
        for index in range(8):
            image[:, index * 20:(index + 1) * 20, :3] = (20 + index * 25, 180 - index * 15, 30 + index * 20)
        analysis = analyze_color_image(str(self.write_png("many-colours.png", image)), palette_size=4)
        self.assertEqual(len(analysis.palette), 4)
        self.assertGreater(analysis.source_color_count, 4)

    def test_five_flat_fills_keep_pale_skin_separate_from_white_and_ignore_gray_edges(self):
        # The user's artwork has two pale fills only 5 Lab units apart, plus
        # darker anti-aliasing. A variance-only palette merged the pale fills
        # and spent the fifth slot on a gray edge colour instead.
        colors = [(239, 238, 246), (64, 65, 76), (244, 237, 236), (181, 192, 227), (241, 199, 195)]
        image = np.zeros((100, 500, 3), dtype=np.uint8)
        for rgb, start, end in zip(colors, (0, 190, 340, 410, 475), (190, 340, 410, 475, 500)):
            image[:, start:end] = rgb[::-1]
        image[:, 210:213] = (132, 121, 120)  # an anti-aliased dark boundary
        analysis = analyze_color_image(str(self.write_png("subtle-five-colours.png", image)), palette_size=5)
        self.assertEqual(len(analysis.palette), 5)
        for rgb in colors:
            self.assertLess(min(np.linalg.norm(np.asarray(entry.rgb) - rgb) for entry in analysis.palette), 4)
        white = next(e for e in analysis.palette if e.mask[50, 50])
        skin = next(e for e in analysis.palette if e.mask[50, 370])
        self.assertNotEqual(white.id, skin.id)

    def test_invalid_traced_hole_is_repaired_before_colour_union(self):
        # Anti-aliased artwork can leave a vector trace with a hole just outside
        # its shell. Shapely rejects a raw union of it; the model builder should
        # repair the trace rather than failing an otherwise printable image.
        base = Polygon([(0, 0), (100, 0), (100, 100), (0, 100)])
        malformed = Polygon(
            [(15, 15), (85, 15), (85, 85), (15, 85)],
            holes=[[(110, 40), (115, 40), (115, 45), (110, 45)]],
        )
        self.assertFalse(malformed.is_valid)
        mesh, heights = build_color_layer_model(
            [base], [[malformed]], 100, 100,
            width_mm=50, base_thickness=0.4, height_increment=0.2,
        )
        self.assertTrue(mesh.is_volume)
        self.assertEqual([round(value, 3) for value in heights], [0.6])

    def test_background_removal_preserves_enclosed_same_colour_details(self):
        image = np.full((90, 110, 3), 255, dtype=np.uint8)
        cv2.rectangle(image, (20, 15), (90, 75), (20, 20, 20), -1)
        cv2.circle(image, (55, 45), 8, (255, 255, 255), -1)
        path = self.write_png("background.png", image)
        raw = analyze_color_image(str(path), palette_size=2)
        palette = [{"id": e.id, "lab": e.lab} for e in raw.palette]
        removed = analyze_color_image(str(path), palette=palette, remove_background=True)
        self.assertTrue(removed.background_removed)
        self.assertFalse(removed.visible_mask[0, 0])
        self.assertTrue(removed.visible_mask[45, 55])
        self.assertGreater(next(e.pixel_count for e in removed.palette if e.id == removed.background_id), 0)
        restored = analyze_color_image(str(path), palette=palette, remove_background=False)
        self.assertEqual(int(restored.visible_mask.sum()), image.shape[0] * image.shape[1])

    def test_antialiased_illustration_exports_a_closed_model_without_background(self):
        image = np.full((318, 284, 3), 255, dtype=np.uint8)
        cv2.ellipse(image, (142, 126), (109, 102), 0, 0, 360, (204, 225, 246), -1, cv2.LINE_AA)
        cv2.ellipse(image, (142, 256), (49, 43), 0, 0, 360, (204, 225, 246), -1, cv2.LINE_AA)
        for x in (102, 182):
            cv2.ellipse(image, (x, 152), (25, 22), 0, 0, 360, (35, 35, 35), -1, cv2.LINE_AA)
            cv2.ellipse(image, (x - 4, 146), (8, 4), 0, 0, 360, (255, 255, 255), -1, cv2.LINE_AA)
        analysis = analyze_color_image(str(self.write_png("illustration.png", image)), remove_background=True)
        masks = [entry.mask for entry in analysis.palette if entry.pixel_count]
        mesh, _heights = build_color_layer_model(
            base_polygons(np.logical_or.reduce(masks).astype(np.uint8)),
            [color_polygons(mask) for mask in masks], analysis.width_px, analysis.height_px,
            width_mm=80, base_thickness=3, height_increment=1,
        )
        restored = trimesh.load(export_stl(mesh, str(self.root / "illustration")), force="mesh")
        self.assertTrue(restored.is_volume)
        self.assertLess(restored.extents[0], 75)  # no full rectangular canvas


if __name__ == "__main__":
    unittest.main()
