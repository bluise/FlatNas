#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# FlatNas Debian 部署脚本 (全能版)
# 功能：安装 (install) / 卸载 (uninstall) / 回滚 (rollback)
# 说明：
#   本脚本基于 debian/deploy.sh 和 debian/manage.sh 整合优化而来。
#   支持从 GitHub Releases 自动拉取最新版本进行一键部署。
#   自动检测系统架构 (amd64/arm64)，下载对应的 flatnas-{arch}.zip。
#   包含安全卸载和版本回滚功能。
#
# 使用方式：
#   1. 下载脚本：
#      wget -O deploy_debian.sh https://raw.githubusercontent.com/bluise/FlatNas/main/deploy_debian.sh
#   2. 运行安装：
#      chmod +x deploy_debian.sh
#      sudo ./deploy_debian.sh
#
# 前置要求：
#   - 确保 GitHub 仓库 (bluise/FlatNas) 发布了包含 flatnas-amd64.zip / flatnas-arm64.zip 的 Release。
#   - zip 包应包含 flatnas-server 二进制和 server/public 目录。

MODE="${1:-install}"

# ==========================================
# 基础配置与变量
# ==========================================

ARCH_RAW="$(uname -m)"
case "${ARCH_RAW}" in
  x86_64)  ARCH="amd64" ;;
  aarch64) ARCH="arm64" ;;
  armv7l)  ARCH="arm64" ;;
  *)       ARCH="" ;;
esac

APP_NAME="flatnas"
APP_USER="flatnas"
SERVICE_NAME="flatnas"
BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

# 默认安装路径
INSTALL_DIR="/opt/${APP_NAME}"
BIN_DIR="${INSTALL_DIR}/bin"
SERVER_DIR="${INSTALL_DIR}/server"
PUBLIC_DIR="${SERVER_DIR}/public"
CACHE_DIR="${SERVER_DIR}/cache"
DATA_DIR="${SERVER_DIR}/data"
MUSIC_DIR="${SERVER_DIR}/music"
PC_DIR="${SERVER_DIR}/PC"
APP_DIR="${SERVER_DIR}/APP"
DOC_DIR="${SERVER_DIR}/doc"
LOG_DIR="/var/log/${APP_NAME}"
CONFIG_DIR="/etc/${APP_NAME}"
CONFIG_FILE="${CONFIG_DIR}/${APP_NAME}.env"
NGINX_CONF="/etc/nginx/sites-available/${APP_NAME}"
NGINX_LINK="/etc/nginx/sites-enabled/${APP_NAME}"
SYSTEMD_SERVICE="/etc/systemd/system/${APP_NAME}.service"
SSL_DIR="/etc/nginx/ssl/${APP_NAME}"

# 颜色定义
COLOR_GREEN="\033[0;32m"
COLOR_RED="\033[0;31m"
COLOR_YELLOW="\033[0;33m"
COLOR_RESET="\033[0m"

# ==========================================
# 辅助函数
# ==========================================

log_info() {
  printf "%s ${COLOR_GREEN}[INFO]${COLOR_RESET} %s\n" "$(date +"%F %T")" "$1"
}

log_warn() {
  printf "%s ${COLOR_YELLOW}[WARN]${COLOR_RESET} %s\n" "$(date +"%F %T")" "$1"
}

log_error() {
  printf "%s ${COLOR_RED}[ERROR]${COLOR_RESET} %s\n" "$(date +"%F %T")" "$1"
}

fail_with_tip() {
  log_error "$1"
  [ -n "${2:-}" ] && log_warn "$2"
  exit 1
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    fail_with_tip "请使用 root 权限运行脚本" "Debian 下可使用: sudo $0 ${MODE}"
  fi
}

require_debian() {
  if [ ! -f /etc/debian_version ]; then
    # 尝试更宽泛的检查，兼容 Ubuntu
    if grep -Ei 'debian|ubuntu' /etc/os-release >/dev/null 2>&1; then
        return 0
    fi
    fail_with_tip "当前脚本仅支持 Debian/Ubuntu 系统" "检测到非 Debian 系发行版，脚本可能无法正常工作。"
  fi
}

