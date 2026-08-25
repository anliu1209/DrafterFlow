# DevDoc — 2D 同人图转 3D 多层打印周边生成器

Version: V1.0 MVP（细化版）

## 1. 项目概述

本项目是一个纯 Python 后端 / 本地 CLI 工具，面向 K-pop / 二次元同人圈。
用户提供一张带透明背景（Alpha 通道）的 PNG 图片，图片中的主体为深色线稿或深色实色区域。

程序自动：

1. 从 Alpha 通道提取整个主体的外部轮廓
2. 从 RGB 图像中提取深色区域
3. 将外部轮廓生成浅色底板
4. 将深色区域生成顶部深色图层
5. 自动添加挂绳孔
6. 输出单个可用于 3D 打印的 STL（底板 + 深色层合并为一个实体）
7. 后续再支持输出带有双色材质信息的 3MF

核心目标：

```
Transparent PNG → 2D masks → vector paths → two-layer 3D geometry → printable STL / 3MF
```

## 2. V1.0 严格限制范围

禁止在 V1.0 中加入以下功能：

- ❌ AI 图像生成
- ❌ AI image-to-3D
- ❌ Web UI
- ❌ 数据库
- ❌ 用户账户
- ❌ 社区功能
- ❌ 在线上传
- ❌ 自动线条膨胀
- ❌ 自动修复复杂断线
- ❌ 自动添加 3D 打印支撑
- ❌ 多材料 / 3 色以上
- ❌ 照片处理
- ❌ 渐变图像处理
- ❌ 任意复杂背景去除

V1.0 只处理：透明背景 + 简单封闭外轮廓 + 深色 artwork。

如果图片没有透明背景，程序直接报错：

```
Input image must have a transparent background (alpha channel).
Please upload a PNG with transparency.
```

如果无法提取有效深色区域，同样友好报错（见 §8）。

## 3. V1.0 输入要求

推荐输入：

```
PNG
RGBA
transparent background
solid/dark artwork
```

例如：

```
Transparent
    ↓

      ♥
     TXT
```

允许：

- 黑色线稿
- 深蓝色
- 深紫色
- 深灰色
- 其他足够深的颜色

V1.0 使用简单阈值判断深色区域，因此不保证支持浅色 artwork。

## 4. 技术栈

- Python 3.10+
- 图像处理：**OpenCV（cv2）** —— 单库即可同时完成 Alpha 提取与灰度/深色判断，不再引入 Pillow（Pillow 可读 RGBA，但 cv2 同样可读，且后续 threshold/contour 都在 cv2 里，减少依赖与格式来回转换）。
- Vectorization：优先 **potrace**，或 Python `potracer`
- 3D modeling：**CadQuery**
- Export：第一阶段 STL，第二阶段 3MF

数据流：

```
PNG → RGBA → Alpha mask + Dark-pixel mask
Binary mask → SVG paths
SVG → 2D geometry → extrude → boolean → STL / 3MF
```

## 5. 项目结构

```
drafterflow/
│
├── main.py
├── image_processing.py
├── vectorize.py
├── model_builder.py
├── export.py
├── requirements.txt
├── README.md
│
├── examples/
│   ├── heart.png
│   └── txt.png
│
└── output/
```

## 6. Image Processing

文件：`image_processing.py`

核心函数：

```python
extract_masks(image_path) -> (base_mask, color_mask)
```

### 6.1 Base Mask（外部轮廓）

使用 cv2 读取 RGBA，取 Alpha 通道：

```
RGBA → Alpha
```

规则：

```
alpha > alpha_threshold → 1
alpha <= alpha_threshold → 0
```

默认：

```
alpha_threshold = 8
```

说明：不取 0，而取一个小 epsilon（8/255），避免半透明杂点被当成主体轮廓。

得到 Base Mask，表示整个主体的外部轮廓。例如：

```
     ███
   ███████
   ███████
     ███
```

### 6.2 Dark Artwork Mask（深色区域）

读取 RGB，计算 grayscale：

```python
gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
```

默认：

```
dark_threshold = 100
```

