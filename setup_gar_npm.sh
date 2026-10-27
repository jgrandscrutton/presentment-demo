#!/usr/bin/env bash
# setup_gar_npm.sh
# Local developer setup for NPM -> Google Artifact Registry (GAR), based on
# "NPM Onboarding User Guide & FAQ" (DEVCORE Confluence).
# Covers: backup, gcloud auth, .npmrc generation, @paypalcorp scope,
# auto token refresh (google-artifactregistry-auth + shell wrapper), audit=false.
# For macOS / Linux / WSL / Git Bash. NOT for CI/CD pipelines.

set -euo pipefail

PROJECT="d-glbl-dpe-mgmt"
LOCATION="us-central1"
REPO="npm-all"
REGISTRY="https://${LOCATION}-npm.pkg.dev/${PROJECT}/${REPO}/"
AUTH_KEY="//${LOCATION}-npm.pkg.dev/${PROJECT}/${REPO}/:_authToken"
NPMRC="$HOME/.npmrc"
STAMP="$(date +%Y%m%d-%H%M%S)"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }

# --- 1. Backups --------------------------------------------------------------
say "Backing up existing config"
touch "$NPMRC"
cp "$NPMRC" "$NPMRC.bak-$STAMP"
echo "Backed up ~/.npmrc -> ~/.npmrc.bak-$STAMP"
if [ -f package-lock.json ]; then
  cp package-lock.json "package-lock.json.bak-$STAMP"
  echo "Backed up ./package-lock.json -> package-lock.json.bak-$STAMP"
fi

# --- 2. gcloud ---------------------------------------------------------------
if ! command -v gcloud >/dev/null 2>&1; then
  if [[ "$(uname)" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    say "Installing Google Cloud SDK via Homebrew"
    brew install --cask google-cloud-sdk
  else
    warn "gcloud not found. Install it: https://cloud.google.com/sdk/docs/install"
    exit 1
  fi
fi

say "Authenticating with GCP (choose your corpid@paypal.com account, NOT a personal one)"
gcloud auth login
gcloud config set project "$PROJECT"

say "Setting up Application Default Credentials (used for auto token refresh)"
gcloud auth application-default login

# --- 3. .npmrc ---------------------------------------------------------------
say "Configuring ~/.npmrc"
# Comment out old (e.g. JFrog) registry lines so they don't conflict
sed -i.tmp -E '/npm\.pkg\.dev/! s/^([[:space:]]*(@[^:]+:)?registry=.*)$/# (pre-GAR) \1/' "$NPMRC"
rm -f "$NPMRC.tmp"

if ! grep -q "^registry=.*npm.pkg.dev/${PROJECT}/${REPO}" "$NPMRC"; then
  gcloud artifacts print-settings npm \
    --project="$PROJECT" --repository="$REPO" --location="$LOCATION" \
    | grep -v always-auth >> "$NPMRC"
fi

npm config set @paypalcorp:registry "$REGISTRY"
npm config set audit false   # GAR doesn't support the npm audit endpoint

# --- 4. Auto token refresh ---------------------------------------------------
say "Bootstrapping token and installing google-artifactregistry-auth"
npm config set "$AUTH_KEY" "$(gcloud auth print-access-token)"
npm install -g google-artifactregistry-auth
npm config set "$AUTH_KEY" ""

say "Writing ~/.paypal_gar_auth.sh shell wrapper"
cat > "$HOME/.paypal_gar_auth.sh" <<'EOF'
function npm {
  case "$*" in
    install*|publish*|update*|ci*|add*|i\ *)
      if grep -q "npm.pkg.dev" ~/.npmrc 2>/dev/null; then
        artifactregistry-auth --repo-config ~/.npmrc 2>/dev/null
      fi
      ;;
  esac
  command npm "$@"
}
function npx {
  if grep -q "npm.pkg.dev" ~/.npmrc 2>/dev/null; then
    artifactregistry-auth --repo-config ~/.npmrc 2>/dev/null
  fi
  command npx "$@"
}
function pnpm {
  case "$*" in
    install*|publish*|update*|ci*|add*|i\ *)
      if grep -q "npm.pkg.dev" ~/.npmrc 2>/dev/null; then
        artifactregistry-auth --repo-config ~/.npmrc 2>/dev/null
      fi
      ;;
  esac
  command pnpm "$@"
}
EOF

# Pick the right profile file
case "$(basename "${SHELL:-bash}")" in
  zsh)  PROFILE="$HOME/.zshrc" ;;
  bash) if [[ "$(uname)" == "Darwin" ]]; then PROFILE="$HOME/.bash_profile"; else PROFILE="$HOME/.bashrc"; fi ;;
  *)    PROFILE="$HOME/.profile" ;;
esac
SOURCE_LINE='[ -f ~/.paypal_gar_auth.sh ] && source ~/.paypal_gar_auth.sh'
touch "$PROFILE"
grep -qxF "$SOURCE_LINE" "$PROFILE" || echo "$SOURCE_LINE" >> "$PROFILE"
echo "Added wrapper to $PROFILE"

# --- 5. Verify ---------------------------------------------------------------
say "Fetching a fresh token and verifying access"
artifactregistry-auth --repo-config "$NPMRC"
if npm view lodash version --registry="$REGISTRY" >/dev/null 2>&1; then
  echo "✅ GAR registry reachable and authenticated."
else
  warn "Verification failed. Check you have PP_GCP_DEV_CONSOLE_USER_ACCOUNT in MyAccess (propagation can take ~1h), or ask in #gar-npm-migration."
fi

cat <<MSG

Done. Next steps:
  1. Run:  source $PROFILE   (or open a new terminal)
  2. In each project: delete package-lock.json and run 'npm install' to regenerate it
     against GAR (backup was made if one existed here).
  3. For Claude/Codex or other tools that spawn their own shells, run once a day:
       artifactregistry-auth --repo-config ~/.npmrc
MSG