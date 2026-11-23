#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MARKER = '<!-- cc-knowledge-butler:index:v1 -->';
const PREFIX = '<!-- cc-knowledge-butler:record:v1 ';
// 兼容旧版 chat-knowledge 生成的目录与卡片：可读取，新写入使用新标记。
const LEGACY_MARKER = '<!-- chat-knowledge:index:v1 -->';
const LEGACY_PREFIX = '<!-- chat-knowledge:record:v1 ';
const KINDS = { knowledge: '知识', idea: '想法', checkpoint: '进度' };
const ORIGINS = { user: '用户', assistant: 'AI', joint: '共同整理', source: '资料摘录' };
const STATES = { confirmed: '已明确确认', proposed: '设想或建议', unverified: '待核验' };

async function statOrNull(file) {
  try { return await fs.lstat(file); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function plain(file, type) {
  const st = await statOrNull(file);
  if (!st || st.isSymbolicLink() || (type === 'dir' ? !st.isDirectory() : !st.isFile())) {
    throw new Error(`路径缺失、类型错误或为链接：${file}`);
  }
  return st;
}
async function setup(root, initialize = false) {
  const realRoot = await fs.realpath(root);
  await plain(realRoot, 'dir');
  const base = path.join(realRoot, '对话资产');
  const existing = await statOrNull(base);
  if (!existing) {
    if (!initialize) throw new Error('尚未初始化，请先运行 init 并确认保存目录。');
    await fs.mkdir(base);
  }
  await plain(base, 'dir');
  const index = path.join(base, '目录.md');
  const hasIndex = await statOrNull(index);
  if (!hasIndex) {
    if (!initialize || (await fs.readdir(base)).length) {
      throw new Error(`同名目录已有未接管内容或缺少管理索引，保留现场：${base}`);
    }
    await fs.writeFile(index, `${MARKER}\n# 对话资产目录\n`, { flag: 'wx' });
  }
  await plain(index, 'file');
  const indexHead = (await fs.readFile(index, 'utf8')).replace(/\r\n/g, '\n');
  if (!indexHead.startsWith(MARKER + '\n') && !indexHead.startsWith(LEGACY_MARKER + '\n')) {
    throw new Error(`目录不是本技能的受管索引，不覆盖：${index}`);
  }
  return { base, index };
}
async function locked(store, work) {
  const file = path.join(store.base, '.write.lock');
  let lock;
  try { lock = await fs.open(file, 'wx'); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Error(`存在写入锁，请确认无进行中的任务后处理：${file}`);
    throw e;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return await work();
  } finally { await lock.close(); await fs.unlink(file); }
}
async function ensureFolders(store) {
  for (const folder of Object.values(KINDS)) {
    const dir = path.join(store.base, folder);
    if (!(await statOrNull(dir))) await fs.mkdir(dir);
    await plain(dir, 'dir');
  }
}
async function header(file) {
  await plain(file, 'file');
  const handle = await fs.open(file, 'r');
  const buffer = Buffer.alloc(16384);
  let first;
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    first = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0].replace(/\r$/, '');
  } finally { await handle.close(); }
  const prefix = first.startsWith(PREFIX) ? PREFIX : first.startsWith(LEGACY_PREFIX) ? LEGACY_PREFIX : null;
  if (!prefix || !first.endsWith(' -->')) throw new Error(`记录元数据缺失：${file}`);
  let meta;
  try { meta = JSON.parse(first.slice(prefix.length, -4)); }
  catch { throw new Error(`记录元数据无法解析：${file}`); }
  if (!/^[a-f0-9]{16}$/.test(meta.id) || !Object.hasOwn(KINDS, meta.kind) ||
      typeof meta.title !== 'string' || typeof meta.summary !== 'string' ||
      !Array.isArray(meta.keywords) || !meta.keywords.every(x => typeof x === 'string') ||
      !Number.isFinite(Date.parse(meta.createdAt)) || path.basename(file) !== `${meta.id}.md`) {
    throw new Error(`记录元数据不合法：${file}`);
  }
  return meta;
}
const SYSTEM_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
async function records(store, skipped = []) {
  const list = [];
  for (const [kind, folder] of Object.entries(KINDS)) {
    const dir = path.join(store.base, folder);
    if (!(await statOrNull(dir))) continue;
    await plain(dir, 'dir');
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9]{16}\.md$/.test(entry.name)) {
        // 系统文件静默跳过；其他非受管文件跳过但报告，不中断检索与保存。
        if (!SYSTEM_FILES.has(entry.name.toLowerCase())) skipped.push(path.join(dir, entry.name));
        continue;
      }
      const file = path.join(dir, entry.name);
      const meta = await header(file);
      if (meta.kind !== kind) throw new Error(`分类与元数据不一致：${file}`);
      list.push({ ...meta, file, relative: `${folder}/${entry.name}` });
    }
  }
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}
const cell = value => String(value).replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
function indexText(list) {
  let text = `${MARKER}\n# 对话资产目录\n\n自动生成；每类只显示最近 10 条。旧记录用搜索定位，再按 ID 读取正文。\n\n`;
  for (const [kind, folder] of Object.entries(KINDS)) {
    const subset = list.filter(x => x.kind === kind);
    text += `## ${folder}（共 ${subset.length} 条）\n\n| 记录 | 简述 |\n|---|---|\n`;
    for (const row of subset.slice(0, 10)) {
      const title = cell(row.title).replace(/[\[\]]/g, '');
      text += `| [${title}](${encodeURI(row.relative)}) | ${cell(row.summary)} |\n`;
    }
    text += '\n';
  }
  return text;
}
async function writeIndex(store, list) {
  await plain(store.index, 'file');
  const temp = path.join(store.base, `.index-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, indexText(list), { flag: 'wx' });
    await fs.rename(temp, store.index);
  } finally {
    if (await statOrNull(temp)) await fs.unlink(temp);
  }
}
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('输入必须是 JSON 对象。');
  const required = { title: 100, summary: 300, body: 24000 };
  for (const [key, max] of Object.entries(required)) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > max) {
      throw new Error(`${key} 必须是非空文字，长度不超过 ${max}。`);
    }
  }
  if (!Object.hasOwn(KINDS, input.kind) || !Object.hasOwn(ORIGINS, input.origin) || !Object.hasOwn(STATES, input.status)) {
    throw new Error('kind、origin 或 status 无效。');
  }
  if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 20 ||
      !input.sources.every(x => typeof x === 'string' && x.trim() && x.length <= 2000)) {
    throw new Error('sources 必须包含 1～20 条有效来源。');
  }
  if (!Array.isArray(input.keywords) || input.keywords.length > 12 ||
      !input.keywords.every(x => typeof x === 'string' && x.trim() && x.length <= 40)) {
    throw new Error('keywords 必须是最多 12 个短词。');
  }
  if (input.userQuote !== undefined && (typeof input.userQuote !== 'string' || input.userQuote.length > 2000)) {
    throw new Error('userQuote 必须是短引文。');
  }
  if (input.origin === 'user' && !input.userQuote?.trim()) throw new Error('归属为用户时须提供可核对的原话。');
  return {
    kind: input.kind, title: input.title.trim(), summary: input.summary.trim(),
    origin: input.origin, status: input.status, userQuote: input.userQuote?.trim() || '',
    keywords: [...new Set(input.keywords.map(x => x.trim()))].sort(),
    sources: input.sources.map(x => x.trim()), body: input.body.trim(),
  };
}
function markdown(row, meta) {
  const json = JSON.stringify(meta).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
  let text = `${PREFIX}${json} -->\n# ${row.title}\n\n`;
  text += `- 记录时间：${meta.createdAt}\n- 内容归属：${ORIGINS[row.origin]}\n- 确认状态：${STATES[row.status]}\n`;
  text += `- 关键词：${row.keywords.join('、')}\n\n## 简述\n\n${row.summary}\n\n`;
  if (row.userQuote) text += `## 用户原话\n\n${row.userQuote.split('\n').map(x => `> ${x}`).join('\n')}\n\n`;
  text += `## 内容\n\n${row.body}\n\n## 来源\n\n${row.sources.map(x => `- ${x.replace(/[\r\n]/g, ' ')}`).join('\n')}\n`;
  return text;
}
function match(row, query) {
  const text = [row.title, row.summary, ...row.keywords].join(' ').toLocaleLowerCase();
  return query.toLocaleLowerCase().trim().split(/\s+/).every(word => text.includes(word));
}
function brief(row) {
  return { id: row.id, kind: row.kind, title: row.title, summary: row.summary, createdAt: row.createdAt, file: row.file };
}

export async function run(args) {
  const [command, root, value] = args;
  if (!['init', 'save', 'search', 'read', 'resume', 'check'].includes(command) || !root) {
    throw new Error('用法：store.mjs init|save|search|read|resume|check 根目录 [输入JSON路径|关键词|记录ID]');
  }
  const store = await setup(root, command === 'init');
  if (command === 'init' || command === 'check') {
    return locked(store, async () => {
      await ensureFolders(store);
      const skipped = [];
      const list = await records(store, skipped);
      await writeIndex(store, list);
      return { ok: true, command, count: list.length, index: store.index, skipped };
    });
  }
  if (command === 'save') {
    if (!value) throw new Error('save 需要临时 JSON 路径。');
    const input = JSON.parse((await fs.readFile(value, 'utf8')).replace(/^\uFEFF/, ''));
    const row = validate(input);
    const id = createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0, 16);
    return locked(store, async () => {
      await ensureFolders(store);
      const before = await records(store);
      const found = before.find(x => x.id === id);
      if (found) {
        await writeIndex(store, before);
        return { ok: true, duplicate: true, ...brief(found) };
      }
      const file = path.join(store.base, KINDS[row.kind], `${id}.md`);
      const meta = { id, kind: row.kind, title: row.title, summary: row.summary, keywords: row.keywords, createdAt: new Date().toISOString() };
      await fs.writeFile(file, markdown(row, meta), { flag: 'wx' });
      const after = await records(store);
      await writeIndex(store, after);
      return { ok: true, duplicate: false, ...brief(after.find(x => x.id === id)) };
    });
  }
  const skipped = [];
  const list = await records(store, skipped);
  if (command === 'search') {
    if (!value?.trim()) throw new Error('search 需要关键词。');
    const found = list.filter(x => match(x, value));
    return { ok: true, total: found.length, results: found.slice(0, 10).map(brief), skipped };
  }
  if (command === 'read') {
    if (!/^[a-f0-9]{16}$/.test(value || '')) throw new Error('记录 ID 必须是 16 位十六进制值。');
    const found = list.find(x => x.id === value);
    if (!found) throw new Error(`没有找到记录 ID：${value}`);
    return { ok: true, ...brief(found), content: await fs.readFile(found.file, 'utf8') };
  }
  const found = list.find(x => x.kind === 'checkpoint' && (!value || match(x, value)));
  return found ? { ok: true, candidate: true, ...brief(found), content: await fs.readFile(found.file, 'utf8') }
    : { ok: true, candidate: false, message: '没有找到匹配的进度记录，不推测过去状态。' };
}

if (process.argv[1] && await fs.realpath(path.resolve(process.argv[1])).catch(() => '') === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(error => {
    process.stderr.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
    process.exitCode = 1;
  });
}
