#!/usr/bin/env bash
# 一键部署：创建 D1 → 回填 database_id → 部署 Worker + 静态页面
# 用法：./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

command -v npx >/dev/null || { echo "需要 Node.js（npx）"; exit 1; }

WRANGLER="npx wrangler"

# 1. 确保 wrangler.toml 里有 database_id
DB_ID=$(grep -E '^database_id' wrangler.toml | sed 's/database_id *= *"\(.*\)"/\1/')
if [ -z "$DB_ID" ]; then
  echo "→ 创建 D1 数据库 commandcode-usage …"
  CREATE_OUT=$($WRANGLER d1 create commandcode-usage 2>&1)
  echo "$CREATE_OUT"
  NEW_ID=$(echo "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  if [ -z "$NEW_ID" ]; then
    # 已存在同名库时 wrangler 会报错并列出现有库；尝试 list 里找回
    NEW_ID=$($WRANGLER d1 list 2>/dev/null | grep -i 'commandcode-usage' | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  fi
  if [ -z "$NEW_ID" ]; then
    echo "✗ 无法获取 database_id，请手动执行: npx wrangler d1 create commandcode-usage"
    exit 1
  fi
  # 回填（macOS/BSD sed）
  sed -i '' "s/^database_id = \"\"/database_id = \"$NEW_ID\"/" wrangler.toml
  echo "✓ database_id = $NEW_ID 已写入 wrangler.toml"
else
  echo "→ 使用已有 D1: $DB_ID"
fi

# 2. 部署
echo "→ 部署 Worker + 页面 …"
$WRANGLER deploy || exit 1

echo ""
echo "✓ 部署完成。强烈建议马上设置管理密码（否则面板公开可访问）："
echo "    npx wrangler secret put ADMIN_TOKEN"
