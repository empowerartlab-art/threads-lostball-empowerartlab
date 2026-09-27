// 秘密値をログ・エラーメッセージから除去する共通ユーティリティ(テーマ非依存)。

export function createSecretRedactor(secrets) {
  const list = (secrets || []).filter(Boolean).map(String);
  return function redact(input) {
    if (input == null) return input;
    let text = String(input);
    for (const secret of list) {
      if (secret) text = text.split(secret).join("[REDACTED]");
    }
    return text;
  };
}