规则：

```
gray < 100 → 1
gray >= 100 → 0
```

同时，`alpha == 0` 的区域必须强制置 `0`，确保透明背景不会被误认为 dark artwork：

```python
color_mask = (gray < dark_threshold) & (alpha > alpha_threshold)
```

## 7. Mask Validation

在 vectorization 之前检查。

- Base Mask：必须存在非零像素，否则报错 `Could not detect a valid object from the alpha channel.`
- Color Mask：`dark_pixel_count == 0` 时报错 `Could not detect dark artwork. Please make sure your artwork contains sufficiently dark pixels.`

## 8. Vectorization

文件：`vectorize.py`

核心：`mask_to_svg(mask)`

流程：

```
Binary Mask → Potrace → SVG
```

要求：

- 输出真实 SVG path
- 支持 holes / nested contours
- 保持原始 aspect ratio
- 不进行自动 geometry inflation
- 不修改用户 artwork

## 9. SVG Scaling（像素 → 毫米）

**重要约定：单位换算只在一个地方发生。**

- `image_processing` 与 `vectorize` 全程使用 **像素坐标**（原点左上角、Y 向下）。
- `model_builder` 是唯一做像素 → 毫米换算的地方。
- 换算公式：

```
scale_mm_per_px = target_width_mm / max(width_px, height_px)
```

- 用户指定 `--width 50`（默认 50mm），则整个模型的最大宽度缩放到 50mm，同时保持 aspect ratio。

例如：原图 1000×1000 px，`--width 50` → `scale = 50 / 1000 = 0.05 mm/px`。

## 10. 3D Model Builder

文件：`model_builder.py`

核心函数：

```python
build_model(
    svg_base,
    svg_color,
    base_thickness,
    color_thickness,
    hole_diameter,
    hole_position
)
```

### 10.1 统一坐标系（细化）

所有实体共用同一个坐标系（居中于原点），便于 `--hole-x` / `--hole-y` 定位与后续 3MF 复用：

- 模型居中于原点：X ∈ [-w/2, w/2]，Y ∈ [-h/2, h/2]（mm）。
- Base：Z ∈ [0, base_thickness]。
- Color：Z ∈ [base_thickness, base_thickness + color_thickness]。
- 挂绳孔与 `--hole-x` / `--hole-y` 均以该原点为中心、单位为毫米。

## 11. Base Layer

默认：

```
base_thickness = 1.2 mm
```

Base 与 Color 先各自挤出为独立实体（`base_solid` / `color_solid`），最后统一 union 导出（见 §13）。

## 12. Color Layer

默认：

```
color_thickness = 0.6 mm
```

不取 0.2mm 的原因：0.2mm 几何上可生成，但对常规 FDM 打印过于接近常见 layer height，实际打印可靠性差。推荐范围 0.4–0.8mm；CLI 允许 `--color 0.2` 手动指定。

Color layer：`extrude(color_thickness)`，然后 `translate(Z = base_thickness)`，从 Z=1.2mm 开始生成顶层。

## 13. 两层 Geometry

内部仍然分别计算两个挤出体（`base_solid`、`color_solid`），但 V1 最终**合并为一个实体**导出：

```
final_solid = base_solid ∪ color_solid
```

- 底板：整个轮廓挤出 1.2mm（Z=0~1.2）
- 深色层：深色区域挤出 0.6mm，叠在底板之上（Z=1.2~1.8）
- 两者 union 后导出单个 STL

**双色怎么实现（不需要 3MF / 双材料）**：两个颜色天然处于不同高度：

- 0 ~ 1.2mm 只有底板，打印整个轮廓
- 1.2 ~ 1.8mm 只有深色层，打印深色图案区域

因此在切片软件里于 1.2mm 处设一次「换料」即可：以下打浅色、以上打深色。因为 1.2mm 以上喷头只会走到深色图案区域，其余地方没有材料可打。

内部仍保留 `base_solid` / `color_solid` 的区分（先各自挤出、再 union），未来做 3MF 双色或多色时可直接复用，不必返工。