prompt() {
  local label="$1"
  local default="$2"
  read -r -p "${label} [${default}]: " input
  echo "${input:-$default}"
}

prompt_yes_no() {
  local label="$1"
  local default="$2"
  read -r -p "${label} [${default}]: " input
  local val="${input:-$default}"
  case "${val,,}" in
    y|yes|是) echo "yes" ;;
    *) echo "no" ;;
  esac
}

confirm_twice() {
  local label="$1"
  if [ "$(prompt_yes_no "${label} (yes/no)" "no")" != "yes" ]; then
    return 1
  fi
  if [ "$(prompt_yes_no "再次确认 (yes/no)" "no")" != "yes" ]; then
    return 1
  fi
  return 0
}

is_port_in_use() {
  local port="$1"
  if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$"; then
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    if lsof -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
  fi
  return 1
}

require_free_port() {
  local port="$1"
  local name="$2"
  if is_port_in_use "${port}"; then
    # 如果是服务自身占用，可以忽略（因为会重启）
    if systemctl is-active --quiet "${SERVICE_NAME}" || systemctl is-active --quiet nginx; then
        log_warn "${name} 端口 ${port} 正在使用中，假设是现有服务占用"
    else
        fail_with_tip "${name} 端口 ${port} 已被占用且服务未运行"
    fi
  fi
}

validate_port() {
  local port="$1"
  if ! [[ "${port}" =~ ^[0-9]+$ ]] || [ "${port}" -lt 1 ] || [ "${port}" -gt 65535 ]; then
    return 1
  fi
  return 0
}

# ==========================================
# 核心功能函数
# ==========================================

ensure_packages() {
  local pkgs=("$@")
  local missing=()
  for pkg in "${pkgs[@]}"; do
    if ! dpkg -s "${pkg}" >/dev/null 2>&1; then
      missing+=("${pkg}")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    log_info "安装依赖: ${missing[*]}"
    apt-get update -y >/dev/null
    apt-get install -y "${missing[@]}" >/dev/null
  fi
}

create_user() {
  if ! id -u "${APP_USER}" >/dev/null 2>&1; then
    log_info "创建系统用户: ${APP_USER}"
    useradd --system --create-home --home-dir "${INSTALL_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
  fi
}

# 初始化数据目录 (从 deploy.sh 移植)
init_data_dir() {
  local src_name="$1"
  local dest_path="$2"
  local source_root="$3" # 外部传入源根目录
  
  local src_path=""
  # 1. 检查脚本所在目录下的 server/NAME
  if [ -d "${BASE_DIR}/server/${src_name}" ]; then
    src_path="${BASE_DIR}/server/${src_name}"
  # 2. 检查传入源根目录下的 server/NAME
  elif [ -n "${source_root}" ] && [ -d "${source_root}/server/${src_name}" ]; then
    src_path="${source_root}/server/${src_name}"
  fi
  
  if [ -n "${src_path}" ]; then
    mkdir -p "${dest_path}"
    # 如果目标目录为空，则复制
    if [ -z "$(ls -A "${dest_path}" 2>/dev/null)" ]; then
       log_info "初始化 ${src_name} 从 ${src_path} ..."
       cp -r "${src_path}/." "${dest_path}/"
    else
       log_info "保留现有 ${src_name} (目标非空)"
    fi
  else
    mkdir -p "${dest_path}"
  fi
  
  # 修正权限
  chown -R "${APP_USER}:${APP_USER}" "${dest_path}"
  chmod -R 755 "${dest_path}"
}

write_systemd_service() {
  local port="$1"
  local restart_policy="${2:-on-failure}"
  
  cat > "${SYSTEMD_SERVICE}" <<EOF
[Unit]
Description=FlatNas Go Service
After=network.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=-${CONFIG_FILE}
Environment=GIN_MODE=release
Environment=PUBLIC_DIR=${PUBLIC_DIR}
# 兼容旧环境变量名
Environment=PORT=${port}
Environment=APP_PORT=${port}
ExecStart=${BIN_DIR}/${APP_NAME}
Restart=${restart_policy}
RestartSec=5
LimitNOFILE=65535

# 日志配置 (使用 journald)
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${APP_NAME}

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
}

