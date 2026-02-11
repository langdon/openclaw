#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
EXTRA_COMPOSE_FILE="$ROOT_DIR/docker-compose.extra.yml"
IMAGE_NAME="${OPENCLAW_IMAGE:-openclaw:local}"
EXTRA_MOUNTS="${OPENCLAW_EXTRA_MOUNTS:-}"
HOME_VOLUME_NAME="${OPENCLAW_HOME_VOLUME:-}"
ENGINE_SETTING="${OPENCLAW_CONTAINER_ENGINE:-}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

CONTAINER_ENGINE=""
if [[ -n "$ENGINE_SETTING" ]]; then
  case "$ENGINE_SETTING" in
    docker | podman) CONTAINER_ENGINE="$ENGINE_SETTING" ;;
    *)
      echo "OPENCLAW_CONTAINER_ENGINE must be 'docker' or 'podman' (got: $ENGINE_SETTING)" >&2
      exit 1
      ;;
  esac
elif command -v docker >/dev/null 2>&1; then
  CONTAINER_ENGINE="docker"
elif command -v podman >/dev/null 2>&1; then
  CONTAINER_ENGINE="podman"
else
  echo "Missing dependency: docker or podman" >&2
  exit 1
fi

require_cmd "$CONTAINER_ENGINE"

COMPOSE_CMD=()
COMPOSE_HINT=""
if [[ "$CONTAINER_ENGINE" == "docker" ]]; then
  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose not available (try: docker compose version)" >&2
    exit 1
  fi
  COMPOSE_CMD=(docker compose)
  COMPOSE_HINT="docker compose"
else
  if podman compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(podman compose)
    COMPOSE_HINT="podman compose"
  elif command -v podman-compose >/dev/null 2>&1; then
    COMPOSE_CMD=(podman-compose)
    COMPOSE_HINT="podman-compose"
  else
    echo "Podman Compose not available (install podman compose plugin or podman-compose)" >&2
    exit 1
  fi
fi

OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}"
OPENCLAW_BIND_MOUNT_OPTIONS="${OPENCLAW_BIND_MOUNT_OPTIONS:-}"

if [[ -z "$OPENCLAW_BIND_MOUNT_OPTIONS" && "$CONTAINER_ENGINE" == "podman" ]]; then
  os_name="$(uname -s 2>/dev/null || echo unknown)"
  if [[ "$os_name" == "Linux" ]]; then
    selinux_mode=""
    if command -v getenforce >/dev/null 2>&1; then
      selinux_mode="$(getenforce 2>/dev/null || true)"
    fi
    if [[ "$selinux_mode" == "Enforcing" || "$selinux_mode" == "Permissive" ]]; then
      OPENCLAW_BIND_MOUNT_OPTIONS=":Z"
    fi
  fi
fi

mkdir -p "$OPENCLAW_CONFIG_DIR"
mkdir -p "$OPENCLAW_WORKSPACE_DIR"

export OPENCLAW_CONFIG_DIR
export OPENCLAW_WORKSPACE_DIR
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
export OPENCLAW_BRIDGE_PORT="${OPENCLAW_BRIDGE_PORT:-18790}"
export OPENCLAW_GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-lan}"
export OPENCLAW_IMAGE="$IMAGE_NAME"
export OPENCLAW_DOCKER_APT_PACKAGES="${OPENCLAW_DOCKER_APT_PACKAGES:-}"
export OPENCLAW_EXTRA_MOUNTS="$EXTRA_MOUNTS"
export OPENCLAW_HOME_VOLUME="$HOME_VOLUME_NAME"
export OPENCLAW_CONTAINER_ENGINE="$CONTAINER_ENGINE"
export OPENCLAW_BIND_MOUNT_OPTIONS="$OPENCLAW_BIND_MOUNT_OPTIONS"

if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 32)"
  else
    OPENCLAW_GATEWAY_TOKEN="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
  fi
fi
export OPENCLAW_GATEWAY_TOKEN

COMPOSE_FILES=("$COMPOSE_FILE")
COMPOSE_ARGS=()

write_extra_compose() {
  local home_volume="$1"
  shift
  local mount
  local home_mount

  cat >"$EXTRA_COMPOSE_FILE" <<'YAML'
services:
  openclaw-gateway:
    volumes:
YAML

  if [[ -n "$home_volume" ]]; then
    home_mount="${home_volume}:/home/node"
    if [[ "$home_volume" == *"/"* ]]; then
      home_mount+="$OPENCLAW_BIND_MOUNT_OPTIONS"
    fi
    printf '      - %s\n' "$home_mount" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s:/home/node/.openclaw%s\n' "$OPENCLAW_CONFIG_DIR" "$OPENCLAW_BIND_MOUNT_OPTIONS" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s:/home/node/.openclaw/workspace%s\n' "$OPENCLAW_WORKSPACE_DIR" "$OPENCLAW_BIND_MOUNT_OPTIONS" >>"$EXTRA_COMPOSE_FILE"
  fi

  for mount in "$@"; do
    printf '      - %s\n' "$mount" >>"$EXTRA_COMPOSE_FILE"
  done

  cat >>"$EXTRA_COMPOSE_FILE" <<'YAML'
  openclaw-cli:
    volumes:
YAML

  if [[ -n "$home_volume" ]]; then
    home_mount="${home_volume}:/home/node"
    if [[ "$home_volume" == *"/"* ]]; then
      home_mount+="$OPENCLAW_BIND_MOUNT_OPTIONS"
    fi
    printf '      - %s\n' "$home_mount" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s:/home/node/.openclaw%s\n' "$OPENCLAW_CONFIG_DIR" "$OPENCLAW_BIND_MOUNT_OPTIONS" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s:/home/node/.openclaw/workspace%s\n' "$OPENCLAW_WORKSPACE_DIR" "$OPENCLAW_BIND_MOUNT_OPTIONS" >>"$EXTRA_COMPOSE_FILE"
  fi

  for mount in "$@"; do
    printf '      - %s\n' "$mount" >>"$EXTRA_COMPOSE_FILE"
  done

  if [[ -n "$home_volume" && "$home_volume" != *"/"* ]]; then
    cat >>"$EXTRA_COMPOSE_FILE" <<YAML
volumes:
  ${home_volume}:
YAML
  fi
}

