/**
 * sema-core 1.0.0 的 ModelManager.addNewModel → convertToModelProfile 不透传 vision 字段。
 * 这里把 SemaClaw 的 LLMConfig 同步到 sema-core 单例，并在 addNewModel 之后把
 * vision 字段直接补到内存中的 ModelProfile 上 + 持久化到 ~/.sema/model.conf。
 *
 * 不修改 vendored sema-core 即可让用户在 UI 里的 vision 开关真正生效。
 */
import { getModelManager } from 'sema-core';
import type { LLMConfig } from './GroupManager';

interface InternalModelProfile {
  name: string;
  provider: string;
  modelName: string;
  vision?: boolean;
  [k: string]: unknown;
}

interface InternalManager {
  config: { modelProfiles: InternalModelProfile[] };
  saveConfig: () => Promise<void>;
}

/**
 * upsert sema-core 中的 model profile，并把 vision 显式覆盖回内存 + 磁盘。
 */
export async function syncLLMConfigToCore(cfg: LLMConfig): Promise<void> {
  const mm = getModelManager();
  await mm.addNewModel(
    {
      provider: cfg.provider,
      modelName: cfg.modelName,
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
      maxTokens: cfg.maxTokens,
      contextLength: cfg.contextLength,
      adapt: cfg.adapt,
      // sema-core 的 convertToModelProfile 当前会丢弃 vision，但仍然传入
      // 以便上游修复后能直接生效；下面的 patch 是当前版本的兜底
      ...(typeof cfg.vision === 'boolean' ? { vision: cfg.vision } : {}),
    },
    true /* skipValidation：UI 已测过 */,
  );
  await applyVisionOverride(cfg);
}

/**
 * 把 LLMConfig.vision 写回 sema-core 内存 profile，并持久化到 model.conf。
 * - vision === true/false → 显式覆盖
 * - vision === undefined → 清除显式字段，回到 sema-core 的 inferVision 兜底
 *
 * 直接 mutate sema-core 内部 config（vendored 1.0.0 没暴露 API），后续 sema-core
 * 升级后可改成正规接口。
 */
export async function applyVisionOverride(cfg: LLMConfig): Promise<void> {
  const mm = getModelManager() as unknown as InternalManager;
  const profile = mm.config.modelProfiles.find(
    (p) => p.provider === cfg.provider && p.modelName === cfg.modelName,
  );
  if (!profile) return;

  if (typeof cfg.vision === 'boolean') {
    if (profile.vision === cfg.vision) return;
    profile.vision = cfg.vision;
  } else {
    if (profile.vision === undefined) return;
    delete profile.vision;
  }
  try {
    await mm.saveConfig();
  } catch (e) {
    console.warn('[llmModelSync] saveConfig after vision patch failed:', e);
  }
}