write_nginx_config() {
  local frontend_port="$1"
  local backend_port="$2"
  local use_https="${3:-no}"
  local ssl_cert="${4:-}"
  local ssl_key="${5:-}"
  local domain="${6:-_}"

  local nginx_config_content=""

  if [ "${use_https}" = "yes" ] && [ -n "${ssl_cert}" ] && [ -n "${ssl_key}" ]; then
    nginx_config_content=$(cat <<EOF
server {
    listen ${frontend_port};
    server_name ${domain};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${domain};
    client_max_body_size 20m;
    
    ssl_certificate ${ssl_cert};
    ssl_certificate_key ${ssl_key};
    
    root ${PUBLIC_DIR};
    index index.html;
    
    # 日志
    access_log ${LOG_DIR}/nginx-access.log;
    error_log ${LOG_DIR}/nginx-error.log warn;
    
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 30d;
        add_header Cache-Control "public";
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:${backend_port};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        
        # WebSocket
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:${backend_port};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
)
  else
    nginx_config_content=$(cat <<EOF
server {
    listen ${frontend_port};
    server_name ${domain};
    client_max_body_size 20m;

    root ${PUBLIC_DIR};
    index index.html;

    # 日志
    access_log ${LOG_DIR}/nginx-access.log;
    error_log ${LOG_DIR}/nginx-error.log warn;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 30d;
        add_header Cache-Control "public";
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:${backend_port};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        
        # WebSocket
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:${backend_port};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
)
  fi

  echo "${nginx_config_content}" > "${NGINX_CONF}"
  ln -sf "${NGINX_CONF}" "${NGINX_LINK}"
  
  # 删除默认配置
  if [ -L "/etc/nginx/sites-enabled/default" ]; then
    rm "/etc/nginx/sites-enabled/default"
  fi
  
  nginx -t >/dev/null || log_warn "Nginx 配置检测失败，请稍后检查"
}

write_config_file() {
  local backend_port="$1"
  local frontend_port="$2"
  mkdir -p "${CONFIG_DIR}"
  cat > "${CONFIG_FILE}" <<EOF
PORT=${backend_port}
PUBLIC_DIR=${PUBLIC_DIR}
FRONTEND_PORT=${frontend_port}
BACKEND_PORT=${backend_port}
EOF
  chown root:root "${CONFIG_FILE}"
  chmod 644 "${CONFIG_FILE}"
}

configure_apparmor() {
  if ! command -v apparmor_parser >/dev/null 2>&1; then
    return 0
  fi
  log_info "配置 AppArmor..."
  cat > "/etc/apparmor.d/${APP_NAME}" <<EOF
#include <tunables/global>

profile ${APP_NAME} ${BIN_DIR}/${APP_NAME} {
  #include <abstractions/base>
  #include <abstractions/nameservice>
  #include <abstractions/openssl>
  #include <abstractions/ssl_certs>
  capability net_bind_service,
  capability setuid,
  capability setgid,
  capability chown,
  capability fowner,
  capability dac_override,
  network inet stream,
  network inet6 stream,
  ${BIN_DIR}/${APP_NAME} ix,
  ${INSTALL_DIR}/** rwk,
  ${LOG_DIR}/** rwk,
  ${CONFIG_DIR}/** r,
  /etc/ssl/** r,
  /tmp/** rwk,
}
EOF
  apparmor_parser -r "/etc/apparmor.d/${APP_NAME}" >/dev/null || true
}

configure_ufw() {
  local port="$1"
  local https_port="$2"
  if ! command -v ufw >/dev/null 2>&1; then
    return 0
  fi
  log_info "配置 UFW 防火墙..."
  ufw allow "${port}/tcp" >/dev/null || true
  if [ -n "${https_port}" ]; then
    ufw allow "${https_port}/tcp" >/dev/null || true
  fi
  ufw --force enable >/dev/null || true
}

verify_deploy() {
  local backend_port="$1"
  local frontend_port="$2"
  
  log_info "正在验证部署..."
  
  # 1. 检查服务状态
  systemctl is-active --quiet "${SERVICE_NAME}" || fail_with_tip "后端服务未运行"
  systemctl is-active --quiet nginx || fail_with_tip "Nginx 服务未运行"
  
  # 2. 等待端口监听
  local max_retries=10
  local count=0
  while [ $count -lt $max_retries ]; do
    if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${backend_port}$"; then
        break
    fi
    sleep 1
    count=$((count + 1))
  done
  
  if ! ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${backend_port}$"; then
    log_warn "后端端口 ${backend_port} 尚未监听，服务启动可能较慢"
    journalctl -u "${SERVICE_NAME}" -n 20 --no-pager
  else
    log_info "后端端口 ${backend_port} 已监听"
  fi
  
  # 3. API 健康检查
  if curl -fsSL --max-time 5 "http://127.0.0.1:${backend_port}/api/ping" >/dev/null 2>&1; then
    log_info "后端 API 健康检查通过"
  else
    log_warn "后端 API 健康检查失败 (可能还在初始化)"
  fi

  local html
  html="$(curl -fsSL --max-time 8 "http://127.0.0.1:${frontend_port}/" || true)"
  if [ -z "${html}" ]; then
    log_warn "前端首页拉取失败，未能完成产物校验"
  else
    if printf "%s" "${html}" | grep -Eq '/@vite/client|virtual:vue-devtools-path|/src/main\.(ts|js)'; then
      fail_with_tip "检测到开发版前端（Vite）被部署到线上，请重新使用 release 包部署 server/public"
    fi
    if ! printf "%s" "${html}" | grep -q '/assets/'; then
      log_warn "前端首页未检测到 /assets/ 引用，请确认静态产物是否完整"
    fi
  fi
  
  log_info "部署验证完成"
}

backup_current() {
  if [ -d "${INSTALL_DIR}" ]; then
    local backup_path="/var/backups/${APP_NAME}/backup_$(date +"%Y%m%d_%H%M%S").tar.gz"
    mkdir -p "$(dirname "${backup_path}")"
    log_info "正在备份当前版本到 ${backup_path} ..."
    tar -czf "${backup_path}" "${INSTALL_DIR}" 2>/dev/null || true
  fi
}

# ==========================================
# 流程控制
# ==========================================

install_flow() {
  require_root
  require_debian

  if [ -z "${ARCH}" ]; then
    fail_with_tip "不支持的系统架构: ${ARCH_RAW}" "目前仅支持 x86_64 (amd64) 和 aarch64/armv7l (arm64)"
  fi
  
  echo "=============================="
  echo "   FlatNas 一键部署脚本"
  echo "   架构: ${ARCH}"
  echo "=============================="
  
  # 1. 配置收集
  local frontend_port
  frontend_port="$(prompt "前端访问端口" "23000")"
  local backend_port
  backend_port="$(prompt "后端服务端口 (内部)" "3000")"
  
  if ! validate_port "${frontend_port}" || ! validate_port "${backend_port}"; then
    fail_with_tip "端口非法"
  fi
  if [ "${frontend_port}" -eq "${backend_port}" ]; then
    fail_with_tip "前端端口和后端端口不能相同"
  fi
  
  require_free_port "${frontend_port}" "前端"
  require_free_port "${backend_port}" "后端"
  
  # ==========================================
  # GitHub 拉取逻辑
  # ==========================================
  log_info "准备从 GitHub 拉取最新版本..."
  
  # 确保有 unzip 和 wget
  if ! command -v unzip >/dev/null 2>&1; then
    apt-get update && apt-get install -y unzip
  fi
  if ! command -v wget >/dev/null 2>&1; then
    apt-get update && apt-get install -y wget
  fi

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  # 注册清理函数，确保退出时删除临时目录
  trap 'rm -rf "${tmp_dir}"' EXIT

  local download_url="https://github.com/bluise/FlatNas/releases/latest/download/flatnas-${ARCH}.zip"
  local zip_file="${tmp_dir}/flatnas-${ARCH}.zip"
  
  log_info "下载: ${download_url}"
  if ! wget -O "${zip_file}" "${download_url}"; then
    fail_with_tip "下载失败，请检查网络或确认 GitHub Release 是否存在 flatnas-${ARCH}.zip"
  fi
  
  log_info "解压资源..."
  unzip -q "${zip_file}" -d "${tmp_dir}/source"
  
  # 自动寻找包含 flatnas-server 的目录
  local source_dir=""
  local binary_src=""
  
  # 深度为 2 的搜索，防止 zip 包有一层文件夹
  local found_bin
  found_bin="$(find "${tmp_dir}/source" -maxdepth 2 -type f -name "flatnas-server" | head -n 1)"
  
  if [ -n "${found_bin}" ]; then
    binary_src="${found_bin}"
    source_dir="$(dirname "${binary_src}")"
  else
    # 尝试找 flatnas (兼容旧命名)
    found_bin="$(find "${tmp_dir}/source" -maxdepth 2 -type f -name "flatnas" | head -n 1)"
    if [ -n "${found_bin}" ]; then
        binary_src="${found_bin}"
        source_dir="$(dirname "${binary_src}")"
    fi
  fi
  
  if [ -z "${source_dir}" ]; then
    fail_with_tip "在下载包中未找到 flatnas-server 二进制文件"
  fi
  
  local static_src="${source_dir}/server/public"
  
  log_info "定位源文件: ${source_dir}"
  
  if [ ! -f "${binary_src}" ]; then
    fail_with_tip "未找到二进制文件: ${binary_src}"
  fi
  if [ ! -d "${static_src}" ]; then
    # 尝试兼容打包结构差异，有时可能在上一级? 不，标准结构应为同级
    # 再次尝试寻找 server/public
    local found_public
    found_public="$(find "${tmp_dir}/source" -maxdepth 3 -type d -path "*/server/public" | head -n 1)"
    if [ -n "${found_public}" ]; then
       static_src="${found_public}"
    else
       fail_with_tip "未找到静态文件目录 (server/public)"
    fi
  fi
  
  # 2. 准备环境
  log_info "检查依赖..."
  ensure_packages nginx curl iproute2 lsof apparmor-utils ufw
  
  create_user
  
  log_info "准备目录..."
  mkdir -p "${BIN_DIR}" "${PUBLIC_DIR}" "${CACHE_DIR}" "${LOG_DIR}" "${CONFIG_DIR}"
  mkdir -p "${DATA_DIR}" "${MUSIC_DIR}" "${PC_DIR}" "${APP_DIR}" "${DOC_DIR}"
  
  # 3. 备份与清理
  backup_current
  systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
  
  # 4. 复制文件
  log_info "安装文件..."
  cp -f "${binary_src}" "${BIN_DIR}/${APP_NAME}"
  chmod 755 "${BIN_DIR}/${APP_NAME}"
  
  # 同步静态文件 (使用 rsync 如果有，否则 rm+cp)
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "${static_src}/" "${PUBLIC_DIR}/"
  else
    rm -rf "${PUBLIC_DIR:?}"/*
    cp -a "${static_src}/." "${PUBLIC_DIR}/"
  fi
  
  # 5. 初始化数据目录 (核心逻辑)
  log_info "初始化数据目录..."
  init_data_dir "data" "${DATA_DIR}" "${source_dir}"
  init_data_dir "music" "${MUSIC_DIR}" "${source_dir}"
  init_data_dir "PC" "${PC_DIR}" "${source_dir}"
  init_data_dir "APP" "${APP_DIR}" "${source_dir}"
  init_data_dir "doc" "${DOC_DIR}" "${source_dir}"
  
  if [ -z "$(ls -A "${PUBLIC_DIR}" 2>/dev/null)" ]; then
    log_warn "前端静态目录为空，尝试从 ${static_src} 重新复制..."
    if [ -d "${static_src}" ]; then
      cp -a "${static_src}/." "${PUBLIC_DIR}/"
      log_info "前端静态文件已补充复制"
    else
      log_warn "源目录 ${static_src} 不存在，前端可能无法正常访问"
    fi
  fi
  
  # 6. 设置权限
  log_info "设置权限..."
  chown -R "${APP_USER}:${APP_USER}" "${INSTALL_DIR}" "${LOG_DIR}" "${CONFIG_DIR}"
  chmod 755 "${BIN_DIR}/${APP_NAME}"
  
  # 7. 生成配置
  log_info "生成配置..."
  write_config_file "${backend_port}" "${frontend_port}"
  write_systemd_service "${backend_port}"
  write_nginx_config "${frontend_port}" "${backend_port}"
  
  # 8. 安全配置
  configure_apparmor
  configure_ufw "${frontend_port}" ""
  
  # 9. 启动服务
  log_info "启动服务..."
  systemctl enable "${SERVICE_NAME}" >/dev/null
  systemctl restart "${SERVICE_NAME}"
  systemctl enable nginx >/dev/null
  systemctl restart nginx
  
  # 10. 验证
  verify_deploy "${backend_port}" "${frontend_port}"
  
  echo ""
  log_info "部署完成！"
  echo "------------------------------"
  echo "前端访问地址: http://<服务器IP>:${frontend_port}"
  echo "后端监听端口: ${backend_port}"
  echo "服务状态查看: systemctl status ${SERVICE_NAME}"
  echo "------------------------------"
}

uninstall_flow() {
  require_root
  
  echo "!!!"
  echo "警告：此操作将完全删除 FlatNas 服务、配置文件、日志及数据！"
  echo "!!!"
  
  if ! confirm_twice "确定要卸载吗？"; then
    echo "取消卸载。"
    exit 0
  fi
  
  log_info "停止服务..."
  systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
  systemctl stop nginx >/dev/null 2>&1 || true
  systemctl disable "${SERVICE_NAME}" >/dev/null 2>&1 || true
  
  log_info "删除服务文件..."
  rm -f "${SYSTEMD_SERVICE}"
  systemctl daemon-reload
  
  log_info "删除 Nginx 配置..."
  rm -f "${NGINX_CONF}"
  rm -f "${NGINX_LINK}"
  
  log_info "删除应用文件..."
  rm -rf "${INSTALL_DIR}"
  rm -rf "${CONFIG_DIR}"
  rm -rf "${LOG_DIR}"
  if [ -n "${SSL_DIR}" ]; then
    rm -rf "${SSL_DIR}"
  fi
  
  log_info "删除 AppArmor 配置..."
  if [ -f "/etc/apparmor.d/${APP_NAME}" ]; then
    rm -f "/etc/apparmor.d/${APP_NAME}"
    systemctl reload apparmor >/dev/null 2>&1 || true
  fi
  
  log_info "删除用户..."
  if id "${APP_USER}" >/dev/null 2>&1; then
    userdel "${APP_USER}" >/dev/null 2>&1 || true
  fi
  
  log_info "重启 Nginx..."
  systemctl restart nginx >/dev/null 2>&1 || true
  
  log_info "卸载完成。"
}

rollback_flow() {
  require_root
  
  local backup_dir="/var/backups/${APP_NAME}"
  if [ ! -d "${backup_dir}" ]; then
    fail_with_tip "未找到备份目录: ${backup_dir}"
  fi
  
  local latest_backup
  latest_backup="$(ls -t "${backup_dir}/backup_"*.tar.gz 2>/dev/null | head -n 1)"
  
  if [ -z "${latest_backup}" ]; then
    fail_with_tip "没有找到可用的备份文件"
  fi
  
  log_info "发现最近的备份: ${latest_backup}"
  if ! confirm_twice "确定要回滚到此版本吗？"; then
    echo "取消回滚。"
    exit 0
  fi
  
  log_info "正在回滚..."
  systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
  
  # 清理当前安装目录 (保留配置和数据可能更好，但全量回滚更安全)
  # 这里选择覆盖解压
  tar -xzf "${latest_backup}" -C "/"
  
  # 恢复权限
  chown -R "${APP_USER}:${APP_USER}" "${INSTALL_DIR}"
  
  systemctl restart "${SERVICE_NAME}"
  log_info "回滚完成，服务已重启"
}

# ==========================================
# 主入口
# ==========================================

case "${MODE}" in
  install)
    install_flow
    ;;
  uninstall)
    uninstall_flow
    ;;
  rollback)
    rollback_flow
    ;;
  *)
    echo "用法: $0 [install|uninstall|rollback]"
    exit 1
    ;;
esac
