#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# AI Mind Map — One-line installer for macOS / Linux
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/shdra06/ai-mind-map/main/install.sh | bash
#
#   Or with options:
#   bash install.sh --install-dir ~/my-tools/ai-mind-map --skip-config
#
# Flags:
#   --install-dir <path>   Custom install directory (default: ~/.ai-mind-map)
#   --skip-config          Skip AI agent auto-configuration
#   --update               Force update mode (git pull + rebuild)
#   --help                 Show this help message
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────────────
REPO_URL="https://github.com/shdra06/ai-mind-map.git"
MIN_NODE_MAJOR=18
ENTRY_POINT="dist/index.js"
INSTALL_DIR="${HOME}/.ai-mind-map"
SKIP_CONFIG=false
FORCE_UPDATE=false

# ── Colors ───────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    BLUE='\033[0;34m'
    CYAN='\033[0;36m'
    WHITE='\033[1;37m'
    GRAY='\033[0;90m'
    NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' BLUE='' CYAN='' WHITE='' GRAY='' NC=''
fi

# ── Banner ───────────────────────────────────────────────────────────────────
show_banner() {
    echo -e "${CYAN}"
    cat << 'EOF'

     █████╗ ██╗    ███╗   ███╗██╗███╗   ██╗██████╗     ███╗   ███╗ █████╗ ██████╗
    ██╔══██╗██║    ████╗ ████║██║████╗  ██║██╔══██╗    ████╗ ████║██╔══██╗██╔══██╗
    ███████║██║    ██╔████╔██║██║██╔██╗ ██║██║  ██║    ██╔████╔██║███████║██████╔╝
    ██╔══██║██║    ██║╚██╔╝██║██║██║╚██╗██║██║  ██║    ██║╚██╔╝██║██╔══██║██╔═══╝
    ██║  ██║██║    ██║ ╚═╝ ██║██║██║ ╚████║██████╔╝    ██║ ╚═╝ ██║██║  ██║██║
    ╚═╝  ╚═╝╚═╝    ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═════╝     ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝

    MCP Server — Reduce AI token usage by 80-99%
    https://github.com/shdra06/ai-mind-map

EOF
    echo -e "${NC}"
}

# ── Helpers ──────────────────────────────────────────────────────────────────
step()  { echo -e "  ${BLUE}[*]${NC} $1"; }
ok()    { echo -e "  ${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "  ${YELLOW}[!]${NC} $1"; }
err()   { echo -e "  ${RED}[✗]${NC} $1"; }
die()   { err "$1"; exit 1; }

command_exists() { command -v "$1" &>/dev/null; }

# ── Parse Arguments ─────────────────────────────────────────────────────────
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --install-dir)
                INSTALL_DIR="$2"
                shift 2
                ;;
            --skip-config)
                SKIP_CONFIG=true
                shift
                ;;
            --update)
                FORCE_UPDATE=true
                shift
                ;;
            --help|-h)
                echo "Usage: install.sh [--install-dir <path>] [--skip-config] [--update]"
                echo ""
                echo "Options:"
                echo "  --install-dir <path>   Custom install directory (default: ~/.ai-mind-map)"
                echo "  --skip-config          Skip AI agent auto-configuration"
                echo "  --update               Force update mode"
                echo "  --help                 Show this help message"
                exit 0
                ;;
            *)
                die "Unknown option: $1 (use --help for usage)"
                ;;
        esac
    done
}

# ── Pre-flight Checks ───────────────────────────────────────────────────────
assert_prerequisites() {
    echo -e "\n  ${WHITE}Checking prerequisites...${NC}"

    # Node.js
    if ! command_exists node; then
        die "Node.js is not installed.\n  Install via: https://nodejs.org or use nvm:\n    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash\n    nvm install ${MIN_NODE_MAJOR}"
    fi

    local node_version
    node_version=$(node --version 2>/dev/null || echo "")
    local node_major
    node_major=$(echo "$node_version" | sed -n 's/^v\([0-9]*\)\..*/\1/p')

    if [[ -z "$node_major" ]]; then
        die "Could not determine Node.js version from: ${node_version}"
    fi

    if [[ "$node_major" -lt "$MIN_NODE_MAJOR" ]]; then
        die "Node.js v${MIN_NODE_MAJOR}+ is required. Found: ${node_version}\n  Update: https://nodejs.org or nvm install ${MIN_NODE_MAJOR}"
    fi
    ok "Node.js ${node_version}"

    # npm
    if ! command_exists npm; then
        die "npm is not installed. It should come with Node.js — try reinstalling Node."
    fi
    local npm_version
    npm_version=$(npm --version 2>/dev/null)
    ok "npm v${npm_version}"

    # Git
    if ! command_exists git; then
        die "Git is not installed.\n  Install via your package manager:\n    macOS:  brew install git\n    Ubuntu: sudo apt install git\n    Fedora: sudo dnf install git"
    fi
    local git_version
    git_version=$(git --version 2>/dev/null)
    ok "${git_version}"
}

