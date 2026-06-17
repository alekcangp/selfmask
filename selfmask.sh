#!/usr/bin/env bash

set -e

APP_NAME="selfmask"
APP_DIR="${APP_DIR:-/opt/caddy}"
HTML_DIR="$APP_DIR/html"
LOG_FILE="/var/log/selfmask.log"
DEFAULT_PORT="${DEFAULT_PORT:-9443}"
CADDY_VERSION="2.11.4"

[ -z "$HOME" ] && HOME=$(getent passwd "$(id -u)" | cut -d: -f6)
[ "$(id -u)" = "0" ] && HOME="/root"
ACME_HOME="${ACME_HOME:-$HOME/.acme.sh}"
ACME_PORT=""
ACME_FALLBACK_PORTS=(8443 9443 10443 18443 28443)

log_info() { echo -e "ℹ️  $*"; }
log_success() { echo -e "✅ $*"; }
log_warning() { echo -e "⚠️  $*" >&2; }
log_error() { echo -e "❌ $*" >&2; }

_apply_env_to_files() {
    local domain="$1"
    local port="$2"
    local script_dir="$3"

    local caddyfile="$script_dir/Caddyfile"
    local compose="$script_dir/docker-compose.yml"

    sed -i "s/{{SELF_MASK_DOMAIN}}/$domain/g" "$caddyfile"
    sed -i "s/{{SELF_MASK_PORT}}/$port/g" "$caddyfile"

    sed -i "s/{{SELF_MASK_DOMAIN}}/$domain/g" "$compose"
    sed -i "s/{{SELF_MASK_PORT}}/$port/g" "$compose"

    if grep -qE '^\s*- SELF_MASK_DOMAIN=' "$compose"; then
        sed -i "s|^- SELF_MASK_DOMAIN=.*|- SELF_MASK_DOMAIN=$domain|" "$compose"
    fi
    if grep -qE '^\s*- SELF_MASK_PORT=' "$compose"; then
        sed -i "s|^- SELF_MASK_PORT=.*|- SELF_MASK_PORT=$port|" "$compose"
    fi

    return 0
}

check_running_as_root() {
    if [ "${EUID:-$(id -u)}" -ne 0 ]; then
        log_error "This script must be run as root (use sudo)"
        exit 1
    fi
}

check_system_requirements() {
    if ! command -v docker >/dev/null 2>&1; then
        log_error "Docker is not installed"
        return 1
    fi
    log_success "Docker installed: $(docker --version | cut -d' ' -f3 | tr -d ',')"
    return 0
}

install_acme() {
    local install_email="${1:-}"

    if [ -z "$install_email" ]; then
        local timestamp
        timestamp=$(date +%s)
        install_email="user${timestamp}@example.org"
        log_info "Using auto-generated email: $install_email"
    fi

    if [ -f "$ACME_HOME/acme.sh" ]; then
        "$ACME_HOME/acme.sh" --set-default-ca --server letsencrypt >/dev/null 2>&1 || true
        rm -rf "$ACME_HOME/account.conf" "$ACME_HOME/ca" 2>/dev/null || true
        "$ACME_HOME/acme.sh" --register-account --email "$install_email" --force --insecure 2>&1 || true
        return 0
    fi

    log_info "Installing acme.sh..."

    local temp_script="/tmp/acme_install_$$.sh"
    curl -sS --connect-timeout 30 --max-time 60 https://get.acme.sh -o "$temp_script" >/dev/null 2>&1 || {
        rm -f "$temp_script"
        log_error "Failed to download acme.sh"
        return 1
    }

    sh "$temp_script" email="$install_email" >/dev/null 2>&1 || true
    rm -f "$temp_script"

    local acme_found=false
    for acme_path in "$ACME_HOME/acme.sh" "$HOME/.acme.sh/acme.sh" "/root/.acme.sh/acme.sh"; do
        if [ -f "$acme_path" ]; then
            ACME_HOME=$(dirname "$acme_path")
            rm -rf "$ACME_HOME/account.conf" "$ACME_HOME/ca" 2>/dev/null || true
            "$ACME_HOME/acme.sh" --set-default-ca --server letsencrypt >/dev/null 2>&1 || true
            "$ACME_HOME/acme.sh" --register-account --email "$install_email" --force --insecure 2>&1 || true
            acme_found=true
            break
        fi
    done

    if [ "$acme_found" = true ]; then
        log_success "acme.sh installed"
        return 0
    fi

    log_error "Failed to install acme.sh"
    return 1
}

