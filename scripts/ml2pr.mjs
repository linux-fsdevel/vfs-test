#!/usr/bin/env node
/**
 * ml2pr - mailing list to pull request bridge.
 *
 * Stateless batch script. Discovers patch series from Patchwork,
 * applies them with b4, creates PRs on GitHub via octokit.
 * Designed to run as a scheduled GitHub Actions workflow.
 */

import { Octokit } from "@octokit/rest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, rmSync, readdirSync, appendFileSync, existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Config ────────────────────────────────────────────────────────────

const PW_API      = "https://patchwork.kernel.org/api/1.2";
const PW_PROJECT  = 201;        // linux-fsdevel
const PW_DELEGATE = 60587;      // brauner
const OWNER       = "linux-fsdevel";
const REPO        = "vfs";
const BASE_BRANCH = "vfs.base.ci";
const SOURCE_BRANCH = "vfs.base";  // patches applied here, PR targets BASE_BRANCH
const LOOKBACK_DAYS = 1;
const STALE_DAYS  = 14;
const B4_TIMEOUT  = 120_000;
const CLONE_DEPTH = 500;

const REPO_HTTPS = `https://github.com/${OWNER}/${REPO}.git`;
const AUTH_HEADER = `Authorization: basic ${Buffer.from(
  `x-access-token:${process.env.GITHUB_TOKEN}`).toString("base64")}`;

const ML2PR_FOOTER = "\n\n---\n*Automated by ml2pr*";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// ── Helpers ───────────────────────────────────────────────────────────

function git(cwd, ...args) {
  return execFileSync("git",
    ["-c", `http.extraheader=${AUTH_HEADER}`, ...args],
    { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }).trim();
}

// For local-only git commands that need untrimmed output or stdin piping.
function gitLocal(cwd, args, opts = {}) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, ...opts,
  });
}

async function withRetry(fn, { retries = 3, delayMs = 5000, label = "" } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      const status = err.status ?? err.response?.status;
      if (status && status < 500) throw err;
      console.warn(
        `${label ? label + ": " : ""}attempt ${attempt}/${retries} failed ` +
        `(${err.message}), retrying in ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

function remoteBranchExists(cwd, branch) {
  const out = git(cwd, "ls-remote", "--heads", "origin", `refs/heads/${branch}`);
  return out.length > 0;
}

function filterPwPrs(prs) {
  return prs.filter(pr => pr.head.ref.startsWith("pw/"));
}

function sanitizeName(name) {
  return name.replace(/<!--/g, "").replace(/-->/g, "")
    .replace(/[\n\r]/g, " ").trim();
}

function normalizePwName(name) {
  return name.replace(/^\s*\[[^\]]*\]\s*/, "").trim();
}

function seriesMsgid(series) {
  return series.cover_letter?.msgid ?? series.patches?.[0]?.msgid ?? null;
}

function loreUrl(msgid) {
  if (!msgid) return null;
  return `https://lore.kernel.org/linux-fsdevel/${msgid.replace(/^<|>$/g, "")}`;
}

function pwSeriesUrl(seriesId) {
  return `https://patchwork.kernel.org/project/linux-fsdevel/list/?series=${seriesId}`;
}

function writeSummary(line) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, line + "\n");
}

async function patchworkGet(path, params = {}) {
  const url = new URL(`${PW_API}${path}`);
  for (const [k, v] of Object.entries(params))
    url.searchParams.set(k, v);

  const results = [];
  let next = url.toString();

  while (next) {
    const resp = await fetch(next);
    if (!resp.ok) throw new Error(`Patchwork ${resp.status}: ${next}`);
    const data = await resp.json();

    if (Array.isArray(data)) {
      results.push(...data);
    } else {
      return data;
    }

    const link = resp.headers.get("link");
    next = null;
    if (link) {
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      if (m) next = m[1];
    }
  }
  return results;
}

// ── Discovery ─────────────────────────────────────────────────────────

async function discoverSeries() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000)
    .toISOString().split("T")[0];

  const raw = await patchworkGet("/series/", {
    project: PW_PROJECT,
    delegate: PW_DELEGATE,
    ordering: "-date",
    since,
    per_page: 250,
  });

  return raw.filter(s => {
    if (!s.received_all) return false;
    if (/^\s*\[.*\bRFC\b/i.test(s.name)) return false;
    return true;
  });
}

