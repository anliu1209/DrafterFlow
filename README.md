# fan-object-generator

透明背景 PNG → 双层钥匙扣 STL 生成器（V1.0 MVP）。

## 用法

```bash
python main.py examples/txt.png output/txt.stl
python main.py examples/heart.png output/heart.stl --width 50
```

自定义两层厚度：

```bash
# 底板 4mm + 浮雕 2mm = 总高 6mm
python main.py 你的图.png output/xxx.stl --base 4 --color 2
```

参数见 `python main.py --help`。

## 双色打印

生成**单个 STL**。切片时在「底板厚度」处换料（默认 1.2mm，用 `--base` 改）：

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
