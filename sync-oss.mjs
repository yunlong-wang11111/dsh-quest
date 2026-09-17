// sync-oss.mjs —— 把生产版文件同步到开源仓库，并强制清洗个人信息。
// 存在的理由：手工 cp 会把生产配置里的本机路径/账号 id 带进公开仓库（已发生两次）。
// 用法：node sync-oss.mjs   （在 quest 目录下；扫描不通过会以退出码 1 结束）
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'C:/Users/Solanine/dsh-plugins/quest';
const DST = 'C:/Users/Solanine/dsh-plugins/dsh-quest-oss';

const FILES = [
  'server.mjs',
  'backends.mjs',
  'resume.mjs',
  'notify.mjs',
  'session-export.mjs',
  'dashboard.html',
  'dashboard-v2.html',
  'mcp-server.mjs',
  'dsh-plugin/index.js',
  'dsh-plugin/client.js',
  'PLAN-TEMPLATE.md',
  'start-quest.bat',
  'quest-autostart.vbs',
  'success.mjs',
  'tests/*',   // 目录扫描：手工列清单漏过文件（probe-lane.mjs），以后加测试不必改这里
  'tests/README.md',
  'tools/*',   // 目录扫描：手工列清单漏过文件（probe-lane.mjs、close-line.mjs），以后加工具不必改这里
];

const USER = process.env.OSS_SCRUB_USER || 'Solanine';
const ACCOUNT = process.env.OSS_SCRUB_ID || '1586781618';

// 字符类 [\\/] 同时匹配反斜杠与正斜杠 → 吃掉任意转义层数
const RE_PATH = new RegExp('C:' + '[\\\\/]+' + 'Users' + '[\\\\/]+' + 'Solanine', 'gi');
const RE_ID = /1586781618/g;

const scrubText = (t) => t.replace(RE_PATH, '__HOME__').replace(RE_ID, '0');

let copied = 0;
let scrubbed = 0;

// '/*' 结尾的条目展开为目录内全部文件（排除目录/隐藏文件），避免再漏同步
const FILES_EXPANDED = [];
for (const f of FILES) {
  if (!f.endsWith('/*')) { FILES_EXPANDED.push(f); continue; }
  const dir = f.slice(0, -2);
  for (const name of fs.readdirSync(path.join(SRC, dir)).sort()) {
    if (name.startsWith('.') || fs.statSync(path.join(SRC, dir, name)).isDirectory()) continue;
    FILES_EXPANDED.push(`${dir}/${name}`);
  }
}
for (const f of FILES_EXPANDED) {
  const src = path.join(SRC, f);
  const dst = path.join(DST, f);
  if (!fs.existsSync(src)) { console.log('跳过（不存在）:', f); continue; }
  const before = fs.readFileSync(src, 'utf8');
  const after = scrubText(before);
  if (after !== before) scrubbed++;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, after, 'utf8');
  copied++;
  console.log((after !== before ? '清洗+同步: ' : '同步:     ') + f);
}

const hits = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.(mjs|js|cjs|md|html|json|yml|yaml|txt|bat|ps1|vbs)$/.test(e.name)) continue;
    const t = fs.readFileSync(p, 'utf8');
    if (t.includes(USER) || t.includes(ACCOUNT)) hits.push(path.relative(DST, p));
  }
}
walk(DST);

console.log('');
console.log('同步 ' + copied + ' 个文件，清洗 ' + scrubbed + ' 处');
if (hits.length) {
  console.log('★ 仍有个人信息残留，禁止提交：');
  for (const h of hits) console.log('   ' + h);
  process.exit(1);
}
console.log('扫描通过：仓库内无个人信息');
