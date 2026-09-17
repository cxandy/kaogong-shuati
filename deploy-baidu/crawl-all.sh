#!/usr/bin/env bash
# ============================================
# 定时采集入口（由 cron 调用，无人值守）
# 顺序跑两个爬虫：江浙沪珠三角 + 浙江；日志按天追加
# 幂等：已完成 paper 自动跳过；单个失败不影响另一个
# ============================================
set -u
cd /opt/kaogong || exit 1

LOG_DIR=/opt/kaogong/logs
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/crawl-$(date +%F).log"

{
  echo "==== $(date '+%F %T') 开始采集 ===="
  node region-crawler.mjs --only=全部
  node zhejiang-crawler.mjs --only=全部
  echo "==== $(date '+%F %T') 结束 ===="
} >> "$LOG" 2>&1

# 保留最近 14 天日志
find "$LOG_DIR" -name 'crawl-*.log' -mtime +14 -delete 2>/dev/null
exit 0