install_socat() {
    if command -v socat >/dev/null 2>&1; then
        return 0
    fi

    log_info "Installing socat (required for certificate issuance)..."
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq && apt-get install -y -qq socat >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then
        yum install -y -q socat >/dev/null 2>&1 || true
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y -q socat >/dev/null 2>&1 || true
    elif command -v apk >/dev/null 2>&1; then
        apk add --quiet socat >/dev/null 2>&1 || true
    fi

    if command -v socat >/dev/null 2>&1; then
        log_success "socat installed"
        return 0
    fi

    log_error "Failed to install socat"
    return 1
}

find_available_acme_port() {
    local acme_ports=()
    
    if [ -n "$ACME_PORT" ]; then
        acme_ports+=("$ACME_PORT")
    fi
    acme_ports+=("443" "${ACME_FALLBACK_PORTS[@]}")

    for port in "${acme_ports[@]}"; do
        if ! ss -tlnp 2>/dev/null | grep -q ":$port "; then
            echo "$port"
            return 0
        fi
    done

    echo ""
    return 0
}

stop_existing_caddy() {
    [ "${SELF_MASK_KEEP_CADDY:-0}" = "1" ] && return 0

    log_info "Stopping existing Caddy processes so ACME can use HTTP/TLS challenge ports..."
    if command -v systemctl >/dev/null 2>&1; then
        systemctl stop caddy 2>/dev/null || true
    fi
    if command -v docker >/dev/null 2>&1; then
        docker rm -f upload-server upload-test caddy-selfmask 2>/dev/null || true
    fi
    if command -v pkill >/dev/null 2>&1; then
        pkill -x caddy 2>/dev/null || true
    fi
}

warn_if_challenge_ports_busy() {
    local busy=false

    if ss -tlnp 2>/dev/null | grep -q ':80 '; then
        log_warning "Port 80 is still occupied; acme.sh standalone mode may fail"
        busy=true
    fi

    if ss -tlnp 2>/dev/null | grep -q ':443 '; then
        log_warning "Port 443 is still occupied; acme.sh may use iptables redirect or fail"
        busy=true
    fi

    if [ "$busy" = true ]; then
        ss -tlnp 2>/dev/null | grep -E ':(80|443) ' || true
    fi
}

setup_iptables_redirect() {
    local target_port="$1"
    [ "$target_port" = "443" ] && return 0
    cleanup_iptables_redirect "$target_port"
    iptables -t nat -I PREROUTING 1 -p tcp --dport 443 -j REDIRECT --to-port "$target_port" 2>/dev/null || true
    iptables -t nat -I OUTPUT 1 -p tcp --dport 443 -o lo -j REDIRECT --to-port "$target_port" 2>/dev/null || true
}

cleanup_iptables_redirect() {
    local target_port="$1"
    [ "$target_port" = "443" ] && return 0
    iptables -t nat -D PREROUTING -p tcp --dport 443 -j REDIRECT --to-port "$target_port" 2>/dev/null || true
    iptables -t nat -D OUTPUT -p tcp --dport 443 -o lo -j REDIRECT --to-port "$target_port" 2>/dev/null || true
}

generate_self_signed_cert() {
    local ssl_dir="$1"
    local domain="$2"
    log_info "Generating self-signed SSL certificate for $domain..."
    mkdir -p "$ssl_dir"
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$ssl_dir/private.key" \
        -out "$ssl_dir/fullchain.crt" \
        -subj "/C=US/ST=State/L=City/O=Organization/CN=$domain" 2>/dev/null || {
        log_error "Failed to generate self-signed certificate"
        return 1
    }
    chmod 600 "$ssl_dir/private.key"
    chmod 644 "$ssl_dir/fullchain.crt"
    log_success "Self-signed certificate generated"
    return 0
}

