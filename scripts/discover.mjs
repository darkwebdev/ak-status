#!/usr/bin/env node
// One-off discovery: lists every Arknights server host from each region's network config,
// resolves it, and probes it. Prints a markdown table (also to the Actions job summary).
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';

const REGIONS = {
  en: 'https://ak-conf.arknights.global/config/prod/official/network_config',
  jp: 'https://ak-conf.arknights.jp/config/prod/official/network_config',
  kr: 'https://ak-conf.arknights.kr/config/prod/official/network_config',
  cn: 'https://ak-conf.hypergryph.com/config/prod/official/network_config',
  bili: 'https://ak-conf.hypergryph.com/config/prod/b/network_config',
  tw: 'https://ak-conf-tw.gryphline.com/config/prod/official/network_config',
};
const t = (ms) => AbortSignal.timeout(ms);
const rows = [];
const raw = {};
for (const [region, url] of Object.entries(REGIONS)) {
  try {
    const j = await (await fetch(url, { signal: t(15000) })).json();
    const content = JSON.parse(j.content);
    const net = content.configs[content.funcVer].network;
    raw[region] = net;
    for (const [key, val] of Object.entries(net)) {
      if (typeof val !== 'string' || !/^https?:\/\//.test(val)) continue;
      const u = new URL(val.replace('{0}', 'Android'));
      let ips = '';
      try { ips = (await dns.resolve4(u.hostname)).join(' '); } catch (e) { ips = `DNS ${e.code}`; }
      let probe = '';
      const start = performance.now();
      try {
        const r = await fetch(u.href, { method: 'GET', signal: t(15000) });
        probe = `HTTP ${r.status}`;
        await r.arrayBuffer();
      } catch (e) { probe = e.name === 'TimeoutError' ? 'timeout' : String(e.cause?.code || e.message); }
      rows.push([region, key, val, ips, `${probe} (${Math.round(performance.now() - start)} ms)`]);
    }
  } catch (e) {
    rows.push([region, '-', url, '', `config failed: ${e.message}`]);
  }
}
let md = '| region | key | url | IPv4 | GET probe |\n|---|---|---|---|---|\n';
md += rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
md += `\n\n<details><summary>raw network sections</summary>\n\n\`\`\`json\n${JSON.stringify(raw, null, 1)}\n\`\`\`\n</details>\n`;
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, md);
