#!/usr/bin/env node
// 抓取 sub.cmliussss.net 的地区反代池 → 输出 WorkerVless2sub 的 ADDAPI 可用的纯文本清单
// 用法:
//   node tools/pool-fetcher.mjs                     # 抓取 + TLS 验证，写 region-ips.txt
//   node tools/pool-fetcher.mjs --no-verify         # 只抓取，不验证
//   node tools/pool-fetcher.mjs --out my.txt
//   node tools/pool-fetcher.mjs --concurrency 24 --timeout 4000
import { writeFileSync } from 'node:fs';
import tls from 'node:tls';

const GEN = 'https://sub.cmliussss.net/sub?host=example.com&uuid=00000000-0000-4000-8000-000000000000';
// 上游只认带 edgetunnel 特征串的 UA，普通 UA 会拿到“旧版已停止支持”的假节点
const UA = 'v2rayN/edgetunnel (https://github.com/cmliu/edgetunnel) Uid/0x000000 Version/2';
const SNI = 'edgetunnel-2z2.pages.dev';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};

const outFile = String(arg('out', 'region-ips.txt'));
const verify = !argv.includes('--no-verify');
const timeout = Number(arg('timeout', 4000));
const concurrency = Number(arg('concurrency', 16));

const parse = (b64) => {
  let text;
  try { text = Buffer.from(b64.trim(), 'base64').toString('utf8'); }
  catch { throw new Error('上游返回的不是合法 base64'); }

  const seen = new Set();
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^[a-z0-9]+:\/\/[^@]+@([\d.]+:\d+)/i);
    if (!m) continue;
    const addr = m[1];
    const rm = line.match(/#([^#]+)$/);
    const region = rm ? decodeURIComponent(rm[1]).trim().toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(region)) continue;
    const entry = `${addr}#${region}`;
    if (seen.has(entry)) continue;
    seen.add(entry);
    rows.push(entry);
  }
  return rows;
};

const probe = (entry) => new Promise((resolve) => {
  const [addr] = entry.split('#');
  const [host, port] = addr.split(':');
  const sock = tls.connect({ host, port: Number(port), servername: SNI, rejectUnauthorized: false, timeout });
  const done = (ok) => { sock.destroy(); resolve({ entry, ok }); };
  sock.once('secureConnect', () => done(true));
  sock.once('timeout', () => done(false));
  sock.once('error', () => done(false));
});

const runPool = async (items, worker, limit) => {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
    }
  }));
  return out;
};

const main = async () => {
  console.log(`[1/3] 拉取生成器 ${GEN}`);
  const res = await fetch(GEN, { headers: { 'User-Agent': UA, Accept: 'text/plain' } });
  if (!res.ok) throw new Error(`上游 HTTP ${res.status}`);
  const rows = parse(await res.text());
  console.log(`      解析到 ${rows.length} 条地区地址`);

  let keep = rows;
  if (verify) {
    console.log(`[2/3] TLS 验证 ${rows.length} 条（并发 ${concurrency}，超时 ${timeout}ms）`);
    const results = await runPool(rows, probe, concurrency);
    keep = results.filter((r) => r.ok).map((r) => r.entry);
    console.log(`      存活 ${keep.length}/${rows.length}`);
  } else {
    console.log('[2/3] 跳过验证');
  }

  keep.sort();
  writeFileSync(outFile, keep.join('\n') + '\n', 'utf8');
  const byRegion = keep.reduce((a, e) => { const r = e.split('#')[1]; a[r] = (a[r] || 0) + 1; return a; }, {});
  console.log(`[3/3] 已写入 ${outFile}  ${Object.entries(byRegion).sort().map(([k, v]) => `${k}:${v}`).join(' ')}`);

  if (keep.length < 5) {
    console.error('可用地址过少，保留旧文件更稳妥');
    process.exitCode = 2;
  }
};

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