# ── Install / Update ────────────────────────────────────────────────────────
install_ai_mind_map() {
    local is_existing=false
    [[ -d "${INSTALL_DIR}/.git" ]] && is_existing=true

    # Decide: fresh install or update
    if $is_existing && ! $FORCE_UPDATE; then
        warn "AI Mind Map is already installed at: ${INSTALL_DIR}"
        read -rp "  Update to latest version? (Y/n) " choice
        if [[ "$choice" =~ ^[Nn] ]]; then
            echo -e "\n  ${GRAY}Installation cancelled.${NC}"
            exit 0
        fi
        FORCE_UPDATE=true
    fi

    if $FORCE_UPDATE && $is_existing; then
        # ── Update ───────────────────────────────────────────────────────
        echo -e "\n  ${WHITE}Updating AI Mind Map...${NC}"
        step "Pulling latest changes..."
        if ! git -C "${INSTALL_DIR}" pull --ff-only 2>/dev/null; then
            warn "Fast-forward pull failed. Trying git pull --rebase..."
            if ! git -C "${INSTALL_DIR}" pull --rebase; then
                die "Git pull failed. You may have local changes.\n  Resolve manually in: ${INSTALL_DIR}"
            fi
        fi
        ok "Repository updated"
    else
        # ── Fresh install ────────────────────────────────────────────────
        echo -e "\n  ${WHITE}Installing AI Mind Map...${NC}"
        step "Cloning repository to: ${INSTALL_DIR}"
        if [[ -d "$INSTALL_DIR" ]]; then
            warn "Directory exists but is not a git repo. Removing..."
            rm -rf "$INSTALL_DIR"
        fi
        if ! git clone "$REPO_URL" "$INSTALL_DIR"; then
            die "Failed to clone repository.\n  Check your internet connection and try again."
        fi
        ok "Repository cloned"
    fi

    # ── Install dependencies ─────────────────────────────────────────────
    step "Installing dependencies (this may take a minute)..."
    if ! (cd "$INSTALL_DIR" && npm install --legacy-peer-deps); then
        die "npm install failed. Check the output above for errors."
    fi
    ok "Dependencies installed"

    # ── Build ────────────────────────────────────────────────────────────
    step "Building TypeScript..."
    if ! (cd "$INSTALL_DIR" && npx tsc); then
        die "TypeScript build failed. Check the output above for errors."
    fi
    ok "Build complete"

    # ── Verify build ─────────────────────────────────────────────────────
    if [[ ! -f "${INSTALL_DIR}/${ENTRY_POINT}" ]]; then
        die "Build verification failed: ${ENTRY_POINT} not found.\n  Please report: https://github.com/shdra06/ai-mind-map/issues"
    fi
    ok "Build verified (${ENTRY_POINT} exists)"

    # ── Symlink / PATH ───────────────────────────────────────────────────
    create_symlink

    # ── Agent configuration ──────────────────────────────────────────────
    if ! $SKIP_CONFIG; then
        configure_agents
    fi

    # ── Done ─────────────────────────────────────────────────────────────
    show_success
}

