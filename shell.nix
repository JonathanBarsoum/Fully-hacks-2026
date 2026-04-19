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