## 14. Keychain Hole

模型自动生成挂绳孔。默认：

```
hole_diameter = 4 mm
```

使用 `Cylinder(diameter=4mm)` 做 boolean subtraction。挂绳孔为从 Z=0 到深色层顶面的通孔，从合并后的单个实体中减去。

### 14.1 默认孔位（细化）

默认不使用 bounding box 的几何中心——对心形会落在顶部凹口（notch）里，那里是透明的，孔会悬空。改为在 base_mask 上「找一个放得下整圆的、最高且最靠中间的点」。

具体算法（当 `--hole-x` / `--hole-y` 未给出时，全程在像素空间计算，最后统一转 mm）：

```
hole_radius       = hole_diameter / 2
hole_margin       = 3 mm   # 孔顶到主体顶边的距离
min_edge_distance = 2 mm   # 孔到外轮廓的最小料厚
clearance         = 1 mm   # 孔到深色区的安全距离

1. y_top = base_mask 最上方的实心行
2. 从 (x = 水平中心, y = y_top + hole_margin + hole_radius) 开始，
   按「越靠中心、越靠上」的顺序扫描候选圆心
3. 对每个候选：以它为圆心、半径 (hole_radius + min_edge_distance) 的圆
   全部落在 base 实心区内；且半径 (hole_radius + clearance) 的圆不与 color 区相交
4. 取第一个通过的候选，把像素坐标转成 mm 交给 CadQuery
5. 全部失败 → 报错（见 14.2）
```

```
        ○
     ┌─────┐
    /       \
   | artwork |
    \       /
     └─────┘
```

效果：对称图形孔落顶部中心；心形落其中一个凸起顶部（不落进凹口）；非对称图形取最近的可用位置。

### 14.2 Hole Validation（细化）

打孔前做三件事，全部通过才打孔：

1. **完全位于 base 内**：孔心到 base 外轮廓最近距离 ≥ `hole_radius + min_edge_distance`（默认 `min_edge_distance = 2 mm`）。
2. **不与深色 artwork 冲突**：孔心到 color mask 最近距离 ≥ `hole_radius + clearance`（默认 `clearance = 1 mm`），即孔不能打到深色区域。
3. **用户指定坐标同样校验**：`--hole-x` / `--hole-y` 给的毫米坐标也必须通过 1、2 两项检查。

任何一项不满足则报错：

```
Unable to place keychain hole safely.
Please specify another hole position.
```

V1 不要求自动寻找完美孔位，只在默认位失败时提示用户手动指定。

### 14.3 强度局限（已知）

底板只有 1.2mm，挂绳孔周围那圈料偏薄，经常拉扯会软。V1 先接受 1.2mm；后续可把底板默认加厚到 2mm，或给孔加一圈加强环（留到后续版本）。

## 15. STL Export

文件：`export.py`

第一阶段稳定输出**单个 `.stl`**：底板与深色层已合并为一个实体。

```
python main.py heart.png heart.stl
→ 生成 heart.stl（单个文件，含底板 + 凸起的深色层）
```

双色由切片软件在 1.2mm 层高处换料实现（见 §13），因此 STL 无需表达颜色信息。重点先验证 geometry correctness。

## 16. 3MF Export（延后）

V1 第一阶段**不做** 3MF：先用单个 STL + 切片软件「按层高换色」验证打印成功（见 §13）。

3MF 留到后续阶段，目标：

```
Base → White
Color → Dark
```

输出 `output.3mf`，用于 Bambu Studio 等支持 3MF 的 slicer。届时需单独处理 Base mesh / Color mesh / Material assignment / 3MF package，因此 3MF 导出作为独立模块；内部已保留 `base_solid` / `color_solid` 区分（§13），可直接复用。

## 17. CLI

主程序：`main.py`，使用 `argparse`。

基本命令：

```bash
python main.py input.png output.stl
```

带参数：

```bash
python main.py input.png output.stl \
    --width 50 \
    --base 1.2 \
    --color 0.6 \
    --hole 4 \
    --dark-threshold 100
```