// ── PR lookup (GitHub as state via octokit) ──────────────────────────

async function listOpenPrs() {
  return withRetry(() => octokit.paginate(octokit.rest.pulls.list, {
    owner: OWNER,
    repo: REPO,
    state: "open",
    per_page: 100,
  }), { label: "listOpenPrs" });
}

function findPrForSeries(prs, seriesId) {
  return prs.find(pr => pr.head.ref.startsWith(`pw/${seriesId}/`));
}

function findPrsByName(prs, seriesName) {
  const norm = normalizePwName(seriesName);
  return prs.filter(pr => {
    const match = pr.body?.match(/^<!--\s*pw-name:\s*(.+?)\s*-->$/m);
    return match && normalizePwName(match[1]) === norm;
  });
}

// ── Patch application ────────────────────────────────────────────────

function fetchCachedClone(workdir) {
  console.log("Using cached clone, fetching updates...");
  git(workdir, "fetch", "--depth", String(CLONE_DEPTH), "origin",
    `+refs/heads/${SOURCE_BRANCH}:refs/remotes/origin/${SOURCE_BRANCH}`,
    `+refs/heads/${BASE_BRANCH}:refs/remotes/origin/${BASE_BRANCH}`);
  try {
    git(workdir, "checkout", SOURCE_BRANCH);
  } catch {
    git(workdir, "checkout", "-b", SOURCE_BRANCH, `origin/${SOURCE_BRANCH}`);
  }
  git(workdir, "reset", "--hard", `origin/${SOURCE_BRANCH}`);
  git(workdir, "clean", "-fdx");
}

function freshClone(workdir) {
  console.log("No cache, cloning fresh...");
  execFileSync("git", [
    "-c", `http.extraheader=${AUTH_HEADER}`,
    "clone", `--depth=${CLONE_DEPTH}`, "--branch", SOURCE_BRANCH,
    "--single-branch", REPO_HTTPS, workdir,
  ], { stdio: "inherit" });
  // Also fetch the CI branch — needed for PR base reference and
  // merge detection, but patches are applied on SOURCE_BRANCH.
  git(workdir, "fetch", "--depth", String(CLONE_DEPTH), "origin",
    `+refs/heads/${BASE_BRANCH}:refs/remotes/origin/${BASE_BRANCH}`);
}

function cloneOrFetchBase(workdir) {
  if (existsSync(join(workdir, ".git")))
    fetchCachedClone(workdir);
  else
    freshClone(workdir);
  git(workdir, "config", "user.name", "ml2pr");
  git(workdir, "config", "user.email", "ml2pr@linux-fsdevel");
}

function resetBase(workdir) {
  try { git(workdir, "am", "--abort"); } catch {}
  git(workdir, "checkout", SOURCE_BRANCH);
  git(workdir, "reset", "--hard", `origin/${SOURCE_BRANCH}`);
  git(workdir, "clean", "-fdx");
}

function safeReset(workdir) {
  try { resetBase(workdir); } catch {}
}

function fetchPwBranches(workdir) {
  try {
    git(workdir, "fetch", "origin", "refs/heads/pw/*:refs/remotes/origin/pw/*");
    return true;
  } catch (err) {
    console.warn(`Failed to fetch pw/* branches: ${err.message}`);
    return false;
  }
}

