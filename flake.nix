{
  description = "Independent Node 26 / Gmsh / Elmer thermal simulation MCP";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    elmer.url = "github:ElmerCSC/elmerfem/release-26.2.1";
  };
  outputs = { nixpkgs, elmer, ... }:
    let
      systems = [ "x86_64-linux" ];
      eachSystem = nixpkgs.lib.genAttrs systems;
      toolsFor = system:
        let pkgs = nixpkgs.legacyPackages.${system}; in {
          inherit pkgs;
          solver = elmer.packages.${system}.default.overrideAttrs (old: {
            cmakeFlags = (old.cmakeFlags or [ ]) ++ [
              "-DWITH_MPI:BOOL=OFF"
              "-DWITH_OpenMP:BOOL=OFF"
              "-DWITH_ElmerIce:BOOL=OFF"
              "-DWITH_LUA:BOOL=OFF"
            ];
          });
          python = pkgs.writeShellScriptBin "simulation-python" ''
            export PYTHONPATH="${pkgs.gmsh}/lib''${PYTHONPATH:+:$PYTHONPATH}"
            exec ${pkgs.python3}/bin/python3 "$@"
          '';
        };
    in
    {
      packages = eachSystem (system:
        let t = toolsFor system; in {
          toolchain = t.pkgs.symlinkJoin {
            name = "simulation-toolchain";
            paths = [ t.pkgs.nodejs_26 t.pkgs.gmsh t.python t.solver ];
          };
        });
      devShells = eachSystem (system:
        let t = toolsFor system; in {
          checks = t.pkgs.mkShell {
            packages = with t.pkgs; [ just nodejs_26 python3 ruff nixpkgs-fmt ];
            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
            '';
          };
          default = t.pkgs.mkShell {
            packages = with t.pkgs; [ just nodejs_26 python3 gmsh ruff nil nixpkgs-fmt ] ++ [ t.python t.solver ];
            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
              export PYTHONPATH="${t.pkgs.gmsh}/lib''${PYTHONPATH:+:$PYTHONPATH}"
              export SIMULATION_PYTHON="${t.python}/bin/simulation-python"
              export SIMULATION_ELMERGRID="${t.solver}/bin/ElmerGrid"
              export SIMULATION_ELMERSOLVER="${t.solver}/bin/ElmerSolver"
            '';
          };
        });
    };
}
