// 统一状态接口第 ① 层的公开入口：Main 与 Renderer 只从这里导入。
export { projectFacts, DETAIL_LIMIT, LABEL_LIMIT, RAW_LIMIT_BYTES, type FactInput } from './facts';
export {
  REDACTED,
  TEXT_LIMIT,
  redact,
  redactDebugSnapshot,
  redactFact,
  redactPath,
  redactSecrets,
  redactTransition,
  redactUrl,
  sha256Hex,
  sshAlias,
  truncateText,
  type RedactContext,
} from './redact';
