// quest 侧 v2 客户端 对打 0.2.0-rc.2 沙箱(3090)
import { NodeApiClient, unwrap } from './lib/dsh-client-v2.mjs';

const api = new NodeApiClient('http://127.0.0.1:3090', 20000, { tokenLog: process.env.TEMP + '\\dsh020-run2.log' });
const out = {};
try { const v = unwrap(await api.sessions.list({}), 'list'); out.list = 'ok items=' + (v.items?.length ?? '?'); }
catch (e) { out.list = 'FAIL ' + String(e.message).slice(0, 100); }

let sid = '';
try { const v = unwrap(await api.sessions.create({ cwd: '__HOME__\\dsh-020test' }), 'create'); sid = v.sessionId; out.create = 'ok'; }
catch (e) { out.create = 'FAIL ' + String(e.message).slice(0, 120); }

try { const r = await api.sessions.selectModel({ sessionId: sid, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }); out.selectModel = 'transport-ok ok=' + r.result.ok + (r.result.ok ? '' : ' err=' + String(r.result.error?.code)); }
catch (e) { out.selectModel = 'FAIL ' + String(e.message).slice(0, 120); }

try { const r = await api.sessions.prompt({ sessionId: sid, mode: 'queue', content: [{ type: 'text', text: 'quest连通测试' }] }); out.prompt = 'accept=' + r.result.ok; }
catch (e) { out.prompt = 'FAIL ' + String(e.message).slice(0, 120); }

try { const r = await api.sessions.updateQueue({ sessionId: sid }); out.updateQueue = 'transport-ok ok=' + r.result.ok; }
catch (e) { out.updateQueue = 'FAIL ' + String(e.message).slice(0, 120); }

try { const r = await api.sessions.cancel({ sessionId: sid }); out.cancel = 'transport-ok ok=' + r.result.ok; }
catch (e) { out.cancel = 'FAIL ' + String(e.message).slice(0, 120); }

try { const r = await api.workspace.archiveSession({ sessionId: sid }); out.archive = r.result.ok ? 'ok' : 'biz-err=' + String(r.result.error?.code); }
catch (e) { out.archive = 'FAIL ' + String(e.message).slice(0, 120); }

console.log(JSON.stringify(out, null, 1));
process.exit(0);
