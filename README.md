# fan-object-generator

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

前端是纯静态页（`static/`，Three.js 3D 预览）+ 一个薄薄的 FastAPI 接口层（`server.py`），
只负责把请求转发到现有的 `image_processing → vectorize → model_builder` 管道，管道本身不改。
以后迁移到网页托管时，把 `server.py` 换成线上服务即可，管道与前端无需改动。

## 部署 / Deploy

整个应用已容器化（`Dockerfile`），同一份镜像既可跑在免费 PaaS 上，也可原样跑在自己的
VPS/Docker 上——两种托管之间**不需要改代码**。服务是无状态的（不用数据库，STL 写入临时目录）。

**先上免费 PaaS（Render，免费档）**：
1. 把仓库推到 GitHub 或 GitLab。
2. 到 [Render](https://render.com) → New → Blueprint，选择该仓库（会自动读取 `render.yaml`）。
3. 部署完成后即得一个公开 URL。

> Render 免费档空闲约 15 分钟会「睡眠」，下一次访问需冷启动几十秒到 ~1 分钟；免费档内存
> 较小（512MB），适合低流量，公开大流量建议尽早转 VPS。

**再迁到自托管 VPS / Docker（之后想做再弄）**：

```bash
docker build -t fan-object-generator .
docker run -d --name fog -p 8000:8000 --restart unless-stopped fan-object-generator
```

或直接用 `docker-compose up -d`。要加 HTTPS，就在前面挂一个 Caddy/Nginx 反向代理。
容器默认绑定 `FOG_HOST=0.0.0.0` 并读 `PORT` 环境变量（Render 会自动注入）；本地开发不受影响
（默认仍只监听 `127.0.0.1`，可用 `FOG_HOST` 覆盖）。



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
