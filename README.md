# DrafterFlow

透明背景 PNG → 多层 3D 打印钥匙扣 STL 生成器。

最初只是为了把我画的李羲承（Heeseung）Q版同人图做成一个真正的 3D 打印钥匙扣。手动在
Onshape 里描轮廓太耗时、难扩展，于是我把这个过程程序化了：从透明背景 2D 线稿自动提取轮廓
与图案区域 → 转成矢量几何 → 生成可直接 3D 打印的多层模型。

**Draw it → Upload it → Print it.**

从一张喜欢的同人图开始，逐渐变成对 computer vision、computational geometry、CAD 与
digital fabrication 的一次探索。

## 用法

```bash
python main.py examples/nametag.png output/nametag.stl
python main.py examples/heart.png output/heart.stl --width 50
```

自定义两层厚度：

```bash
# 底板 4mm + 浮雕 2mm = 总高 6mm
python main.py 你的图.png output/xxx.stl --base 4 --color 2
```

参数见 `python main.py --help`。

## 双色打印

生成**单个 STL**。切片时在「底板厚度」处换料（默认底板 4mm + 浮雕 2mm = 总高 6mm，用 `--base`/`--color` 改）：

- 0–`--base` mm 打浅色（底板）
- `--base`–(`--base`+`--color`) mm 打深色（凸起图案）

例如 `--base 4 --color 2`：0–4mm 底板，4–6mm 浮雕，在 4mm 处换料。

## 安装

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

## 生成测试图

```bash
.venv/bin/python examples/make_examples.py
```

## 网页界面

本地浏览器可视化前端：上传 PNG、分层预览、调节尺寸/阈值、3D 预览、下载 STL。

```bash
.venv/bin/python -m pip install -r requirements.txt   # 已包含 fastapi / uvicorn
.venv/bin/python server.py
```

然后浏览器打开 <http://127.0.0.1:8000> 。

前端是纯静态页（`static/`，Three.js 3D 预览）+ FastAPI 接口层（`server.py`）。
**Line Mode** 继续复用既有的 `image_processing → vectorize → model_builder` 管道；
**Color Layer Mode** 使用独立的 `color_layers → vectorize → model_builder` 分支，因此原有线稿行为不会被改写。
项目、账号和社区记录使用本地 SQLite（默认 `data/drafterflow.db`）；几何管道仍无需重写。

### 电脑端本地计算（Color Mode）

Color Mode 默认在浏览器的 module Web Worker 内完成分色、背景移除、四连通区域识别、
轮廓追踪、实体合并和二进制 STL 导出。几何引擎是随站点提供的 Manifold 3.5.4 WebAssembly，
首次生成下载约 529 KiB；无需安装桌面软件。后续调整顺序、拆层、尺寸、厚度或挂孔复用
Worker 中的分析结果和轮廓缓存，不重复上传/解码/分色。生成时界面仍可操作，过期结果不能导出。

- **Geometry → Advanced → Color processing**：默认 `On this computer`；手动选择 `Server`
  才会调用原来的 `/api/color/analyze` 和 `/api/color/generate`。本地失败不会自动上传。
- 新项目的 **Default layer height** 为 0.5 mm（每层新增厚度）；打开已有项目仍恢复其保存值。
  点击生成会立即显示阶段和耗时，每次成功都切换到 3D；失败信息也显示在预览区。
  本地任务超过 120 秒会终止并解锁按钮，可重新 Analyze Image 再试，不会一直无响应。
- 建议使用当前版本的电脑浏览器（需 Worker、OffscreenCanvas、createImageBitmap、WebAssembly）；
  本地图片上限 1600 万像素。手机或不支持的浏览器可自行选择服务器。
- 保留同色区域拆层、累积打印足迹、独立层高、仅穿底座的孔和独立挂耳高度。
  导出前验证 STL float32 顶点的闭合边、方向和正体积；不交付开放模型。
- 本地轮廓采用约 0.6 源像素容差的简化，非 Python Potrace 的逐顶点复制；
  服务器处理作为原有轮廓算法的备用。Line Art / Stroke extraction 暂仍使用原有服务器管线。
- “本地”指上述计算；账号、Community、Share、Publish 和已保存项目的自动保存仍使用服务器，
  保存或发布项目依然会上传原图和编辑状态。访客草稿只保存在浏览器。

回归测试：

```bash
node --test tests/test_local_compute.mjs tests/test_workspace.mjs tests/test_tags.mjs
.venv/bin/python -m unittest discover -s tests
```