function applySeries(series, workdir) {
  const msgid = seriesMsgid(series);
  const mboxDir = mkdtempSync(join(tmpdir(), `b4-${series.id}-`));
  try {
    const b4Env = { ...process.env };
    delete b4Env.GITHUB_TOKEN;

    execFileSync("b4", ["am", msgid, "-o", mboxDir], {
      cwd: workdir,
      timeout: B4_TIMEOUT,
      stdio: "inherit",
      env: b4Env,
    });

    const mboxFiles = readdirSync(mboxDir).filter(f => f.endsWith(".mbx"));
    if (mboxFiles.length === 0) {
      console.warn(`b4 produced no .mbx file for series ${series.id}`);
      return false;
    }
    const mboxPath = join(mboxDir, mboxFiles[0]);

    git(workdir, "am", "--3way", mboxPath);

    const applied = parseInt(
      git(workdir, "rev-list", "--count", `origin/${SOURCE_BRANCH}..HEAD`));
    if (applied === 0) {
      console.warn(`git am applied 0 commits for series ${series.id}`);
      return false;
    }

    const expected = series.patches?.length ?? 0;
    if (expected > 0 && applied !== expected) {
      console.warn(
        `Series ${series.id}: applied ${applied}/${expected} patches`);
    }

    return true;
  } catch (err) {
    console.warn(`Apply failed for series ${series.id}: ${err.message}`);
    return false;
  } finally {
    rmSync(mboxDir, { recursive: true, force: true });
  }
}

// ── PR rebase (align with current base) ─────────────────────────────

function rebaseOpenPrs(prs, workdir) {
  const pwPrs = filterPwPrs(prs);
  if (pwPrs.length === 0) return;

  const sourceTip = git(workdir, "rev-parse", `origin/${SOURCE_BRANCH}`);

  for (const pr of pwPrs) {
    const branch = pr.head.ref;
    try {
      try {
        git(workdir, "merge-base", "--is-ancestor", sourceTip, `origin/${branch}`);
        console.log(`PR #${pr.number} (${branch}) already aligned`);
        continue;
      } catch {
        // not an ancestor, needs rebase
      }

      console.log(`Rebasing PR #${pr.number} (${branch}) onto ${SOURCE_BRANCH}...`);
      git(workdir, "checkout", "-B", "rebase-tmp", `origin/${branch}`);

      const mergeBase = git(workdir, "merge-base",
        `origin/${SOURCE_BRANCH}`, "rebase-tmp");

      git(workdir, "rebase", "--onto", `origin/${SOURCE_BRANCH}`,
        mergeBase, "rebase-tmp");

      git(workdir, "push", "--force", "origin",
        `rebase-tmp:refs/heads/${branch}`);
      console.log(`Rebased PR #${pr.number} (${branch})`);
    } catch (err) {
      console.warn(
        `Rebase failed for PR #${pr.number} (${branch}): ${err.message}`);
      try { git(workdir, "rebase", "--abort"); } catch {}
    }
  }

  safeReset(workdir);
}

// ── PR creation (octokit) ────────────────────────────────────────────

async function createPr(series, workdir) {
  const branch = `pw/${series.id}/${BASE_BRANCH}`;
  git(workdir, "push", "origin", `HEAD:refs/heads/${branch}`);

  const safeName = sanitizeName(series.name);
  const title = sanitizeName(normalizePwName(series.name));
  const msgid = seriesMsgid(series);
  const submitter = series.submitter?.name ?? "Unknown";
  const version = series.version ?? 1;
  const patchCount = series.patches?.length ?? 0;
  const total = series.total ?? patchCount;

  const body = [
    `<!-- pw-name: ${safeName} -->`,
    `**Series:** ${pwSeriesUrl(series.id)}`,
    `**Submitter:** ${submitter}`,
    `**Version:** ${version}`,
    `**Patches:** ${patchCount}/${total}`,
    `**Message-ID:** \`${msgid}\``,
    `**Base:** ${BASE_BRANCH}`,
    `**Lore:** ${loreUrl(msgid)}`,
  ].join("\n") + ML2PR_FOOTER;

  const { data: pr } = await withRetry(() => octokit.rest.pulls.create({
    owner: OWNER,
    repo: REPO,
    title,
    body,
    head: branch,
    base: BASE_BRANCH,
  }), { label: `createPr(${series.id})` });

  return pr.number;
}

// ── PR close helpers ─────────────────────────────────────────────────

async function closePrWithComment(pr, comment) {
  await withRetry(() => octokit.rest.issues.createComment({
    owner: OWNER, repo: REPO,
    issue_number: pr.number,
    body: comment,
  }), { label: `comment(#${pr.number})` });

  await withRetry(() => octokit.rest.pulls.update({
    owner: OWNER, repo: REPO,
    pull_number: pr.number,
    state: "closed",
  }), { label: `close(#${pr.number})` });

  try {
    await withRetry(() => octokit.rest.git.deleteRef({
      owner: OWNER, repo: REPO,
      ref: `heads/${pr.head.ref}`,
    }), { label: `deleteRef(${pr.head.ref})` });
  } catch (e) {
    console.warn(`Failed to delete branch ${pr.head.ref}: ${e.message}`);
  }
}

