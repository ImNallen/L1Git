# Pierre tree row geometry

`@pierre/trees@1.0.0-beta.6` assumes one height for every visible row. The pinned
pnpm patch adds `fileItemHeight`, which defaults to `itemHeight`. L1 Git uses
32px directories and 34px files.

The controller caches sorted visible directory indices. A shared geometry
calculates row tops, heights, total height and pixel-to-index lookups without
projecting all file rows. Topology and search changes invalidate the cache after
visibility synchronization. Focus, selection, scrolling and completion of the
lazy projection preserve it. Layout, sticky boundaries, focus restoration and
scroll alignment consume this geometry. Each row also sets its local CSS height.

`pnpm install --frozen-lockfile` applies the patch. `pnpm test:tree-geometry`
checks the installed package, including cache reuse and SSR. For browser checks,
run `L1GIT_DEV_PORT=1426 pnpm dev:web` and open
`http://127.0.0.1:1426/scripts/tree-geometry.html`. The page runs against the real
package and the application component, then reports each result. It uses only
synthetic paths and does not access Git repositories. Reload the page for a
fresh run after editing the checks.

The published package contains compiled JavaScript and declarations. The patch
updates those files; its upstream source maps remain unchanged. When upgrading
Pierre, port or remove the patch and rerun both checks. The existing filtered
sticky-folder fallback still projects all filtered rows. This patch does not
introduce that behavior; ordinary virtualization and geometry remain lazy.
