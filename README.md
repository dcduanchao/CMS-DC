# 轻映

轻量苹果 CMS V10 JSON 影视站。源配置保存在本地 JSON；默认列表、搜索和详情只访问所选源。搜索框的“全站”是主动选择的跨源搜索，结果标明来源。请只添加拥有使用授权的源及播放资源。

## 本地启动

需要 Node.js 22 和 npm。以下命令在项目根目录的 PowerShell 中执行。

1. 安装依赖并准备配置文件：

   ```powershell
   npm ci
   if (-not (Test-Path .env)) { Copy-Item .env.example .env }
   notepad .env
   ```

2. 在 `.env` 中分别设置 `SITE_PASSWORD`（网站访问密码）和 `ADMIN_PASSWORD`（管理密码），每个密码至少 6 个字符。保存文件后，构建并启动：

   ```powershell
   npm run build
   npm run server
   ```

3. 浏览器访问 [http://localhost:8080](http://localhost:8080)，使用 `SITE_PASSWORD` 进入，再通过右上角“源管理”使用 `ADMIN_PASSWORD` 登录并添加影视源。按 `Ctrl+C` 停止服务。

服务启动时读取 `.env`，已有的系统环境变量优先。修改管理员密码后重启服务即可生效。源和代理设置保存在本地 `data/config.json`，请备份并限制该文件的读取权限。

### 本地开发

在一个终端运行 `npm run server`，另一个终端运行 `npm run dev`，然后访问 Vite 输出的地址。开发服务器将 `/api` 请求代理到本机 8080 端口。修改前端后，生产页面需要重新执行 `npm run build`。

执行 `npm test` 运行测试。浏览器测试需要先执行 `npm run build`，默认查找 Windows Chrome，也可通过 `BROWSER_PATH` 指定 Chromium 或 Chrome 路径；找不到浏览器时会跳过。

## Docker 启动

需要 Docker 和 Docker Compose。在项目根目录执行：

1. 如果 `.env` 不存在，复制 `.env.example` 为 `.env`，分别设置 `SITE_PASSWORD` 和 `ADMIN_PASSWORD`，每个密码至少 6 个字符。可通过 `APP_PORT` 设置宿主机访问端口，默认是 `8082`。已有 `.env` 也需要添加 `SITE_PASSWORD`。
2. 构建并启动：

   ```sh
   docker compose up -d --build
   ```

3. 浏览器访问 [http://localhost:8082](http://localhost:8082)（如果修改了 `APP_PORT`，请使用设置的端口），使用 `SITE_PASSWORD` 进入，在“源管理”中使用 `ADMIN_PASSWORD` 登录并添加影视源。

常用命令：

```sh
docker compose logs -f       # 查看日志
docker compose restart       # 重启服务
docker compose down          # 停止并移除容器，保留数据卷
```

修改代码或 `.env` 后，重新执行 `docker compose up -d --build`。`APP_PORT` 指定宿主机端口，容器内部仍使用 8080 端口。数据保存在 `cinema_data` 命名卷中，重建容器不会丢失配置；删除数据卷会删除配置。

正式环境应通过 Nginx 或 Caddy 提供 HTTPS，并将 `.env` 中的 `COOKIE_SECURE` 设为 `true`；反向代理需保留原始 Host。请限制管理入口访问并定期备份数据卷。

## 影视源与代理

网站访问和管理使用独立密码与会话。访问密码只允许浏览，管理影视源和代理需另行输入管理密码。会话有效期为 12 小时，服务重启后需要重新登录。

在“源管理”中添加、编辑和测试影视源。测试连接前需先保存并启用源。也可以通过 JSON 文件导入或导出源；导入会跳过地址重复的源，导出文件包含完整地址，请妥善保管。

在“源管理 → 代理设置”中可启用 HTTP CONNECT 代理，例如 `http://127.0.0.1:7890`。代理用于后端请求影视源 API；海报和播放地址仍由浏览器直接访问。代理地址相对于后端运行环境，Docker 容器中的 `127.0.0.1` 指容器自身。源域名仍由后端解析并进行公网地址检查。

## 行为与限制

- 分类来自当前源的 `class`；“全部”不携带分类参数。无分类时仍加载列表；无可用源时不展示演示数据。
- 上游请求限制 DNS 和总请求时间、响应大小、并发及短期缓存；缓存按序列化数据大小最多保留 16 MiB、200 条，实际内存占用可能高于该数值。DNS 结果和每次重定向均检查特殊用途地址，解析结果固定用于连接。内网源不受支持；不提供绕过访问控制的播放代理。
- 浏览器直接访问海报和播放 URL；资源本身必须允许用户访问。HLS 需要浏览器原生支持或资源允许跨域，播放器仅识别 `.mp4` 和 `.m3u8` 地址。不保证第三方源格式或资源可用。
- 配置采用临时文件和重命名；只支持单进程写入，勿同时运行多个实例共用配置文件。登录会话、限流状态和缓存存于进程内，重启后清空。
- 本版使用 Vue、Vite、Fastify 和 hls.js；未使用 MySQL 或 Redis。具体测试与尚未执行的验收见 [验收记录](验收记录.md)。

## 上线步骤

1. 在具备 Docker 的 Linux 测试主机配置环境变量，构建镜像并运行测试端口；确认卷权限、健康检查、重启和备份恢复。
2. 添加已授权的两个真实源，验收动态分类、分页、搜索、详情和实际播放，并确认源地址与密钥未泄漏。
3. 由运维完成安全检查、HTTPS 反向代理及管理访问限制；仅在测试验收通过后切换正式入口。