async function closePrsMatching(prs, predicate, reasonFn) {
  const closed = [];
  for (const pr of prs) {
    if (!predicate(pr)) continue;
    const { logMsg, comment } = reasonFn(pr);
    console.log(logMsg);
    await closePrWithComment(pr, comment);
    closed.push(pr.number);
  }
  return closed;
}

// ── Version handling ─────────────────────────────────────────────────

async function closeSuperseded(prs, series) {
  const sameNamePrs = findPrsByName(prs, series.name);
  return closePrsMatching(sameNamePrs,
    pr => !pr.head.ref.startsWith(`pw/${series.id}/`),
    pr => ({
      logMsg: `Closing superseded PR #${pr.number} (${pr.head.ref}) — ` +
        `replaced by series ${series.id}`,
      comment: `Superseded by series ${series.id} (v${series.version ?? "?"}).` +
        ` Closing automatically.${ML2PR_FOOTER}`,
    }));
}

// ── Merge detection (patch-id) ───────────────────────────────────────

function getPatchIds(cwd, ...revArgs) {
  const diff = gitLocal(cwd, ["log", "-p", ...revArgs]);
  if (!diff.trim()) return new Map();
  const out = gitLocal(cwd, ["patch-id", "--stable"], { input: diff });
  return new Map(out.trim().split("\n").filter(Boolean).map(l => {
    const [pid, sha] = l.split(" ");
    return [pid, sha];
  }));
}

function allPatchesMerged(workdir, prBranch, baseIds) {
  try {
    const prIds = getPatchIds(workdir,
      `origin/${BASE_BRANCH}..${prBranch}`);
    if (prIds.size === 0) return false;

    for (const pid of prIds.keys()) {
      if (!baseIds.has(pid)) return false;
    }
    return true;
  } catch (err) {
    console.warn(`patch-id check failed for ${prBranch}: ${err.message}`);
    return false;
  }
}

// ── PR cleanup (merged + stale) ─────────────────────────────────────

async function closeMerged(prs, workdir) {
  const baseIds = getPatchIds(workdir,
    `--since=30 days ago`, `origin/${BASE_BRANCH}`);

  return closePrsMatching(filterPwPrs(prs),
    pr => allPatchesMerged(workdir, `origin/${pr.head.ref}`, baseIds),
    pr => ({
      logMsg: `Closing merged PR #${pr.number} (${pr.head.ref}) — ` +
        `all patches landed in ${BASE_BRANCH}`,
      comment: `All patches in this series have landed in \`${BASE_BRANCH}\`.` +
        ` Closing automatically.${ML2PR_FOOTER}`,
    }));
}

async function closeStale(prs) {
  const cutoff = Date.now() - STALE_DAYS * 86400_000;
  return closePrsMatching(filterPwPrs(prs),
    pr => new Date(pr.created_at).getTime() <= cutoff,
    pr => ({
      logMsg: `Closing stale PR #${pr.number} (${pr.head.ref}) — ` +
        `older than ${STALE_DAYS} days`,
      comment: `This PR is older than ${STALE_DAYS} days. Closing automatically.` +
        ` If the series is still relevant, a new version will create a new PR.${ML2PR_FOOTER}`,
    }));
}

// ── Phase helpers ────────────────────────────────────────────────────

function seriesLinks(series) {
  const sid = series.id;
  const msgid = seriesMsgid(series);
  const lore = loreUrl(msgid);
  const pwUrl = pwSeriesUrl(sid);
  return [
    lore ? `[lore](${lore})` : null,
    `[pw](${pwUrl})`,
    msgid ? `\`${msgid}\`` : null,
  ].filter(Boolean).join(" · ");
}

