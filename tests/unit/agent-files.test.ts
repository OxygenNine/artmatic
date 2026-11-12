import { describe, expect, it } from 'vitest';
import {
  FILE_TTL_SECONDS,
  base64Bytes,
  fileStillValid,
  imageKey,
  parseUpload,
  uploadForm,
} from '../../src/agent/llm/files';

/**
 * Files API 的本地守卫（不发请求）。
 *
 * 上传那一半只能靠真 key 验证，但**表单字段**与**响应解析**必须在这里钉住：
 * 字段名写错（`expires_after[anchor]` 是个带方括号的名字）不会报错，只会得到
 * 一个永久有效的文件 —— 然后账号在几个月后被截图撑满，而没有人知道为什么。
 */

/** 1×1 透明 PNG。 */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('base64Bytes', () => {
  it('解出来的长度是 4/3 的关系，且能吃 data URL', () => {
    const raw = base64Bytes(PNG);
    // 以 Node 的解码结果为准（base64 有末尾 padding，不能拿 3/4 硬乘）。
    expect(raw.byteLength).toBe(Buffer.from(PNG, 'base64').length);
    const withPrefix = base64Bytes(`data:image/png;base64,${PNG}`);
    expect(withPrefix.byteLength).toBe(raw.byteLength);
    // PNG 魔数：内容真的被解码了，不是原样拷贝字符串。
    expect([...raw.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe('uploadForm', () => {
  it('purpose 必须是 user_data，有效期靠两个**带方括号**的字段', () => {
    const form = uploadForm({ base64: PNG, mimeType: 'image/png' }, 'shot.png');
    expect(form.get('purpose')).toBe('user_data');
    expect(form.get('expires_after[anchor]')).toBe('created_at');
    expect(form.get('expires_after[seconds]')).toBe('2592000');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('默认有效期是 30 天（官方上限）：不传的话文件永久有效，配额迟早被截图撑满', () => {
    expect(FILE_TTL_SECONDS).toBe(2_592_000);
  });

  it('ttl=0 时两个 expires 字段都不发（= 永久）', () => {
    const form = uploadForm({ base64: PNG, mimeType: 'image/png' }, 'shot.png', 0);
    expect(form.get('expires_after[anchor]')).toBeNull();
    expect(form.get('expires_after[seconds]')).toBeNull();
  });
});

describe('parseUpload', () => {
  it('读 id 与 expires_at（秒 → 毫秒）', () => {
    expect(parseUpload({ id: 'file-api-xyz', bytes: 1234, expires_at: 1_700_000_000 })).toEqual({
      fileId: 'file-api-xyz',
      expiresAt: 1_700_000_000_000,
      bytes: 1234,
    });
  });

  it('没有 expires_at 就是不过期（null），不是 0 —— 0 会被判成已过期', () => {
    expect(parseUpload({ id: 'file-api-x' }).expiresAt).toBeNull();
    expect(fileStillValid(parseUpload({ id: 'file-api-x' }).expiresAt)).toBe(true);
  });

  it('没有 id 直接抛：让 undefined 混进历史会变成「图片永远缺失且没人知道」', () => {
    expect(() => parseUpload({})).toThrow();
    expect(() => parseUpload(null)).toThrow();
  });
});

describe('imageKey（同图去重）', () => {
  it('同样的图同一个键，不同图不同键', () => {
    const a = { base64: PNG, mimeType: 'image/png' };
    expect(imageKey(a)).toBe(imageKey({ ...a }));
    expect(imageKey(a)).not.toBe(imageKey({ base64: `${PNG.slice(0, -4)}AAAA`, mimeType: 'image/png' }));
    expect(imageKey(a)).not.toBe(imageKey({ base64: PNG, mimeType: 'image/jpeg' }));
  });
});

describe('fileStillValid', () => {
  it('缺失 / null 视为不过期；过期时间在将来才算有效', () => {
    expect(fileStillValid(undefined)).toBe(true);
    expect(fileStillValid(null)).toBe(true);
    expect(fileStillValid(Date.now() + 60_000)).toBe(true);
    expect(fileStillValid(Date.now() - 1)).toBe(false);
  });
});
