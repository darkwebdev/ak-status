#!/usr/bin/env node
// Runs every check in config.json, then writes into the data directory:
//   status.json   latest result per check, plus overall state
//   history.json  recent samples per check: [unixSeconds, state, ms]
//   daily.json    per-day counts per check: { "YYYY-MM-DD": [up, degraded, down] }
// and opens or closes GitHub issues for outages.
//
// Usage: node scripts/check.mjs [dataDir]   (default: ./data)
// Env:   GITHUB_TOKEN        used for issues and for reading public repos' Actions runs
//        STATUS_GH_TOKEN     optional, read-only token for private repos (ak-account)
//        GITHUB_REPOSITORY   owner/repo to file issues in (set by Actions)
//        DRY_RUN=1           don't touch issues
//        FORCE=1             ignore everyMinutes and run every check

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.resolve(process.argv[2] || path.join(root, 'data'));
const config = JSON.parse(await fs.readFile(process.env.CONFIG || path.join(root, 'config.json'), 'utf8'));

const TIMEOUT_MS = 20000;
const UA = 'ak-status-monitor (+https://github.com/darkwebdev/ak-status)';
const STATE = { up: 0, degraded: 1, down: 2, unknown: 3 };
const now = new Date();
const nowSec = Math.floor(now.getTime() / 1000);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(dataDir, file), 'utf8'));
  } catch {
    return fallback;
  }
}

async function timed(fn) {
  const start = performance.now();
  try {
    const r = await fn();
    return { ...r, ms: Math.round(performance.now() - start) };
  } catch (e) {
    const msg = e?.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS / 1000}s` : String(e?.cause?.code || e?.message || e);
    return { state: 'down', message: msg, ms: Math.round(performance.now() - start) };
  }
}

function req(url, opts = {}) {
  return fetch(url, {
    redirect: 'follow',
    ...opts,
    headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

function slow(check, result) {
  if (result.state === 'up' && check.slowMs && result.ms > check.slowMs) {
    return { ...result, state: 'degraded', message: `slow: ${result.ms} ms (limit ${check.slowMs} ms)` };
  }
  return result;
}

async function bodySnippet(res) {
  try {
    const t = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return t ? `: ${t.slice(0, 160)}` : '';
  } catch {
    return '';
  }
}

function dig(obj, p) {
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// --- check types ---------------------------------------------------------

async function checkPage(c) {
  const res = await req(c.url);
  if (!res.ok) return { state: 'down', message: `HTTP ${res.status}` };
  const html = await res.text();
  if (c.contains && !html.toLowerCase().includes(c.contains.toLowerCase())) {
    return { state: 'down', message: `page loaded but is missing "${c.contains}"` };
  }
  if (c.assets !== false) {
    // A broken deploy often serves index.html but 404s its bundle - fetch the entry scripts too.
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/gi)].map((m) => new URL(m[1], res.url).href);
    for (const src of srcs.slice(0, 3)) {
      const a = await req(src, { method: 'GET' });
      if (!a.ok) return { state: 'down', message: `page loads but its script ${new URL(src).pathname} is HTTP ${a.status}` };
      await a.arrayBuffer();
    }
    if (!srcs.length) return { state: 'degraded', message: 'page has no script tags' };
  }
  return { state: 'up', message: `HTTP ${res.status}` };
}

async function checkHttp(c) {
  const res = await req(c.url, {
    method: c.method || 'GET',
    headers: c.body ? { 'Content-Type': 'application/json' } : {},
    body: c.body ? JSON.stringify(c.body) : undefined,
  });
  const expected = c.expectStatus ?? 200;
  if (res.status !== expected) return { state: 'down', message: `expected HTTP ${expected}, got ${res.status}${await bodySnippet(res)}` };
  await res.arrayBuffer();
  return { state: 'up', message: `HTTP ${res.status} as expected` };
}

async function checkGraphql(c) {
  const res = await req(c.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: c.query }),
  });
  if (!res.ok) return { state: 'down', message: `HTTP ${res.status}${await bodySnippet(res)}` };
  const json = await res.json();
  if (json.errors?.length) return { state: 'down', message: `GraphQL error: ${json.errors[0].message}`.slice(0, 300) };
  const got = dig(json.data, c.expect.path);
  if (got !== c.expect.equals) {
    return { state: 'down', message: `expected ${c.expect.path} = ${JSON.stringify(c.expect.equals)}, got ${JSON.stringify(got)}` };
  }
  return { state: 'up', message: 'response as expected' };
}

async function checkCors(c) {
  const res = await req(c.url, {
    method: 'OPTIONS',
    headers: { Origin: c.origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  await res.arrayBuffer();
  const allow = res.headers.get('access-control-allow-origin');
  if (allow !== c.origin && allow !== '*') {
    return { state: 'down', message: `${c.origin} not allowed (HTTP ${res.status}, allow-origin: ${allow ?? 'missing'})` };
  }
  return { state: 'up', message: `${c.origin} allowed` };
}

async function checkWorkflow(c) {
  const priv = process.env.STATUS_GH_TOKEN;
  const token = priv || process.env.GITHUB_TOKEN;
  const gh = async (q) => {
    const res = await req(`https://api.github.com/repos/${c.repo}/actions/workflows/${c.workflow}/runs?per_page=1&${q}`, {
      headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    // A GitHub API problem isn't an outage of the thing being watched, so report it as unknown.
    if (!res.ok) return { missing: res.status };
    return (await res.json()).workflow_runs?.[0] || null;
  };
  const last = await gh('status=completed');
  if (last?.missing) {
    const hint = last.missing === 404 && !priv ? ' (private repo? add a STATUS_GH_TOKEN secret)' : '';
    return { state: 'unknown', message: `GitHub API HTTP ${last.missing}${hint}` };
  }
  if (!last) return { state: 'unknown', message: 'no completed runs yet' };
  const when = new Date(last.updated_at);
  const link = last.html_url;
  if (last.conclusion !== 'success' && last.conclusion !== 'skipped') {
    return { state: 'down', message: `last run ${last.conclusion} (${when.toISOString().slice(0, 16)}Z)`, link };
  }
  if (c.maxAgeHours) {
    const ageH = (now - when) / 3.6e6;
    if (ageH > c.maxAgeHours) {
      return { state: 'down', message: `last success ${Math.round(ageH)}h ago (expected every ${c.maxAgeHours}h)`, link };
    }
  }
  return { state: 'up', message: `last run succeeded ${when.toISOString().slice(0, 16)}Z`, link };
}