async function tryProcessSeries(series, openPrs, workdir) {
  const sid = series.id;
  const msgid = seriesMsgid(series);
  const name = sanitizeName(normalizePwName(series.name));
  const links = seriesLinks(series);

  if (findPrForSeries(openPrs, sid)) {
    console.log(`Series ${sid} already has PR, skipping`);
    return null;
  }

  if (!msgid) {
    console.warn(`Series ${sid} has no message-id, skipping`);
    return `| no message-id | ${name} | ${links} |`;
  }

  try {
    if (!applySeries(series, workdir)) {
      console.warn(`Series ${sid} failed to apply, skipping`);
      return `| apply failed | ${name} | ${links} |`;
    }
    const branch = `pw/${sid}/${BASE_BRANCH}`;
    if (remoteBranchExists(workdir, branch)) {
      console.warn(`Series ${sid}: branch ${branch} already exists, skipping`);
      return `| EEXIST | ${name} | ${links} |`;
    }
    const prNum = await createPr(series, workdir);
    console.log(`Created PR #${prNum} for series ${sid}`);
    return `| PR [#${prNum}](https://github.com/${OWNER}/${REPO}/pull/${prNum}) | ${name} | ${links} |`;
  } catch (err) {
    console.error(`Failed to process series ${sid}:`, err.message);
    return `| error | ${name} | ${links} |`;
  } finally {
    safeReset(workdir);
  }
}

async function processNewSeries(seriesList, openPrs, workdir) {
  writeSummary("## ml2pr run");
  writeSummary("");
  writeSummary("| Status | Name | Links |");
  writeSummary("|--------|------|-------|");

  for (const series of seriesList) {
    const row = await tryProcessSeries(series, openPrs, workdir);
    if (row) writeSummary(row);
  }
}

async function cleanupSuperseded(seriesList) {
  const refreshedPrs = await listOpenPrs();
  const closedIds = new Set();

  // seriesList is ordered newest-first (-date). Only the newest series
  // per normalized name should run supersession — otherwise an older
  // version that also got a PR in this run would close the newer one.
  const seenNames = new Set();
  for (const series of seriesList) {
    const norm = normalizePwName(series.name);
    if (seenNames.has(norm)) continue;
    seenNames.add(norm);

    if (findPrForSeries(refreshedPrs, series.id)) {
      const closed = await closeSuperseded(refreshedPrs, series);
      for (const id of closed) closedIds.add(id);
    }
  }

  return { refreshedPrs, closedIds };
}

async function cleanupStaleAndMerged(refreshedPrs, closedIds, workdir, hasPwRefs) {
  let remainingPrs = refreshedPrs.filter(pr => !closedIds.has(pr.number));

  if (hasPwRefs) {
    const mergedIds = await closeMerged(remainingPrs, workdir);
    for (const id of mergedIds) closedIds.add(id);
    remainingPrs = remainingPrs.filter(pr => !closedIds.has(pr.number));
  }

  await closeStale(remainingPrs);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const seriesList = await discoverSeries();
  console.log(`Found ${seriesList.length} complete series`);
  if (seriesList.length === 0) {
    console.log(
      "::warning::No series discovered — " +
      "Patchwork may be down or delegate filter misconfigured");
  }

  const openPrs = await listOpenPrs();
  console.log(`Found ${openPrs.length} open PRs`);

  // Use a fixed path so actions/cache can persist the shallow clone
  // across workflow runs. First run clones (~9 min), subsequent runs
  // just fetch updates (seconds).
  const workdir = process.env.VFS_CLONE_DIR
    || join(tmpdir(), "ml2pr-vfs-cache");
  cloneOrFetchBase(workdir);

  // Single fetch for all pw/ branches — used by rebase and merge detection
  const hasPwRefs = fetchPwBranches(workdir);

  try {
    if (hasPwRefs) rebaseOpenPrs(openPrs, workdir);
    await processNewSeries(seriesList, openPrs, workdir);
    const { refreshedPrs, closedIds } = await cleanupSuperseded(seriesList);
    await cleanupStaleAndMerged(refreshedPrs, closedIds, workdir, hasPwRefs);
  } finally {
    // Reset workdir to clean state for cache. Don't delete — the
    // actions/cache step will persist it for the next run.
    safeReset(workdir);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