## 账号、项目与 Community

核心创作一直是访客可用的：上传、分析、编辑、预览和下载 STL 都不会出现登录墙。浏览器会把
访客草稿保存在本地；当访客选择 **Save**、**Share**、**Publish** 或 **Remix** 时，才会出现轻量的
邮箱/密码登录界面。登录成功后，当前的可编辑项目状态会直接保存到新账号，不会因为跳转而丢失。

- **My Projects**：保存的是原图、模式、尺寸、阈值、孔位、颜色、调色板顺序、清理和切片参数等
  可编辑状态，而非从 STL 反推数据。登录后的当前项目采用 700ms 防抖自动保存。
- **Share**：创建随机、非顺序的 8 位 unlisted code（`/s/<code>`）。打开链接的人可匿名查看；
  原项目仍只属于创建者。
- **Remix**：会创建一个由当前用户拥有的新项目，保存 `remixedFromProjectId`；绝不直接修改原项目。
- **Publish to Community**：与 Share 分开。发布时可设标题、描述、标签和是否允许 Remix；
  **Unpublish** 只从 Community 移除，不删除 My Projects 中的源项目。

本版选择邮箱/密码认证，是因为它不要求配置第三方 OAuth 凭据。密码以 PBKDF2-SHA256（随机 salt、
310,000 rounds）散列保存，登录会话放在 HttpOnly、SameSite=Lax cookie 中。若要接入 Google 登录，
应在部署时配置 Google OAuth client 并将其接到相同的用户记录，而不是在前端伪造登录。

相关环境变量：

```bash
# 默认：项目根目录 data/drafterflow.db
DF_DATABASE_PATH=/absolute/path/to/drafterflow.db

# 仅在 HTTPS 已启用时设置，令 session cookie 带 Secure 属性
DF_COOKIE_SECURE=1
```

自动测试（包含持久化、分享、Remix、Unpublish 与 Color Layer 回归）：

```bash
.venv/bin/python -m unittest -v tests.test_color_layers tests.test_project_store
```

## Color Layer Mode（多色阶梯浮雕）

网页工具现在保留原有的 **Line Mode**，并新增 **Color Layer Mode**，用于扁平色插画、贴纸、
logo、Q 版人物等，而不是照片或渐变图。

流程是：

```text
PNG / JPG / WEBP → Lab 色彩量化 → 每色 mask → 用户排序 → 矢量轮廓 → 阶梯 STL
```

在浏览器打开工具后选择 `Color Layer Mode`：

1. 上传图片，选择 2–6 个目标颜色（默认 5）。透明像素不会生成几何。扁平色插画优先识别主要填充色，避免把抗锯齿灰边当成额外颜色。
2. 查看每个颜色的 mask；可显示/隐藏预览、上下调整顺序，或忽略某个颜色。对于不透明图片，点击 **Remove detected background** 移除与画布边缘连通的平坦背景，保留眼睛等封闭区域内的同色细节；可点击 **Restore** 恢复。该功能适用于纯色背景，不是照片的 AI 人像抠图。
3. 按 **Bottom → Top** 排序。列表越高，最终 Z 高度越高；DrafterFlow 不会猜测头发、脸或其他语义前后关系。
4. 设置模型宽度、底板厚度（默认 0.4 mm）和每色高度增量（默认 0.2 mm）。高度自动保持图片比例，且界面会显示每色最终 Z 高度、切片层对齐情况和极细特征提醒。
5. 生成一个合并后的 STL，并在浏览器中查看多色阶梯预览后下载。

几何规则为「一个区域组一个高度」：第 `n` 个已启用组的顶面为
`base + increment × n`。每个打印高度段包含本组及所有更高组的区域，因此较高区域始终有下层支撑。
底板使用第一个组的颜色，按列表顺序在各组顶面高度换料。STL 是封闭阶梯实体，但不存储颜色或 G-code；
需要在切片器中设置对应的换料高度。未启用的区域不进入底板或模型。

同一种颜色可以出现多次：在 **Layer to split** 选择白色，点击 **Select regions on image**，
在图上点选眼睛/头发高光的连通区域，再点击 **Move selected regions to new layer**。
新组保留白色并自动放到最上层，可重命名或重新排序；帽子和衣服留在原来的低层。
来源层应选择区域目前所在的层，不是想移入的层。**Move selection to** 可选择已有的同色
`Highlights`，把漏选的小高光追加进去，无需再建新层。小区域点击有 8 屏幕像素容差，优先精确命中，
未命中时只寻找来源层内最近的区域。
只支持拆分彼此分离的连通区域，不支持在连续区域内自由绘制切割线。

