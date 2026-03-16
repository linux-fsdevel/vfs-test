#!/bin/bash
# Run the VFS CI mkosi build & selftest locally.
#
# Usage: scripts/local-test.sh [options] -k <kernel-source-dir> [distro] [selftests|xfstests|ovl-fstests]
#
# Options:
#   -k <dir>    Kernel source directory (required)
#   -m <dir>    mkosi-kernel clone directory (default: /tmp/mkosi-kernel or $MKOSI_KERNEL)
#   -f <dir>    fstests clone directory      (default: /tmp/fstests or $MKOSI_FSTESTS)
#   -h          Show this help message
#
# Example:
#   scripts/local-test.sh -k /home/brauner/src/git/linux/vfs/vfs.base fedora
#   scripts/local-test.sh -k ~/linux -m ~/mkosi-kernel -f ~/fstests fedora selftests
#   scripts/local-test.sh -k /home/brauner/src/git/linux/vfs/vfs.base fedora xfstests
#   scripts/local-test.sh -k /home/brauner/src/git/linux/vfs/vfs.base fedora ovl-fstests
set -euo pipefail

usage() {
    sed -n '2,/^[^#]/{ /^#/s/^# \?//p }' "$0"
    exit "${1:-0}"
}

# Parse options
opt_kernel_src=""
opt_mkosi_kernel=""
opt_mkosi_fstests=""
while getopts "k:m:f:h" opt; do
    case "$opt" in
        k) opt_kernel_src="$OPTARG" ;;
        m) opt_mkosi_kernel="$OPTARG" ;;
        f) opt_mkosi_fstests="$OPTARG" ;;
        h) usage 0 ;;
        *) usage 1 >&2 ;;
    esac
done
shift $((OPTIND - 1))

if [[ -z "$opt_kernel_src" ]]; then
    echo "error: -k <kernel-source-dir> is required" >&2
    usage 1 >&2
fi

KERNEL_SRC="$opt_kernel_src"
DISTRO="${1:-fedora}"
TEST_SUITE="${2:-}"

# Resolve paths — flag > env var > default
KERNEL_SRC="$(realpath "$KERNEL_SRC")"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VFS_TEST="$(dirname "$SCRIPT_DIR")"
MKOSI_KERNEL="${opt_mkosi_kernel:-${MKOSI_KERNEL:-/tmp/mkosi-kernel}}"
MKOSI_FSTESTS="${opt_mkosi_fstests:-${MKOSI_FSTESTS:-/tmp/fstests}}"

# Clone mkosi-kernel if missing
if [[ ! -d "$MKOSI_KERNEL" ]]; then
    echo "==> Cloning mkosi-kernel to $MKOSI_KERNEL"
    git clone --depth=1 https://github.com/DaanDeMeyer/mkosi-kernel.git "$MKOSI_KERNEL"
fi

if [[ "$TEST_SUITE" != "selftests" ]] && [[ ! -d "$MKOSI_FSTESTS" ]]; then
    echo "==> Cloning fstests to $MKOSI_FSTESTS"
    git clone --depth=1 https://github.com/kdave/xfstests.git "$MKOSI_FSTESTS"
fi

if [[ -z "$TEST_SUITE" || "$TEST_SUITE" == "ovl-fstests" ]] && [[ ! -d "$MKOSI_FSTESTS/src/unionmount-testsuite" ]]; then
    echo "==> Cloning unionmount-testsuite into $MKOSI_FSTESTS/src/"
    git clone --depth=1 https://github.com/amir73il/unionmount-testsuite.git "$MKOSI_FSTESTS/src/unionmount-testsuite"
fi

echo "==> Kernel source:          $KERNEL_SRC"
echo "==> mkosi-kernel:           $MKOSI_KERNEL"
if [[ -z "$TEST_SUITE" || "$TEST_SUITE" != "selftests" ]]; then
    echo "==> fstests:                $MKOSI_FSTESTS"
fi
if [[ -z "$TEST_SUITE" || "$TEST_SUITE" == "ovl-fstests" ]]; then
    echo "==> unionmount-testsuite:   $MKOSI_FSTESTS/src/unionmount-testsuite"
fi
echo "==> Distribution:           $DISTRO"
echo "==> Test suite:             ${TEST_SUITE:-all}"