VALID_MOUNTS=()
if [[ -n "$EXTRA_MOUNTS" ]]; then
  IFS=',' read -r -a mounts <<<"$EXTRA_MOUNTS"
  for mount in "${mounts[@]}"; do
    mount="${mount#"${mount%%[![:space:]]*}"}"
    mount="${mount%"${mount##*[![:space:]]}"}"
    if [[ -n "$mount" ]]; then
      VALID_MOUNTS+=("$mount")
    fi
  done
fi

if [[ -n "$HOME_VOLUME_NAME" || ${#VALID_MOUNTS[@]} -gt 0 ]]; then
  # Bash 3.2 + nounset treats "${array[@]}" on an empty array as unbound.
  if [[ ${#VALID_MOUNTS[@]} -gt 0 ]]; then
    write_extra_compose "$HOME_VOLUME_NAME" "${VALID_MOUNTS[@]}"
  else
    write_extra_compose "$HOME_VOLUME_NAME"
  fi
  COMPOSE_FILES+=("$EXTRA_COMPOSE_FILE")
fi
for compose_file in "${COMPOSE_FILES[@]}"; do
  COMPOSE_ARGS+=("-f" "$compose_file")
done
for compose_file in "${COMPOSE_FILES[@]}"; do
  COMPOSE_HINT+=" -f ${compose_file}"
done

ENV_FILE="$ROOT_DIR/.env"
upsert_env() {
  local file="$1"
  shift
  local -a keys=("$@")
  local tmp
  tmp="$(mktemp)"
  # Use a delimited string instead of an associative array so the script
  # works with Bash 3.2 (macOS default) which lacks `declare -A`.
  local seen=" "

  if [[ -f "$file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      local key="${line%%=*}"
      local replaced=false
      for k in "${keys[@]}"; do
        if [[ "$key" == "$k" ]]; then
          printf '%s=%s\n' "$k" "${!k-}" >>"$tmp"
          seen="$seen$k "
          replaced=true
          break
        fi
      done
      if [[ "$replaced" == false ]]; then
        printf '%s\n' "$line" >>"$tmp"
      fi
    done <"$file"
  fi

  for k in "${keys[@]}"; do
    if [[ "$seen" != *" $k "* ]]; then
      printf '%s=%s\n' "$k" "${!k-}" >>"$tmp"
    fi
  done

  mv "$tmp" "$file"
}

upsert_env "$ENV_FILE" \
  OPENCLAW_CONFIG_DIR \
  OPENCLAW_WORKSPACE_DIR \
  OPENCLAW_GATEWAY_PORT \
  OPENCLAW_BRIDGE_PORT \
  OPENCLAW_GATEWAY_BIND \
  OPENCLAW_GATEWAY_TOKEN \
  OPENCLAW_IMAGE \
  OPENCLAW_EXTRA_MOUNTS \
  OPENCLAW_HOME_VOLUME \
  OPENCLAW_DOCKER_APT_PACKAGES \
  OPENCLAW_CONTAINER_ENGINE \
  OPENCLAW_BIND_MOUNT_OPTIONS

echo "==> Building ${CONTAINER_ENGINE} image: $IMAGE_NAME"
"$CONTAINER_ENGINE" build \
  --build-arg "OPENCLAW_DOCKER_APT_PACKAGES=${OPENCLAW_DOCKER_APT_PACKAGES}" \
  -t "$IMAGE_NAME" \
  -f "$ROOT_DIR/Dockerfile" \
  "$ROOT_DIR"

echo ""
echo "==> Onboarding (interactive)"
echo "When prompted:"
echo "  - Gateway bind: lan"
echo "  - Gateway auth: token"
echo "  - Gateway token: $OPENCLAW_GATEWAY_TOKEN"
echo "  - Tailscale exposure: Off"
echo "  - Install Gateway daemon: No"
echo ""
"${COMPOSE_CMD[@]}" "${COMPOSE_ARGS[@]}" run --rm openclaw-cli onboard --no-install-daemon

echo ""
echo "==> Provider setup (optional)"
echo "WhatsApp (QR):"
echo "  ${COMPOSE_HINT} run --rm openclaw-cli channels login"
echo "Telegram (bot token):"
echo "  ${COMPOSE_HINT} run --rm openclaw-cli channels add --channel telegram --token <token>"
echo "Discord (bot token):"
echo "  ${COMPOSE_HINT} run --rm openclaw-cli channels add --channel discord --token <token>"
echo "Docs: https://docs.openclaw.ai/channels"

echo ""
echo "==> Starting gateway"
"${COMPOSE_CMD[@]}" "${COMPOSE_ARGS[@]}" up -d openclaw-gateway

echo ""
echo "Gateway running with host port mapping."
echo "Access from tailnet devices via the host's tailnet IP."
echo "Config: $OPENCLAW_CONFIG_DIR"
echo "Workspace: $OPENCLAW_WORKSPACE_DIR"
echo "Token: $OPENCLAW_GATEWAY_TOKEN"
echo ""
echo "Commands:"
echo "  ${COMPOSE_HINT} logs -f openclaw-gateway"
echo "  ${COMPOSE_HINT} exec openclaw-gateway node dist/index.js health --token \"$OPENCLAW_GATEWAY_TOKEN\""
