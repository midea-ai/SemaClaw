/**
 * test-vision-input.ts — 多模态输入端到端规范化测试
 *
 * 不需要 LLM key，只测：
 *   1. inferVision 模式匹配
 *   2. loadImageAsBlock URL/base64/本地路径
 *   3. buildAgentInput 文本+附件混合规范化
 *   4. OpenAI adapter image 块降级（无 vision 时）
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { inferVision, modelHasVision, loadImageAsBlock, preprocessImage } from 'sema-core';
import { buildAgentInput } from './src/agent/InputBuilder';
import sharp from 'sharp';

const C = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', bold: '\x1b[1m' };
let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { console.log(`${C.green}✓${C.reset} ${name}`); pass++; }
  else { console.log(`${C.red}✗ ${name}${C.reset}${detail ? ' — ' + detail : ''}`); fail++; }
}
function section(s: string) { console.log(`\n${C.bold}${C.cyan}── ${s}${C.reset}`); }

(async () => {
  section('inferVision 模式匹配');
  check('gpt-4o → vision', inferVision('gpt-4o'));
  check('gpt-4o-mini → vision', inferVision('gpt-4o-mini'));
  check('claude-3-5-sonnet → vision', inferVision('claude-3-5-sonnet-20241022'));
  check('claude-opus-4 → vision', inferVision('claude-opus-4-7'));
  check('qwen-vl-max → vision', inferVision('qwen-vl-max'));
  check('qwen2.5-vl-72b → vision', inferVision('qwen2.5-vl-72b-instruct'));
  check('moonshot-v1-8k-vision-preview → vision', inferVision('moonshot-v1-8k-vision-preview'));
  check('glm-4v-plus → vision', inferVision('glm-4v-plus'));
  check('deepseek-vl2 → vision', inferVision('deepseek-vl2'));
  check('gpt-3.5-turbo → no vision', !inferVision('gpt-3.5-turbo'));
  check('deepseek-chat → no vision', !inferVision('deepseek-chat'));
  check('qwen-plus → no vision', !inferVision('qwen-plus'));

  section('modelHasVision 显式优先');
  check('显式 vision=true 覆盖推断', modelHasVision({
    name: 'x', provider: 'openai', modelName: 'gpt-3.5-turbo',
    apiKey: '', maxTokens: 1, contextLength: 1, vision: true,
  } as any));
  check('显式 vision=false 覆盖推断', !modelHasVision({
    name: 'x', provider: 'openai', modelName: 'gpt-4o',
    apiKey: '', maxTokens: 1, contextLength: 1, vision: false,
  } as any));

  section('loadImageAsBlock — URL / base64 / 本地路径');
  const urlBlock = await loadImageAsBlock('https://example.com/cat.png');
  check('http URL → url source', urlBlock.source.type === 'url' && (urlBlock.source as any).url === 'https://example.com/cat.png');

  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
  const dataBlock = await loadImageAsBlock(dataUrl);
  check('data URL → base64 source', dataBlock.source.type === 'base64' && (dataBlock.source as any).media_type === 'image/png');

  // 写一个 1x1 PNG 到临时路径
  const tmpPath = path.join(os.tmpdir(), `vision-test-${Date.now()}.png`);
  const pngBuf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(tmpPath, pngBuf);
  const fileBlock = await loadImageAsBlock(tmpPath);
  check('本地路径 → base64 source', fileBlock.source.type === 'base64' && (fileBlock.source as any).media_type === 'image/png');
  fs.unlinkSync(tmpPath);

  // 错误路径
  let errored = false;
  try { await loadImageAsBlock('/nonexistent/path.png'); } catch { errored = true; }
  check('不存在的文件 → 抛错', errored);

  errored = false;
  try { await loadImageAsBlock('relative/path.png'); } catch { errored = true; }
  check('相对路径 → 抛错', errored);

  errored = false;
  try { await loadImageAsBlock('/abs/path.bmp'); } catch { errored = true; }
  check('不支持格式 → 抛错', errored);

  section('buildAgentInput — 检测 + 规范化');
  const noImage = await buildAgentInput('hello world');
  check('纯文本 → 返回原字符串', typeof noImage.input === 'string' && noImage.input === 'hello world' && noImage.imageSrcs.length === 0);

  const urlInText = await buildAgentInput('look at this https://example.com/foo.png nice');
  check('文本中检出 URL', urlInText.imageSrcs.includes('https://example.com/foo.png') && Array.isArray(urlInText.input));

  const explicitOnly = await buildAgentInput('just text', [{ url: 'https://example.com/bar.jpg' }]);
  check('显式 attachments', explicitOnly.imageSrcs.includes('https://example.com/bar.jpg') && Array.isArray(explicitOnly.input));

  const dedupTest = await buildAgentInput('see https://example.com/x.png', [{ url: 'https://example.com/x.png' }]);
  check('显式 + 文本检出去重', dedupTest.imageSrcs.length === 1);

  const failureTest = await buildAgentInput('try @/nonexistent/zzz.png');
  check('失败转占位 (不抛错)', failureTest.failures.length === 1 && Array.isArray(failureTest.input));

  section('preprocessImage — 压缩 / 转码');

  // 生成一张 3000x3000 PNG（无 alpha）作为大图
  const bigPngBuf = await sharp({
    create: { width: 3000, height: 3000, channels: 3, background: { r: 200, g: 100, b: 50 } },
  }).png().toBuffer();
  const bigPngOut = await preprocessImage(bigPngBuf, 'image/png');
  check(
    `3000×3000 无 alpha PNG → JPEG 缩放`,
    bigPngOut.mime === 'image/jpeg' && bigPngOut.buf.length < bigPngBuf.length,
    `${bigPngBuf.length}B → ${bigPngOut.buf.length}B (${bigPngOut.mime})`,
  );
  const bigPngMeta = await sharp(bigPngOut.buf).metadata();
  check('缩放后长边 ≤ 1568', Math.max(bigPngMeta.width || 0, bigPngMeta.height || 0) <= 1568);

  // 带 alpha 的 PNG 不转 JPEG
  const alphaPngBuf = await sharp({
    create: { width: 2000, height: 2000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).png().toBuffer();
  const alphaOut = await preprocessImage(alphaPngBuf, 'image/png');
  check('带 alpha PNG 保持 PNG 格式', alphaOut.mime === 'image/png');
  const alphaMeta = await sharp(alphaOut.buf).metadata();
  check('带 alpha PNG 仍被缩放', Math.max(alphaMeta.width || 0, alphaMeta.height || 0) <= 1568);

  // 小图不动
  const smallPng = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).png().toBuffer();
  const smallOut = await preprocessImage(smallPng, 'image/png');
  check('小图无 alpha → 也转 JPEG（preferJpeg 默认 true）', smallOut.mime === 'image/jpeg');

  const smallOutNoConvert = await preprocessImage(smallPng, 'image/png', { preferJpeg: false });
  check('preferJpeg=false → 保持原格式', smallOutNoConvert.mime === 'image/png' && smallOutNoConvert.buf === smallPng);

  // GIF 不预处理
  const gifBuf = Buffer.from('R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=', 'base64');
  const gifOut = await preprocessImage(gifBuf, 'image/gif');
  check('GIF 跳过预处理', gifOut.mime === 'image/gif' && gifOut.buf === gifBuf);

  // loadImageAsBlock 走完整压缩链路
  const tmpBigPath = path.join(os.tmpdir(), `vision-big-${Date.now()}.png`);
  fs.writeFileSync(tmpBigPath, bigPngBuf);
  const block = await loadImageAsBlock(tmpBigPath);
  check(
    'loadImageAsBlock 大图自动压缩',
    block.source.type === 'base64' && (block.source as any).media_type === 'image/jpeg',
    `mime=${(block.source as any).media_type}`,
  );
  fs.unlinkSync(tmpBigPath);

  // preprocess: false 关闭
  const tmpRawPath = path.join(os.tmpdir(), `vision-raw-${Date.now()}.png`);
  fs.writeFileSync(tmpRawPath, bigPngBuf);
  const rawBlock = await loadImageAsBlock(tmpRawPath, { preprocess: false });
  check(
    'preprocess=false → 保持原图原格式',
    rawBlock.source.type === 'base64' && (rawBlock.source as any).media_type === 'image/png',
  );
  fs.unlinkSync(tmpRawPath);

  console.log(`\n${C.bold}Result: ${pass} passed, ${fail} failed${C.reset}`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