# Overlay VFS CI config onto mkosi-kernel (mirrors kernel-build-test.yml)
echo "==> Configuring mkosi"
cp "$VFS_TEST/ci/mkosi/mkosi.kernel.config" "$MKOSI_KERNEL/"
cp -avr "$VFS_TEST/ci/mkosi/mkosi.extra/." "$MKOSI_KERNEL/mkosi.extra/"
cp -avr "$VFS_TEST/ci/mkosi/mkosi.repart"  "${MKOSI_KERNEL}/"
mkdir -p "$MKOSI_KERNEL/mkosi.conf.d"
# Strip BuildSources / ExtraTrees from the drop-ins — they reference env vars
# ($GITHUB_WORKSPACE, $MKOSI_FSTESTS) that don't exist locally.
# We set BuildSources in mkosi.local.conf instead; ExtraTrees is rewritten
# with the expanded local path.
sed '/^BuildSources=/d' "$VFS_TEST/ci/mkosi/mkosi.conf.d/99-vfs.conf" \
    > "$MKOSI_KERNEL/mkosi.conf.d/99-vfs.conf"

if [[ -z "$TEST_SUITE" || "$TEST_SUITE" != "selftests" ]]; then
    sed '/^BuildSources=/d' "$VFS_TEST/ci/mkosi/mkosi.conf.d/99-vfs-fstests.conf" \
        > "$MKOSI_KERNEL/mkosi.conf.d/99-vfs-fstests.conf"
fi

if [[ -z "$TEST_SUITE" || "$TEST_SUITE" == "ovl-fstests" ]]; then
    sed "s|\$MKOSI_FSTESTS|${MKOSI_FSTESTS}|g" "$VFS_TEST/ci/mkosi/mkosi.conf.d/99-vfs-ovl.conf" \
        > "$MKOSI_KERNEL/mkosi.conf.d/99-vfs-ovl.conf"
fi

_buildsources="$KERNEL_SRC:kernel"
if [[ -z "$TEST_SUITE" || "$TEST_SUITE" != "selftests" ]]; then
    _buildsources+=$'\n'"            $MKOSI_FSTESTS:fstests"
fi

cat > "$MKOSI_KERNEL/mkosi.local.conf" <<EOF
[Distribution]
Distribution=$DISTRO

[Build]
BuildSources=$_buildsources
EOF

# Generate signing keys if not present
if [[ ! -f "$MKOSI_KERNEL/mkosi.key" ]]; then
    echo "==> Generating signing keys"
    mkosi --directory="$MKOSI_KERNEL" genkey
fi

echo "==> mkosi summary"
mkosi --directory="$MKOSI_KERNEL" summary

echo "==> Building image and kernel"
mkosi --directory="$MKOSI_KERNEL" -f build

if [[ -z "$TEST_SUITE" || "$TEST_SUITE" == "selftests" ]]; then
    echo "==> Running selftests in QEMU"
    rc=0
    mkosi --directory="${MKOSI_KERNEL}" box -- mkosi --directory="${MKOSI_KERNEL}" --kernel-command-line-extra=systemd.unit=vfs-selftests.service qemu || rc=$?

    if [[ "$rc" -ne 123 ]]; then
        echo "==> SELFTESTS FAILED (exit code $rc)"
        exit 1
    fi
    echo "==> Selftests passed"
fi

if [[ -z "$TEST_SUITE" || "$TEST_SUITE" == "xfstests" ]]; then
    echo "==> Running xfs fstests in QEMU"
    rc=0
    mkosi --directory="${MKOSI_KERNEL}" box -- mkosi --directory="${MKOSI_KERNEL}" --kernel-command-line-extra=systemd.unit=xfs-fstests.service qemu || rc=$?

    if [[ "$rc" -ne 123 ]]; then
        echo "==> XFS FSTESTS FAILED (exit code $rc)"
        exit 1
    fi
    echo "==> Xfs fstests passed"
fi

if [[ -z "$TEST_SUITE" || "$TEST_SUITE" == "ovl-fstests" ]]; then
    echo "==> Running overlayfs fstests in QEMU"
    rc=0
    mkosi --directory="${MKOSI_KERNEL}" box -- mkosi --directory="${MKOSI_KERNEL}" --kernel-command-line-extra=systemd.unit=ovl-fstests.service qemu || rc=$?

    if [[ "$rc" -ne 123 ]]; then
        echo "==> OVL FSTESTS FAILED (exit code $rc)"
        exit 1
    fi
    echo "==> Ovl fstests passed"
fi

echo "==> ALL TESTS PASSED"
