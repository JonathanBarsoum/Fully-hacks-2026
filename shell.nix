{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShell {
  packages = [
    pkgs.libgcc
    pkgs.pkg-config
    pkgs.git
    pkgs.neovim
    pkgs.nodejs_22
    #pkgs.jdk17
    #pkgs.watchman
    #pkgs.android-tools
    #pkgs.android
    pkgs.gh
    pkgs.ripgrep
    pkgs.curl
    pkgs.python3
    pkgs.python3Packages.pip
    pkgs.python3Packages.virtualenv
    pkgs.rustc
    pkgs.cargo
    pkgs.vimPlugins.nvchad
    
  ];

  shellHook = ''
    if [ ! -d .venv ]; then
      python -m venv .venv
    fi
    source .venv/bin/activate

    # Optional: load local env vars (ex: ARCGIS_API_KEY) without committing secrets.
    if [ -f .env ]; then
      set -a
      source .env
      set +a
    fi

    echo "always remember to fuck justin over"
  '';
}  
.overrideAttrs (old: {
  buildInputs = (old.buildInputs or []) ++ [
    pkgs.python3Packages.requests
  ];

  shellHook = ''
    # Create a venv that can import Nix-provided Python dependencies (ex: requests).
    if [ ! -d .venv ]; then
      python -m venv --system-site-packages .venv
    elif ! grep -q '^include-system-site-packages = true$' .venv/pyvenv.cfg 2>/dev/null; then
      echo "Recreating .venv with --system-site-packages to access Nix Python deps..."
      rm -rf .venv
      python -m venv --system-site-packages .venv
    fi
    source .venv/bin/activate

    # Optional: load local env vars (ex: ARCGIS_API_KEY) without committing secrets.
    if [ -f .env ]; then
      set -a
      source .env
      set +a
    fi
  '';
})
