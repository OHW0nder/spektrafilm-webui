#!/usr/bin/env bash
# Fetch the pinned spektrafilm-rs source and build the GPU CLI used for previews.
#
# The binary is built on the host (not in the image) because the crate graph is
# ~100 MB and this machine's link to crates.io is slow. Re-run after changing
# RS_COMMIT, then rebuild the container.
set -euo pipefail

RS_REPO="${RS_REPO:-https://github.com/turbasvin/spektrafilm-rs.git}"
RS_COMMIT="${RS_COMMIT:-9dd59b0380194b93686aaa230a8bb9680aa270a4}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/vendor/spektrafilm-rs"
out="$root/vendor/bin"

if [ ! -d "$src/.git" ]; then
    rm -rf "$src"
    git clone "$RS_REPO" "$src"
fi

git -C "$src" fetch --depth 1 origin "$RS_COMMIT"
git -C "$src" checkout --detach "$RS_COMMIT"

cargo build --release --manifest-path "$src/Cargo.toml" -p spektrafilm-cli

mkdir -p "$out"
cp "$src/target/release/spektrafilm" "$out/spektrafilm"

# The binary links libopenblas.so.0; point the smoke test at the copy the build
# just produced (the container gets the distro package instead).
openblas_dir="$(dirname "$(find "$src/target/release/build" -name 'libopenblas.so.0' | head -1)")"
if [ -n "$openblas_dir" ]; then
    LD_LIBRARY_PATH="$openblas_dir" "$out/spektrafilm" list-profiles --data-dir "$src/data" | head -3
fi

echo "built: $out/spektrafilm"
