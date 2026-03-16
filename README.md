# vfs-test

CI and mailing list bridge for the Linux VFS subsystem. Runs as GitHub
Actions on the [linux-fsdevel/vfs](https://github.com/linux-fsdevel/vfs)
mirror.

## Overview

Three scheduled workflows keep the mirror in sync, turn mailing list
patches into pull requests, and build+test every branch that changes:

```
kernel.org/vfs.git                      Patchwork (linux-fsdevel)
  vfs.all ──┐                                │
  vfs.base ─┤  sync.yml (daily)              │  bridge.yml (every 2h)
  vfs.fixes ┘      │                         │       │
                   ▼                         ▼       │
         GitHub linux-fsdevel/vfs                    │
           vfs.all.ci  ◄── CI files overlaid         │
           vfs.base.ci ◄── CI files overlaid         │
           vfs.fixes.ci◄── CI files overlaid         │
           pw/<id>/... ◄─────────────────────────────┘
                    │
                    ▼
              test.yml (on push)
                    │
           ┌────────┼────────┐
           ▼        ▼        ▼
        selftests  xfstests  ovl-fstests
```

## Workflows

### sync.yml -- Mirror kernel.org to GitHub

Runs once a day. Shallow-clones vfs.git from kernel.org, force-pushes the
clean branches (vfs.all, vfs.base, vfs.fixes) to GitHub, then creates
matching `.ci` branches with the CI files from this repository overlaid.
Only pushes a `.ci` branch when its tree actually changes, so existing
pw/ branches don't needlessly diverge.

### bridge.yml -- Mailing list to pull request bridge (ml2pr)

Runs every two hours. Queries the Patchwork API for patch series
delegated to the VFS maintainer, applies them with `b4`, and opens pull
requests on GitHub targeting `vfs.base.ci`. This triggers CI
automatically.

The bridge also:
- Rebases open `pw/` PRs when `vfs.base` moves forward.
- Closes PRs when a newer version of the series supersedes them.
- Closes PRs when all patches have been merged upstream (patch-id
  comparison against `vfs.base`).
- Closes PRs that have gone stale (older than 14 days).

### test.yml / kernel-build-test.yml -- Build and test matrix

Triggered on every push to any branch except the clean mirror branches
and `pw/**`. A Python matrix generator (.github/scripts/matrix.py)
produces the cross-product of build configurations and test suites:

| Arch   | Toolchain | Distributions  | Test suites                        |
|--------|-----------|----------------|------------------------------------|
| x86_64 | gcc       | Fedora, Debian | selftests, xfstests, ovl-fstests   |

Each matrix entry:
1. Checks out the CI repo and clones
   [mkosi-kernel](https://github.com/DaanDeMeyer/mkosi-kernel).
2. Overlays the VFS kernel config fragment and mkosi configuration.
3. Builds the kernel and a bootable disk image with `mkosi`.
4. Boots the image in QEMU and runs the selected test suite via a
   dedicated systemd service unit.

Exit code 123 from the guest signals success (systemd
`SuccessActionExitStatus`); anything else is a failure.

## Test suites

### VFS selftests

Runs the kernel's in-tree selftests for VFS-related subsystems:

- `mount`, `mount_setattr`, `filelock`, `tmpfs`
- `pidfd`, `pid_namespace`, `cachestat`

Known-flaky tests (`filesystems:file_stressor`, `filelock:ofdlocks`) are
denylisted.

### XFS fstests

Runs `xfstests -g quick` on XFS using dedicated test/scratch partitions
provisioned by mkosi's repart configuration.

### Overlayfs fstests

Same as XFS fstests but additionally runs the `overlay/union` test
group with `-overlay`.

## mkosi configuration

Located under `ci/mkosi/`:

- **mkosi.conf.d/** -- mkosi drop-in configs copied into mkosi-kernel's
  `mkosi.conf.d/` at build time.  `99-vfs.conf` enables selftest and
  fstests build profiles, sets RAM/CPU limits for QEMU, and configures
  the kernel command line.  `99-vfs-fstests.conf` activates the fstests
  profile and maps the xfstests source tree.  `99-vfs-ovl.conf` adds an
  `ExtraTrees` entry to install the unionmount-testsuite into the image.
- **mkosi.kernel.config** -- Kernel config fragment enabling VFS debug
  options (`CONFIG_DEBUG_VFS`, `CONFIG_PROVE_LOCKING`,
  `CONFIG_XFS_DEBUG`, `CONFIG_BTRFS_DEBUG`, `CONFIG_BTRFS_ASSERT`,
  etc.) along with a comprehensive set of filesystem, block, and
  networking options needed by the test suites.
- **mkosi.repart/** -- Partition layout: 10G root, 5G swap, and four 2G
  partitions (`fsdevel1`..`fsdevel4`) used as test/scratch devices by
  fstests.
- **mkosi.extra/** -- Files overlaid into the image: systemd service
  units for each test suite, test runner scripts under
  `/usr/lib/vfs-ci/`, network configuration, and userdb entries.

## Running locally

```
scripts/local-test.sh <kernel-source-dir> [distro] [selftests|xfstests|ovl-fstests]
```

Examples:
```
scripts/local-test.sh ~/src/linux fedora selftests
scripts/local-test.sh ~/src/linux debian xfstests
scripts/local-test.sh ~/src/linux fedora           # runs all suites
```

Requires `mkosi` and `b4` installed. The script clones `mkosi-kernel`
and `xfstests` to `/tmp` on first run (override with `MKOSI_KERNEL` and
`MKOSI_FSTESTS` environment variables).

## Repository layout

```
.github/
  scripts/matrix.py          # CI matrix generator
  workflows/
    bridge.yml               # ml2pr scheduled workflow
    kernel-build-test.yml    # reusable build+test job
    sync.yml                 # kernel.org mirror sync
    test.yml                 # CI entry point
ci/mkosi/
  mkosi.conf.d/              # mkosi drop-in configs
  mkosi.kernel.config        # kernel config fragment
  mkosi.repart/              # disk partition definitions
  mkosi.extra/               # files overlaid into the image
    usr/lib/systemd/system/  # test runner service units
    usr/lib/vfs-ci/          # test runner scripts
scripts/
  local-test.sh              # run the CI locally
  ml2pr.mjs                  # mailing list to PR bridge
package.json                 # npm deps (octokit for ml2pr)
```