**Printed layer** 预览展示选中高度实际打印的完整区域（包含所有更高组），统一使用该层颜色。
**Surface regions** 则展示原始表面分色，方便选择高光。3D 预览按真实换料高度切分侧壁，
不会从二维抗锯齿边缘给侧壁随机取色。
扁平插画还会自动修正混色边缘：距离真实填充色较远、但离可靠填充像素不超过 3 个原图像素的
抗锯齿混色，会归回最近填充区域，避免深色／白色边缘被误认成浅蓝色凸条。
确切的填充像素（包括小高光和文字）不被此规则改色；宽面积渐变不做这种边缘修正。

**Base-only hole**：可启用一个圆孔，设置直径和中心 X/Y（mm，原图中心为原点，Y 向上），
或点击 **Place hole on preview** 在预览中定位。**Place above artwork** 自动把带 2 mm 壁厚的
底板挂耳放到图案上方，供钥匙环穿过。挂耳和孔仅影响 Z=0 到 base thickness 的底板；
颜色浮雕不被切穿，所以孔放在图案下面会被上方浮雕盖住。挂耳必须与底板相交，孤立位置会拒绝生成。
这些孔设置会随项目/本地草稿保存；关闭勾选即可移除。
**Hole / tab height** 可独立设置外侧挂耳厚度；留空沿用底板厚度，旧草稿行为不变。
例如底板 1 mm、挂耳 3 mm：外侧挂耳加厚到 3 mm，孔贯穿整个挂耳；图案和浮雕高度不被改变。
挂耳位于换料高度以上的部分会跟随对应高度的打印颜色。孔移入图案下面时，仍只切底板，
不会切掉浮雕；要获得贯穿挂耳的孔，请使用图案外侧位置。

自动测试（包括四色块、嵌套形状、透明背景、小孤立区域与颜色量化）：

```bash
.venv/bin/python -m unittest -v tests.test_color_layers
```

## Layer Studio 工作区

默认进入统一的物理图层编辑器，不再要求先选 Line / Color Mode：左侧为 Artwork、Geometry、
Keychain 工具；中间提供 Artwork / Regions / Print Plan / 3D；右侧图层按从上到下显示。
没有现有草稿时，开屏自动载入五色厨师示例；恢复已有草稿/项目仍优先保留用户自己的图片。
`Generate Model` 始终在顶栏。修改几何、排序或区域归属后，旧 3D 保留用于比较，按钮变为
`Update Model`；只有当前版本的模型允许从 Export 下载，过期请求不会覆盖新设置。

图层名称、厚度和区域归属跟随稳定 ID，拖动排序不会把自定义厚度转移给别的层。
同色区域可多选后移动到已有同色层，或单独拆成新物理层。眼睛按钮只控制区域预览，
`Include in model` 才影响生成。Print Plan 显示所选打印高度及全部更高区域所需的支撑面积。
每层的 `Height added` 是新增厚度；Geometry 中可设置默认厚度或 Apply Uniform Heights。
Background 的 Remove / Restore、base-only 孔、独立挂耳高度、清理和切片层高均沿用原逻辑。

旧线稿的阈值、多个孔、磁性吸附和孔编辑撤销/重做保留在 Artwork → Processing options →
Stroke extraction 中，仍使用同一套工作区。普通线稿也可以直接用两个颜色分析。
手机上工具和图层为抽屉，开始选区域或放孔时自动收起，让出画布；Generate / Export 不隐藏。

前端分为 `workspace.js`（布局与原控件适配）、`layers-panel.js`（图层/检查器）、
`model-state.js`（模型版本状态）和 `workspace.css`（绣球花色系与响应式）。
分析与 STL 的后端接口未变。完整映射及验证记录见 `docs/UI_REDESIGN.md`。

```bash
.venv/bin/python -m unittest discover -s tests
node --test tests/test_workspace.mjs
```

限制：初次分析 2–6 色，拆分后最多 24 层；仅连通区域拆分，不提供自由绘制切割；
已有层转移需同色。撤销/重做仍仅支持旧线稿孔编辑，STL 本身不存储耗材颜色。

## Color Layer Mode

Color Layer Mode 与原有 Line Mode 独立：上传 PNG/JPG/WEBP 插画，选择 2–6 个颜色，
按从低到高的顺序排列打印层并生成 STL。可去除边缘连通背景、将同色的独立区域拆为不同高度层，
并在 Printed layer 预览查看该高度实际打印的区域（包含所有更高层的支撑）。