参数（细化）：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--width` | 50 | 模型最大宽度（mm） |
| `--base` | 1.2 | 底板厚度（mm） |
| `--color` | 0.6 | 深色层厚度（mm） |
| `--hole` | 4 | 挂绳孔直径（mm） |
| `--hole-x` | 自动 | 孔心 X（mm，居中坐标系），覆盖默认 |
| `--hole-y` | 自动 | 孔心 Y（mm，居中坐标系），覆盖默认 |
| `--dark-threshold` | 100 | 深色判定灰度阈值（0–255） |
| `--alpha-threshold` | 8 | Alpha 判定阈值（0–255） |

## 18. Pipeline

```
input.png
    │
    ▼
Validate PNG
    │
    ▼
Extract RGBA
    │
    ├──────────────┐
    ▼              ▼
Alpha Mask     Dark Mask
    │              │
    ▼              ▼
Base SVG       Color SVG
    │              │
    └───────┬──────┘
            ▼
       CadQuery
            │
       ┌────┴────┐
       ▼         ▼
 Base Solid   Color Solid
       │         │
       └────┬────┘
            ▼
          Union
            │
            ▼
       Hole Cutting
            │
            ▼
     STL Export (single)
            │
            ▼
      Optional 3MF
```

## 19. Error Handling

程序不能因为用户上传奇怪图片直接 crash。至少处理：

- 非 PNG → `Error: Please upload a PNG image.`
- 没有 Alpha → `Error: The image must contain a transparent background.`
- Alpha 全透明 → `Error: No visible artwork detected.`
- 没有深色区域 → `Error: No dark artwork detected.`
- SVG conversion failure → `Error: Failed to vectorize the image.`
- CadQuery failure → `Error: Failed to construct the 3D model.`

## 20. Development Strategy

不要一次写完整系统，按顺序开发：

- **Milestone 1**：PNG → Alpha mask → Dark mask → 保存 PNG，验证图像处理正确。
- **Milestone 2**：Mask → Potrace → SVG，手动打开 SVG 检查。
- **Milestone 3**：SVG → CadQuery → Base + Color，生成简单 3D geometry。
- **Milestone 4**：加入 Keychain hole。
- **Milestone 5**：输出 STL，实际导入 Bambu Studio。
- **Milestone 6**：真实打印测试。这是 V1 关键验收标准：透明 PNG → 生成模型 → Bambu 成功切片 → P1S 成功打印。
- **Milestone 7**：再开发 3MF + Base/Color material 与 color 赋值。

## 21. V1.0 Acceptance Test

准备最简单测试图：透明背景 + 黑色心形。

运行：

```bash
python main.py heart.png heart.stl
```

程序应：

1. 正确识别透明背景
2. 正确识别 heart silhouette
3. 正确识别 dark artwork
4. 生成 base geometry
5. 生成 color geometry
6. 添加 keychain hole
7. 保持比例
8. 输出有效单个 STL（`heart.stl`，含底板 + 凸起的深色层）
9. STL 能被 Bambu Studio 打开
10. 模型可以正常 slice

十项全部通过即 V1.0 MVP 成功。

## 22. 关于依赖安装失败

如果 CadQuery 安装困难，不要立刻重写项目，可考虑 `trimesh` / `shapely` / `numpy` / `scipy` 构建 2D polygon → extrusion → boolean → STL 作为替代。

如果 potrace / potracer 安装困难，可暂时用 OpenCV contours 直接 `binary mask → contours → polygons → extrusion`，暂时绕开 Potrace。

第一选择仍是 Potrace（更适合把 bitmap mask 转成干净 SVG path）。

## 23. 明确不属于 V1 的未来功能

- V2：普通 sketch → AI cleanup → transparent artwork
- V3：User coloring
- V4：Interactive 3D preview
- V5：3+ colors
- V6：Automatic printability optimization

最终 V1 的一句话定义：

> A local Python CLI tool that converts a transparent PNG artwork into a single two-layer, physically printable keychain model by extruding its silhouette and dark artwork separately and merging them into one solid — colored later in the slicer by layer height.