# ── Symlink ──────────────────────────────────────────────────────────────────
create_symlink() {
    local bin_dir=""
    local link_path=""

    # Prefer /usr/local/bin if writable, otherwise ~/bin or ~/.local/bin
    if [[ -d "/usr/local/bin" && -w "/usr/local/bin" ]]; then
        bin_dir="/usr/local/bin"
    elif [[ -d "${HOME}/.local/bin" ]]; then
        bin_dir="${HOME}/.local/bin"
    elif [[ -d "${HOME}/bin" ]]; then
        bin_dir="${HOME}/bin"
    else
        # Create ~/.local/bin
        bin_dir="${HOME}/.local/bin"
        mkdir -p "$bin_dir"
    fi

    link_path="${bin_dir}/ai-mind-map"

    # Create a wrapper script instead of a direct symlink (more portable)
    cat > "${link_path}" << WRAPPER
#!/usr/bin/env bash
exec node "${INSTALL_DIR}/${ENTRY_POINT}" "\$@"
WRAPPER
    chmod +x "${link_path}"
    ok "Created wrapper: ${link_path}"

    # Check if bin_dir is in PATH
    if [[ ":${PATH}:" != *":${bin_dir}:"* ]]; then
        warn "${bin_dir} is not in your PATH."
        local shell_rc=""
        if [[ -f "${HOME}/.zshrc" ]]; then
            shell_rc="${HOME}/.zshrc"
        elif [[ -f "${HOME}/.bashrc" ]]; then
            shell_rc="${HOME}/.bashrc"
        elif [[ -f "${HOME}/.bash_profile" ]]; then
            shell_rc="${HOME}/.bash_profile"
        fi

        if [[ -n "$shell_rc" ]]; then
            local path_line="export PATH=\"${bin_dir}:\$PATH\""
            if ! grep -qF "$bin_dir" "$shell_rc" 2>/dev/null; then
                echo "" >> "$shell_rc"
                echo "# AI Mind Map" >> "$shell_rc"
                echo "$path_line" >> "$shell_rc"
                ok "Added ${bin_dir} to PATH in ${shell_rc}"
                warn "Run 'source ${shell_rc}' or restart your terminal."
            fi
        else
            warn "Add this to your shell profile: export PATH=\"${bin_dir}:\$PATH\""
        fi
    fi
}

# ── Agent Auto-Configuration ────────────────────────────────────────────────
configure_agents() {
    echo -e "\n  ${WHITE}Detecting AI agents...${NC}"

    local agents=()

    # Claude Desktop
    local claude_mac="${HOME}/Library/Application Support/Claude/claude_desktop_config.json"
    local claude_linux="${HOME}/.config/Claude/claude_desktop_config.json"
    [[ -f "$claude_mac" || -f "$claude_linux" ]] && agents+=("Claude Desktop")

    # Claude Code
    [[ -d "${HOME}/.claude" ]] && agents+=("Claude Code")

    # Cursor
    [[ -d "${HOME}/.cursor" ]] && agents+=("Cursor")

    # VS Code
    [[ -d "${HOME}/.config/Code/User" || -d "${HOME}/Library/Application Support/Code/User" ]] && agents+=("VS Code")

    if [[ ${#agents[@]} -eq 0 ]]; then
        warn "No AI agents detected. See README for manual setup."
        return
    fi

    ok "Detected: $(IFS=', '; echo "${agents[*]}")"
    echo ""
    echo -e "  ${WHITE}To configure an agent, add this to its MCP config:${NC}"
    echo -e "${GRAY}"
    cat << CONFEOF

    {
      "mcpServers": {
        "ai-mind-map": {
          "command": "node",
          "args": [
            "${INSTALL_DIR}/${ENTRY_POINT}",
            "--project-root",
            "<YOUR_PROJECT_PATH>"
          ]
        }
      }
    }

CONFEOF
    echo -e "${NC}"
}

# ── Success ──────────────────────────────────────────────────────────────────
show_success() {
    echo ""
    echo -e "  ${GREEN}────────────────────────────────────────────────────────────${NC}"
    echo -e "  ${GREEN}✅  AI Mind Map installed successfully!${NC}"
    echo -e "  ${GREEN}────────────────────────────────────────────────────────────${NC}"
    echo ""
    echo -e "  ${WHITE}Location:${NC}  ${INSTALL_DIR}"
    echo ""
    echo -e "  ${WHITE}Next steps:${NC}"
    echo -e "  ${GRAY}  1. Configure your AI agent (see above or README)${NC}"
    echo -e "  ${GRAY}  2. Test with:  node \"${INSTALL_DIR}/${ENTRY_POINT}\" --project-root .${NC}"
    echo -e "  ${GRAY}  3. Star the repo: https://github.com/shdra06/ai-mind-map${NC}"
    echo ""
    echo -e "  ${YELLOW}To update later:  bash install.sh --update${NC}"
    echo -e "  ${YELLOW}Full docs:        https://github.com/shdra06/ai-mind-map#readme${NC}"
    echo ""
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
    parse_args "$@"
    show_banner
    assert_prerequisites
    install_ai_mind_map
}

main "$@"
