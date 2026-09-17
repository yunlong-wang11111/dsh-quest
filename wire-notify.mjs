// 接线：通知出口改走 notify.mjs（provider 无关），保留原有的重试/队列逻辑
import fs from 'node:fs';
const F = 'server.mjs';
let t = fs.readFileSync(F, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';
let n = 0;

// 1) import
if (!t.includes("from './notify.mjs'")) {
  const a = "import { completeText, workerViaBackend, fixerViaBackend, describeBackends } from './backends.mjs';";
  t = t.replace(a, a + NL + "import { sendText, sendImage, notifyKind } from './notify.mjs';");
  n++; console.log('✓ import notify');
}

// 2) qqPushDirect → 走 sendText
const pushStart = t.indexOf('async function qqPushDirect(message) {');
const pushEnd = t.indexOf('\n}\n', pushStart) + 3;
if (pushStart > 0) {
  const newFn = [
    'async function qqPushDirect(message) {',
    '  // provider 无关：bridge / webhook / off（见 notify.mjs），默认关闭',
    '  const r = await sendText(CFG, message, { fs, timeoutMs: 8000 });',
    '  if (!r.ok && r.error !== \'off\') log(\'通知发送失败:\', r.error);',
    '  return r.ok;',
    '}',
    '',
  ].join(NL);
  t = t.slice(0, pushStart) + newFn + t.slice(pushEnd);
  n++; console.log('✓ qqPushDirect 改为 sendText');
}

// 3) qqPushImage → 走 sendImage
const imgStart = t.indexOf('async function qqPushImage(wsKey, imagePath, caption) {');
const imgEnd = t.indexOf('\n}\n', imgStart) + 3;
if (imgStart > 0) {
  const newFn = [
    'async function qqPushImage(wsKey, imagePath, caption) {',
    '  const r = await sendImage(CFG, imagePath, `${qqTag(wsKey)}${caption}`, { fs, timeoutMs: 20000 });',
    '  if (!r.ok && r.error !== \'off\') log(\'图片直推失败:\', r.error);',
    '  return r.ok;',
    '}',
    '',
  ].join(NL);
  t = t.slice(0, imgStart) + newFn + t.slice(imgEnd);
  n++; console.log('✓ qqPushImage 改为 sendImage');
}

// 4) qqPush 的开关判断：改为按 notifyKind
const gateOld = 'async function qqPush(wsKey, message) {';
if (t.includes(gateOld) && !t.includes('notifyKind(CFG)')) {
  t = t.replace(gateOld, gateOld + NL + '  if (notifyKind(CFG) === \'off\') return;');
  n++; console.log('✓ qqPush 开关改按 notifyKind');
}

// 5) finishNode / 产物图里的 CFG.qqNotify?.enabled 判断也统一
t = t.replace(/if \(!node\.quiet && CFG\.qqNotify\?\.enabled\)/g, "if (!node.quiet && notifyKind(CFG) !== 'off')");
t = t.replace(/node\.quiet && CFG\.qqNotify\?\.enabled\) qqPush/g, "node.quiet && notifyKind(CFG) !== 'off') qqPush");

// 6) 启动日志显示通知方式
const startAnchor = 'try { const _b = describeBackends(CFG);';
if (t.includes(startAnchor) && !t.includes('notifyKind(CFG)')) {
  t = t.replace(startAnchor, "try { log('通知出口:', notifyKind(CFG)); } catch {}" + NL + '  ' + startAnchor);
  n++; console.log('✓ 启动日志');
}

fs.writeFileSync(F, t, 'utf8');
console.log('共', n, '处');
