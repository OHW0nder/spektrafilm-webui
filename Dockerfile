# syntax=docker/dockerfile:1
#
# Runtime image for the spektrafilm web UI.
#
# The Rust GPU renderer (spektrafilm-rs) is compiled on the host by
# `scripts/fetch-rs.sh` and copied in: a container-side cargo build pulls
# ~100 MB of crates over a slow link, and the host build is already verified
# against the local Vulkan stack.
FROM python:3.13-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple

# libfftw3*/libopenblas/libgfortran: runtime for pyFFTW and the Rust CLI.
# libvulkan1 + mesa-vulkan-drivers: wgpu backend (RADV on the Radeon 680M).
RUN sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
        libfftw3-double3 libfftw3-single3 libfftw3-long3 \
        libvulkan1 mesa-vulkan-drivers \
        libopenblas0 libgfortran5 libgomp1 \
        libgl1 libglib2.0-0 \
        curl \
    && rm -rf /var/lib/apt/lists/*

COPY vendor/bin/spektrafilm /opt/spektrafilm-rs/spektrafilm
COPY vendor/spektrafilm-rs/data /opt/spektrafilm-rs/data

WORKDIR /app
# Dependencies first: they only need the requirement files, so code edits below
# do not invalidate this (slow) layer.
COPY pyproject.toml README.md requirements-runtime.txt ./
COPY webui/requirements.txt ./webui/requirements.txt
# Two steps on purpose: the runtime list pulls the transitive deps (llvmlite,
# tifffile, ...) while --no-deps keeps the desktop GUI extras out of the image.
RUN pip install --no-cache-dir -r requirements-runtime.txt -r webui/requirements.txt

COPY src ./src
COPY webui ./webui
RUN pip install --no-cache-dir --no-deps -e .

RUN useradd -u 1000 -m -s /usr/sbin/nologin spektrafilm \
    && mkdir -p /data \
    && chown -R spektrafilm:spektrafilm /data /app

USER spektrafilm

ENV SPEKTRAFILM_DATA=/data \
    SPEKTRAFILM_RS_BIN=/opt/spektrafilm-rs/spektrafilm \
    SPEKTRAFILM_RS_DATA=/opt/spektrafilm-rs/data \
    SPEKTRAFILM_RS_BACKEND=wgpu \
    NUMBA_NUM_THREADS=12 \
    NUMBA_CACHE_DIR=/tmp/numba \
    OMP_NUM_THREADS=12

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
    CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

CMD ["uvicorn", "webui.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
