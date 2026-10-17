// Node.js 22+; no dependencies. Prompts arrive through CLI arguments or stdin.
import { parseArgs } from 'node:util';
import { loadEnvFile } from 'node:process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

async function main() {
  const { values } = parseArgs({ options: {
    prompt: { type: 'string' },
    name: { type: 'string', default: 'image' },
    count: { type: 'string', default: '1' },
    reference: { type: 'string', multiple: true, default: [] },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('npm run images -- --prompt "生成指示" [--name flame] [--count 2] [--reference image.png] [--dry-run]');
    console.log('指示は標準入力からも渡せます。--countは同じ指示で呼び出す回数です。');
    return;
  }
  try { loadEnvFile(path.join(root, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error('--count は1〜20の整数にしてください。');
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(values.name)) {
    throw new Error('--name は英数字・ハイフン・アンダースコア（64文字以内）にしてください。');
  }
  let prompt = values.prompt;
  if (prompt === undefined && !process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    prompt = '';
    for await (const chunk of process.stdin) prompt += chunk;
  }
  if (!prompt?.trim()) throw new Error('--prompt または標準入力で生成指示を渡してください。');

  const model = process.env.GEMINI_IMAGE_MODEL?.trim() || 'gemini-nano-banana-2.1';
  const size = process.env.GEMINI_IMAGE_SIZE?.trim() || '1K';
  const aspectRatio = process.env.GEMINI_IMAGE_ASPECT_RATIO?.trim() || '1:1';
  if (!['1K', '2K', '4K'].includes(size)) throw new Error('GEMINI_IMAGE_SIZE は1K・2K・4Kのいずれかにしてください。');
  if (!/^\d+:\d+$/.test(aspectRatio)) throw new Error('GEMINI_IMAGE_ASPECT_RATIO は1:1のように指定してください。');

  const input = [{ type: 'text', text: prompt.trim() }];
  for (const filename of values.reference) {
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(filename).toLowerCase()];
    if (!mime) throw new Error('参照画像はPNG・JPEG・WebPにしてください。');
    const bytes = await readFile(path.resolve(filename));
    input.push({ type: 'image', mime_type: mime, data: bytes.toString('base64') });
  }
  const body = {
    model, input, store: false,
    response_format: [{ type: 'image', image_size: size, aspect_ratio: aspectRatio }],
  };
  console.log(`model=${model}, size=${size}, aspect=${aspectRatio}, requests=${count}, references=${values.reference.length}`);
  if (values['dry-run']) {
    console.log('設定・入力の検証OK。API呼び出し・画像保存は行っていません。');
    return;
  }
  const apiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  if (!apiKey) throw new Error('effect-assets/.envにGEMINI_API_KEYを入力してください。');

  const outDir = path.join(here, 'output');
  await mkdir(outDir, { recursive: true });
  for (let i = 0; i < count; i++) {
    console.log(`生成中 ${i + 1}/${count}（API利用料金が発生します）`);
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    let result;
    try { result = await response.json(); }
    catch { throw new Error(`APIがJSON以外を返しました（HTTP ${response.status}）。自動再試行はしません。`); }
    if (!response.ok || result.error) {
      const detail = typeof result.error?.message === 'string' ? result.error.message : 'request failed';
      throw new Error(`APIエラー（HTTP ${response.status}）: ${detail.split(apiKey).join('[REDACTED]').slice(0, 600)}`);
    }
    if (result.status !== 'completed') {
      throw new Error(`生成は完了しませんでした（status=${result.status ?? 'unknown'}）。自動再試行はしません。`);
    }
    const parts = (result.steps || []).filter(step => step.type === 'model_output').flatMap(step => step.content || []);
    const images = parts.filter(part => part.type === 'image' && part.data);
    if (!images.length) throw new Error('画像が返りませんでした。指示・モデル・利用制限を確認してください。');
    for (const image of images) {
      const ext = extensions[image.mime_type];
      if (!ext) throw new Error(`未対応の出力形式です: ${image.mime_type}`);
      const bytes = Buffer.from(image.data, 'base64');
      const valid = ext === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : ext === 'jpg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!valid) throw new Error('画像データと出力形式が一致しないため保存しませんでした。');
      const filename = `${values.name}-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
      const destination = path.join(outDir, filename);
      await writeFile(destination, bytes, { flag: 'wx' });
      console.log(`保存: ${destination}`);
    }
  }
}

main().catch(error => {
  const secrets = [process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY].filter(Boolean);
  let message = error.name === 'TimeoutError' ? 'APIがタイムアウトしました。課金・完了状況を確認してから再実行してください。' : error.message;
  for (const secret of secrets) message = message.split(secret).join('[REDACTED]');
  console.error(message);
  process.exitCode = 1;
});
