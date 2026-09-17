# 百度云服务器自动采集粉笔题库

> 作用：让一台百度云（BCC/轻量）服务器每天定时跑 `region-crawler.mjs` / `zhejiang-crawler.mjs`，
> 生成 `tiku.db / practice.db / materials.db`，再拉回本地使用。爬虫零第三方依赖，幂等断点续爬。

```text
deploy-baidu/
├── setup.sh        # 服务器一次性初始化（Node 22+、拉代码、试跑验证）
├── crawl-all.sh    # 定时采集入口（cron 调用，按天记录日志）
├── crontab.example # 每天 03:30 采集的 crontab 配置
├── sync-back.ps1   # 本机 Windows 拉回 3 个 db（scp）
└── README.md       # 本文档
```

---

## 一、准备工作（本机）

1. 确认本机 `cookie.txt`（粉笔登录 Cookie）有效——爬虫靠它鉴权
   - Cookie 有有效期，过期后重新登录粉笔网页复制一份替换
2. 确认被采集地区：`region-crawler.mjs`（江苏/上海/广东/深圳）+ `zhejiang-crawler.mjs`（浙江）
3. 准备一台百度云服务器（Ubuntu 22.04，1C2G 足够，磁盘 ≥10G）

## 二、服务器部署（一次性）

```bash
# 1) 把本目录传到服务器（或用 WinSCP/SFTP 上传）
scp -r deploy-baidu cookie.txt root@服务器IP:/root/
ssh root@服务器IP

# 2) 初始化（装 Node、拉代码、验证 node:sqlite；注意脚本最后会提示配置 cookie）
bash /root/deploy-baidu/setup.sh

# 3) 把 cookie.txt 放到采集目录（setup.sh 若已复制可跳过）
cp /root/cookie.txt /opt/kaogong/cookie.txt
```

`setup.sh` 最后会试跑 `zhejiang-crawler.mjs --only=行测 --limit=1` 验证链路。
返回 403/429 说明触发风控或 Cookie 失效；正常会打印爬到的题目数。

## 三、开定时采集

```bash
ssh root@服务器IP
crontab -e
# 加入 deploy-baidu/crontab.example 里的那一行（每天 03:30）
#   30 3 * * * /bin/bash /opt/kaogong/deploy-baidu/crawl-all.sh >/dev/null 2>&1
```

- 日志：`/opt/kaogong/logs/crawl-YYYY-MM-DD.log`（保留 14 天）
- 首次全量会跑很久（两个爬虫含 4s 频率控制 + 90s 冷却），属正常
- 想看某天进度：`tail -f /opt/kaogong/logs/crawl-$(date +%F).log`

## 四、拉回本地（每次想用新题库时）

```powershell
# 本机 Windows
powershell -File deploy-baidu\sync-back.ps1 -Server root@服务器IP
# 自动把 tiku.db / practice.db / materials.db 拉到仓库根目录
```

拉回后可：
- `node server.mjs 3000` 直接本地服务
- 重新打包手机内置题库（见 `BUILD_MANUAL.md`）

## 五、注意事项

| 事项 | 说明 |
|---|---|
| Cookie 有效期 | 会过期；403 是 Cookie 失效/风控恢复信号，需换新 Cookie |
| 云 IP 风控 | 云厂商 IP 段更易被识别，爬虫自带 90s 冷却 + 指数退避，失败会自动跳过继续 |
| 版权 | 粉笔题库为商业内容，仅建议个人学习用途，勿传播/商用 |
| cookie.txt 未入库 | 仓库内 `cookie.txt` 已被 `.gitignore`（`cookie*.txt`）排除、不入库；服务器端需手工放置，失效后重新上传更换 |
| 千万别传反 | 服务器上必须有 cookie.txt；本地 `server.mjs` 运行目录不需要它 |