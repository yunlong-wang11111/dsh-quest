// sync-oss.mjs —— 把生产版文件同步到开源仓库，并强制清洗个人信息。
// 存在的理由：手工 cp 会把生产配置里的本机路径/账号 id 带进公开仓库（已发生两次）。
// 2026-09-22 重写：include 清单制改 **exclude 清单制**——清单制漂移过一次
// （lib/lit.mjs、tests 五个新文件、README、package.json 全没进清单，开源版落后 4 个版本，
// 且同步 server.mjs 后会 import 开源版不存在的 lib/lit.mjs 直接跑不起来）。
// 用法：node sync-oss.mjs   （在 quest 目录下；扫描不通过会以退出码 1 结束）
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'C:/Users/Solanine/dsh-plugins/quest';
const DST = 'C:/Users/Solanine/dsh-plugins/dsh-quest-oss';

// 不同步：仓库元文件（开源仓库自己维护）+ 生产专用的私人开发工具/运行时产物。
const EXCLUDE_FILES = new Set([
  'sync-oss.mjs',            // 同步工具本身（含清洗规则，留在生产侧）
  'archive-fix.mjs',         // 809 会话归档一次性脚本（引用 DSH 私有存储路径）
  'wire-notify.mjs',         // 生产通知接线脚本
  'package-lock.json',       // 注册表产物
  'dsh-plugin/package-lock.json',
  'LICENSE',                 // 内容一致，仓库元文件交给仓库自己
  '.gitignore', '.gitattributes',
  'quest-autostart.vbs.startup-backup',
]);
const EXCLUDE_DIR_NAMES = new Set(['node_modules', '.git']);
const EXCLUDE_PATTERNS = [/\.(bak|log)(~|$)/i, /\.bak-[0-9]/i, /~$/];

const USER = process.env.OSS_SCRUB_USER || 'Solanine';
const ACCOUNT = process.env.OSS_SCRUB_ID || '1586781618';

// 字符类 [\\/] 同时匹配反斜杠与正斜杠 → 吃掉任意转义层数
const RE_PATH = new RegExp('C:' + '[\\\\/]+' + 'Users' + '[\\\\/]+' + 'Solanine', 'gi');
const RE_ID = /1586781618/g;

const scrubText = (t) => t.replace(RE_PATH, '__HOME__').replace(RE_ID, '0');

function collect(dir, base = '', out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIR_NAMES.has(e.name)) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) collect(path.join(dir, e.name), rel, out);
    else out.push(rel);
  }
  return out;
}

const files = collect(SRC).filter((f) =>
  !EXCLUDE_FILES.has(f) && !EXCLUDE_PATTERNS.some((re) => re.test(f))
  && /\.(mjs|js|cjs|md|html|json|yml|yaml|txt|bat|ps1|vbs|css|svg|png|example)$/i.test(f));

let copied = 0, scrubbed = 0;
for (const f of files) {
  const src = path.join(SRC, f);
  const dst = path.join(DST, f);
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
