#!/usr/bin/env node
// bin 包装（2026-11-06）：npm 对直接指向 src 目录外/带嵌套路径的 bin 条目有校验怪癖
// （publish 时 "script name invalid and removed"）——用本文件做唯一 bin 入口，
// 内容仅转发到真正的 mcp-server.mjs。
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp-server.mjs')).href);
