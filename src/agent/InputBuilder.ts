/**
 * InputBuilder — 把用户原始 prompt（可能含图片 URL / 本地路径）和显式附件
 * 规范化为 sema-core 能直接吃的 `string | ContentBlockParam[]`。
 *
 * 检测规则：
 *   1. 显式 `attachments` 数组（来自 channel / web UI 上传）—— 直接当 image。
 *   2. 文本中出现 `http(s)://...png|jpg|jpeg|gif|webp` —— 抽出来当 image，文本中保留原 URL（让历史记录有迹可循）。
 *   3. 文本中出现 `@/abs/path/to/img.{png,jpg,...}` —— 抽出来当 image，沿用现有 file reference 风格。
 *
 * 没图时返回原字符串（零开销，老路径继续生效）。
 */
import type Anthropic from '@anthropic-ai/sdk';
import { loadImageAsBlock, ImageLoadError } from 'sema-core';

export interface ImageAttachment {
  /** http(s) URL / 绝对路径 / file:// / data: URL */
  url: string;
  mimeType?: string;
}

const URL_IMAGE_REGEX = /(https?:\/\/\S+?\.(?:png|jpe?g|gif|webp))(?:\?\S*)?/gi;
const AT_PATH_IMAGE_REGEX = /(?:^|\s)@(\/[^\s'"`<>]+\.(?:png|jpe?g|gif|webp))/gi;

export interface BuildResult {
  /** 喂给 core.processUserInput 的最终 input */
  input: string | Anthropic.ContentBlockParam[];
  /** 抽到的图片源（用于持久化、日志） */
  imageSrcs: string[];
  /** 加载失败的图片占位说明 */
  failures: string[];
}

/**
 * 主入口：构造给 core 的 input。
 *
 * - prompt: 用户原始文本（已含 memory 注入也行，会原样保留在 text block 里）
 * - attachments: channel/UI 显式上传的附件
 */
export async function buildAgentInput(
  prompt: string,
  attachments?: ImageAttachment[],
): Promise<BuildResult> {
  const explicitSrcs = (attachments ?? [])
    .filter((a) => a && typeof a.url === 'string' && a.url.length > 0)
    .map((a) => a.url);

  const detectedFromText = detectImagesInText(prompt);
  const allSrcs = dedupe([...explicitSrcs, ...detectedFromText]);

  if (allSrcs.length === 0) {
    return { input: prompt, imageSrcs: [], failures: [] };
  }

  const failures: string[] = [];
  const imageBlocks: Anthropic.ImageBlockParam[] = [];
  for (const src of allSrcs) {
    try {
      imageBlocks.push(await loadImageAsBlock(src));
    } catch (e) {
      const msg = e instanceof ImageLoadError ? e.message : `加载失败: ${String(e)}`;
      failures.push(`${src} — ${msg}`);
    }
  }

  // 文本里把 `@/path` 引用替换为 [image:basename]，URL 保留原样让用户/历史可读
  const cleanedText = stripAtPathRefs(prompt);

  const blocks: Anthropic.ContentBlockParam[] = [];
  if (cleanedText.trim().length > 0) {
    blocks.push({ type: 'text', text: cleanedText });
  }
  for (const ib of imageBlocks) blocks.push(ib);
  if (failures.length > 0) {
    blocks.push({
      type: 'text',
      text: `[image-load-warnings]\n${failures.map((f) => `- ${f}`).join('\n')}`,
    });
  }

  return {
    input: blocks.length > 0 ? blocks : prompt,
    imageSrcs: allSrcs,
    failures,
  };
}

/**
 * 探测文本中的图片地址（URL + @path 形式）。
 */
function detectImagesInText(text: string): string[] {
  const found: string[] = [];
  let m: RegExpExecArray | null;

  URL_IMAGE_REGEX.lastIndex = 0;
  while ((m = URL_IMAGE_REGEX.exec(text)) !== null) {
    found.push(m[1]);
  }

  AT_PATH_IMAGE_REGEX.lastIndex = 0;
  while ((m = AT_PATH_IMAGE_REGEX.exec(text)) !== null) {
    found.push(m[1]);
  }

  return found;
}

/**
 * 把 `@/path/to/img.png` 替换为 [image:img.png] 占位文本，避免下游误把它当 file reference 处理。
 * URL 形式保留原文。
 */
function stripAtPathRefs(text: string): string {
  return text.replace(AT_PATH_IMAGE_REGEX, (_full, p) => {
    const name = String(p).split('/').pop() || 'image';
    return ` [image:${name}]`;
  });
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