const runners = { page: checkPage, http: checkHttp, graphql: checkGraphql, cors: checkCors, workflow: checkWorkflow };

// --- issues --------------------------------------------------------------

async function ghIssues(method, p, body) {
  const repo = process.env.GITHUB_REPOSITORY;
  const res = await fetch(`https://api.github.com/repos/${repo}${p}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'User-Agent': UA,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${p}: HTTP ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function syncIssues(checks, results, prev) {
  if (process.env.DRY_RUN || !process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) return;
  const open = await ghIssues('GET', '/issues?state=open&labels=outage&per_page=100');
  const byCheck = new Map();
  for (const i of open) {
    const m = i.body?.match(/<!-- check:([\w-]+) -->/);
    if (m) byCheck.set(m[1], i);
  }
  const pageUrl = `https://${process.env.GITHUB_REPOSITORY.split('/')[0]}.github.io/${process.env.GITHUB_REPOSITORY.split('/')[1]}/`;
  for (const c of checks) {
    const r = results[c.id];
    if (!r) continue;
    const issue = byCheck.get(c.id);
    if (r.skipped) {
      if (r.state === 'down' && issue) r.issue = issue.html_url;
      continue;
    }
    if (r.state === 'down' && !issue && r.failures >= config.issueAfterFailures) {
      const created = await ghIssues('POST', '/issues', {
        title: `🔴 ${c.name} is down`,
        labels: ['outage'],
        body: `<!-- check:${c.id} -->\n**${c.name}** has failed ${r.failures} checks in a row.\n\n- Error: \`${r.message}\`\n${c.url ? `- URL: ${c.url}\n` : ''}${r.link ? `- Run: ${r.link}\n` : ''}- Since: ${r.downSince}\n\n[Status page](${pageUrl}#check-${c.id}). This issue closes by itself when the check recovers.`,
      });
      r.issue = created.html_url;
      console.log(`opened issue for ${c.id}`);
    } else if (r.state === 'down' && issue) {
      r.issue = issue.html_url;
    } else if (r.state !== 'down' && issue) {
      await ghIssues('POST', `/issues/${issue.number}/comments`, { body: `🟢 Recovered at ${now.toISOString()}: ${r.message}` });
      await ghIssues('PATCH', `/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
      console.log(`closed issue for ${c.id}`);
    }
  }
}

// --- main ----------------------------------------------------------------

const prev = await readJson('status.json', { checks: {} });
const history = await readJson('history.json', {});
const daily = await readJson('daily.json', {});
const checks = config.groups.flatMap((g) => g.checks.map((c) => ({ ...c, group: g.name })));

const results = {};
await Promise.all(
  checks.map(async (c) => {
    const old = prev.checks?.[c.id];
    const dueSec = (c.everyMinutes || 0) * 60 - 30;
    if (!process.env.FORCE && old && old.state !== 'down' && nowSec - old.checkedAt < dueSec) {
      results[c.id] = { ...old, skipped: true };
      return;
    }
    let r = await timed(() => runners[c.type](c));
    // Retry a failure once to filter out blips before recording it.
    if (r.state === 'down' && c.type !== 'workflow') {
      await new Promise((ok) => setTimeout(ok, 5000));
      r = await timed(() => runners[c.type](c));
    }
    r = slow(c, r);
    const failures = r.state === 'down' ? (old?.state === 'down' ? (old.failures || 1) + 1 : 1) : 0;
    const downSince = r.state === 'down' ? (old?.state === 'down' ? old.downSince : now.toISOString()) : undefined;
    results[c.id] = { state: r.state, message: r.message, ms: r.ms, link: r.link, checkedAt: nowSec, failures, downSince };
    console.log(`${r.state.padEnd(8)} ${String(r.ms).padStart(6)}ms  ${c.id}: ${r.message}`);
  }),
);

const cutoff = nowSec - config.historyDays * 86400;
const day = now.toISOString().slice(0, 10);
const oldestDay = new Date(now.getTime() - config.dailyDays * 86400e3).toISOString().slice(0, 10);
for (const c of checks) {
  const r = results[c.id];
  if (r.skipped) continue;
  history[c.id] = [...(history[c.id] || []).filter((s) => s[0] >= cutoff), [nowSec, STATE[r.state], r.ms]];
  if (r.state !== 'unknown') {
    const d = (daily[c.id] ||= {});
    const counts = (d[day] ||= [0, 0, 0]);
    counts[STATE[r.state]]++;
    for (const k of Object.keys(d)) if (k < oldestDay) delete d[k];
  }
}
for (const id of Object.keys(history)) if (!results[id]) delete history[id];
for (const id of Object.keys(daily)) if (!results[id]) delete daily[id];

try {
  await syncIssues(checks, results, prev);
} catch (e) {
  console.error(`issue sync failed: ${e.message}`);
}
const runUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : undefined;
for (const r of Object.values(results)) {
  if (!r.skipped) r.log = runUrl;
  if (r.state !== 'down') delete r.issue;
}

const states = Object.values(results).map((r) => r.state);
const overall = states.includes('down') ? 'down' : states.includes('degraded') ? 'degraded' : 'up';
const checksOut = Object.fromEntries(Object.entries(results).map(([id, { skipped, ...r }]) => [id, r]));
const status = { updatedAt: nowSec, overall, checks: checksOut };

await fs.mkdir(dataDir, { recursive: true });
await fs.writeFile(path.join(dataDir, 'status.json'), JSON.stringify(status, null, 1));
await fs.writeFile(path.join(dataDir, 'history.json'), JSON.stringify(history));
await fs.writeFile(path.join(dataDir, 'daily.json'), JSON.stringify(daily));

console.log(`overall: ${overall}`);