issue_real_cert() {
    local domain="$1"
    local ssl_dir="$2"
    local email="${3:-}"

    if [ -f "$ssl_dir/private.key" ] && [ -f "$ssl_dir/fullchain.crt" ]; then
        log_info "Existing certificate found, skipping issuance"
        return 0
    fi

    set +e
    set +o pipefail 2>/dev/null || true

    if ! install_acme "$email"; then
        log_error "Cannot install acme.sh"
        set -e
        set -o pipefail 2>/dev/null || true
        return 1
    fi

    if ! install_socat; then
        log_error "Cannot install socat"
        set -e
        set -o pipefail 2>/dev/null || true
        return 1
    fi

    mkdir -p "$ssl_dir"

    stop_existing_caddy
    warn_if_challenge_ports_busy

    local acme_ports=()
    if [ -n "$ACME_PORT" ]; then
        acme_ports+=("$ACME_PORT")
    fi
    acme_ports+=("443" "${ACME_FALLBACK_PORTS[@]}")
    local success=0
    local try_port
    local rc

    for ((i=0; i<${#acme_ports[@]}; i++)); do
        try_port="${acme_ports[$i]}"
        log_info "Issuing certificate via TLS-ALPN on port $try_port (attempt $((i+1)))..."
        setup_iptables_redirect "$try_port"

        "$ACME_HOME/acme.sh" --issue \
            --standalone \
            -d "$domain" \
            --key-file "$ssl_dir/private.key" \
            --fullchain-file "$ssl_dir/fullchain.crt" \
            --alpn \
            --tlsport "$try_port" \
            --server letsencrypt \
            --force 2>&1 || \
        "$ACME_HOME/acme.sh" --issue \
            --standalone \
            -d "$domain" \
            --key-file "$ssl_dir/private.key" \
            --fullchain-file "$ssl_dir/fullchain.crt" \
            --alpn \
            --tlsport "$try_port" \
            --server letsencrypt-staging \
            --force 2>&1

        rc=$?
        cleanup_iptables_redirect "$try_port"

        if [ $rc -eq 0 ] && [ -f "$ssl_dir/private.key" ] && [ -f "$ssl_dir/fullchain.crt" ]; then
            chmod 600 "$ssl_dir/private.key"
            chmod 644 "$ssl_dir/fullchain.crt"
            log_success "Real SSL certificate issued for $domain (port $try_port)"
            success=1
            break
        fi
    done

    set -e
    set -o pipefail 2>/dev/null || true

    if [ "$success" -eq 1 ]; then
        return 0
    fi

    log_error "Failed to issue real certificate via acme.sh"
    log_info "Tried ports: ${acme_ports[*]}"
    return 1
}

setup_ssl_auto_renewal() {
    if [ ! -f "$ACME_HOME/acme.sh" ]; then
        log_warning "acme.sh not installed, skipping auto-renewal setup"
        return 1
    fi

    log_info "Setting up auto-renewal for SSL certificates..."

    local wrapper_script="$APP_DIR/acme-renew.sh"
    cat > "$wrapper_script" <<'WRAPPER_EOF'
#!/usr/bin/env bash
set -e
ACME_HOME="__ACME_HOME__"

tls_ports=()
for domain_conf in "$ACME_HOME"/*/[!.]*.conf; do
    [ -f "$domain_conf" ] || continue
    saved_port=$(grep "^Le_TLSPort=" "$domain_conf" 2>/dev/null | cut -d"'" -f2 | tr -d '"')
    if [ -n "$saved_port" ] && [ "$saved_port" != "443" ]; then
        already=false
        for p in "${tls_ports[@]}"; do
            [ "$p" = "$saved_port" ] && { already=true; break; }
        done
        [ "$already" = false ] && tls_ports+=("$saved_port")
    fi
done

for port in "${tls_ports[@]}"; do
    iptables -t nat -I PREROUTING 1 -p tcp --dport 443 -j REDIRECT --to-port "$port" 2>/dev/null || true
    iptables -t nat -I OUTPUT 1 -p tcp --dport 443 -o lo -j REDIRECT --to-port "$port" 2>/dev/null || true
done

"$ACME_HOME/acme.sh" --cron --home "$ACME_HOME" > /dev/null 2>&1
renew_exit=$?

for port in "${tls_ports[@]}"; do
    iptables -t nat -D PREROUTING -p tcp --dport 443 -j REDIRECT --to-port "$port" 2>/dev/null || true
    iptables -t nat -D OUTPUT -p tcp --dport 443 -o lo -j REDIRECT --to-port "$port" 2>/dev/null || true
done

exit $renew_exit
WRAPPER_EOF

    sed -i "s|__ACME_HOME__|$ACME_HOME|g" "$wrapper_script"
    chmod 700 "$wrapper_script"

    if crontab -l 2>/dev/null | grep -q "acme"; then
        crontab -l 2>/dev/null | grep -v "/acme-renew.sh" | crontab - 2>/dev/null || true
    fi

    (crontab -l 2>/dev/null; echo "0 0 * * * $wrapper_script") | crontab -
    log_success "Auto-renewal configured: cron at 0 0 * * * $wrapper_script"
    return 0
}

install() {
    local domain="${1:-localhost}"
    local port="${2:-$DEFAULT_PORT}"
    local caddy_email="${3:-}"

    check_running_as_root
    check_system_requirements || exit 1

    log_info "Installing Selfmask (CyberSpeed) for $domain:$port"

    mkdir -p "$APP_DIR" "$HTML_DIR" "$APP_DIR/logs" "$APP_DIR/ssl"

    local SCRIPT_DIR
    if [ -f "${BASH_SOURCE[0]}" ]; then
        SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    else
        SCRIPT_DIR="$APP_DIR"
    fi

    log_info "Copying template files..."
    cp -r "$SCRIPT_DIR/html" "$APP_DIR/" 2>/dev/null || true
    cp "$SCRIPT_DIR/server.js" "$APP_DIR/" 2>/dev/null || true
    cp "$SCRIPT_DIR/Caddyfile" "$APP_DIR/" 2>/dev/null || true
    cp "$SCRIPT_DIR/docker-compose.yml" "$APP_DIR/" 2>/dev/null || true
    cp "$SCRIPT_DIR/.env" "$APP_DIR/" 2>/dev/null || true
    cp "$SCRIPT_DIR/selfmask.sh" "$APP_DIR/" 2>/dev/null || true

    # Create .env file for Caddyfile variables
    cat > "$APP_DIR/.env" <<EOF
SELF_MASK_DOMAIN=$domain
SELF_MASK_PORT=$port
EOF

    _apply_env_to_files "$domain" "$port" "$APP_DIR"

    log_info "Requesting real SSL certificate for $domain via Let's Encrypt..."
    if issue_real_cert "$domain" "$APP_DIR/ssl" "$caddy_email"; then
        setup_ssl_auto_renewal
        log_success "Real certificate configured and auto-renewal enabled"
    else
        log_error "Failed to issue real certificate. Aborting installation."
        return 1
    fi

    cd "$APP_DIR"
    docker compose down 2>/dev/null || true
    log_info "Starting containers..."
    docker rm -f upload-test caddy-selfmask 2>/dev/null || true
    docker compose up --force-recreate -d

    chmod +x "$APP_DIR/selfmask.sh" 2>/dev/null || true
    ln -sf "$APP_DIR/selfmask.sh" /usr/local/bin/selfmask 2>/dev/null || true

    log_success "Installation complete!"
    echo "📌 Access: https://$domain (via Reality to 127.0.0.1:$port)"
    echo "🔐 Certificate: $APP_DIR/ssl/fullchain.crt"
}

[ $# -gt 0 ] && [ "$1" = "@" ] && shift

COMMAND="${1:-}"
DOMAIN="${2:-localhost}"
PORT="${3:-$DEFAULT_PORT}"

case "$COMMAND" in
    install)
        install "$DOMAIN" "$PORT" "${4:-}"
        ;;
    *)
        echo "Usage: sudo bash $0 install [DOMAIN] [PORT] [CADDY_EMAIL]"
        echo "Example: sudo bash $0 install dza.mooo.com 9443 admin@example.com"
        echo ""
        echo "Or after install: sudo selfmask install DOMAIN PORT"
        echo "Quick install: curl -fsSL https://example.com/selfmask.sh | sudo bash -s install DOMAIN PORT"
        ;;
esac