Advanced 中可为每层指定增加的厚度（mm）；留空沿用统一 Height increment，顶面高度为
底板厚度加上截至该层的厚度总和。Hole & tab 可设置孔径、位置及独立挂耳厚度；图案浮雕不被切穿。
STL 仅包含几何，需在切片器中按打印计划设置换料。草稿仅存于当前浏览器；此版本不提供账号、
云端项目、分享或社区功能。

测试：`python -m unittest discover -s tests -v`。

发布用的 `static/app.js` 已将 Three.js 和预览依赖合并，无需线上请求 vendor 目录。
编辑 `src/editor.js` 后重新打包（运行服务无需 Node）：

```bash
pnpm dlx esbuild@0.25.10 src/editor.js --bundle --format=esm --alias:three=./static/vendor/three.module.js --alias:three/addons=./static/vendor --outfile=static/app.js --minify
```

## 部署 / Deploy

整个应用已容器化（`Dockerfile`），同一份镜像既可跑在免费 PaaS 上，也可原样跑在自己的
VPS/Docker 上——两种托管之间**不需要改代码**。STL 仍写入临时目录；账号和项目数据则需要一个
持久化 SQLite 路径（或日后替换成托管数据库）。

**先上免费 PaaS（Render，免费档）**：
1. 把仓库推到 GitHub 或 GitLab。
2. 到 [Render](https://render.com) → New → Blueprint，选择该仓库（会自动读取 `render.yaml`）。
3. 部署完成后即得一个公开 URL。

> Render 免费档空闲约 15 分钟会「睡眠」，下一次访问需冷启动几十秒到 ~1 分钟；免费档内存
> 较小（512MB），适合低流量，公开大流量建议尽早转 VPS。

**再迁到自托管 VPS / Docker（之后想做再弄）**：

```bash
docker build -t drafterflow .
docker run -d --name drafterflow -p 8000:8000 --restart unless-stopped drafterflow
```

或直接用 `docker-compose up -d`。Compose 已挂载命名卷 `drafterflow-data`，可保留 SQLite 数据。
要加 HTTPS，就在前面挂一个 Caddy/Nginx 反向代理，并设置 `DF_COOKIE_SECURE=1`。
容器默认绑定 `DF_HOST=0.0.0.0` 并读 `PORT` 环境变量（Render 会自动注入）；本地开发不受影响
（默认仍只监听 `127.0.0.1`，可用 `DF_HOST` 覆盖）。

> Render 的免费实例文件系统是临时的，因此不适合保存账号和项目。部署 Community/云端 autosave
> 时请使用带持久化磁盘的服务，并将 `DF_DATABASE_PATH` 指向该磁盘；不要把 SQLite 放在临时容器层。

### 正式版开启注册和 Community

Render Dashboard 中为现有 `drafterflow` 服务配置支持持久化磁盘的付费实例，
添加 1 GB 磁盘，挂载路径 `/var/data`（升级和收费需由服务所有者确认）。然后设置：

```text
DF_DATABASE_PATH=/var/data/drafterflow.db
DF_COOKIE_SECURE=1
DF_ACCOUNTS_ENABLED=1
```

这些配置保存并重新部署后即可注册、登录、保存项目、发布作品和编辑已发布详情。
Render 上未设置数据库路径及启用标志时，注册返回 503，避免账号写入会丢失的临时文件系统。
本地开发不受此保护开关影响。不要把本地 `data/` 数据库上传到 GitHub 或镜像；
现有本地账号和作品不会自动迁移到正式版。



- 矢量化（`vectorize.py`）的 **potrace 贝塞尔曲线**方案，参考了
  [bekuto3d](https://github.com/LittleSound/bekuto3d)（MIT，© 2025-PRESENT Rizumu）。
- 依赖 `potracer`（Potrace 的 Python 移植）为 **GPLv2+**；完整署名与许可条款见
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 开源许可 / License

本项目基于依赖 `potracer`（GPLv2+，copyleft），因此整个项目按
**GNU General Public License v3（GPLv3）** 授权 —— 与 GPLv2+ 兼容，合规且不侵权。
完整条款见 [LICENSE](LICENSE)。

分发本项目时须以 GPL 兼容许可证发布源码；若你希望使用更宽松的许可，可将
`potracer` 替换为宽松许可的矢量化方案（如 scikit-image 的亚像素 `find_contours`，
BSD-3），届时本项目可改用 MIT 等宽松许可。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
