import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { extractPublicDocument, fetchPublicDocument, isPublicAddress, parsePublicUrl, renderReaderDocument } from './public-document';

const htmlHeaders = { 'content-type': 'text/html; charset=utf-8' };
const response = (text: string, status = 200, headers: Record<string, string> = htmlHeaders) => ({
  status,
  headers,
  body: Buffer.from(text),
});

describe('公开文档网络边界', () => {
  it('仅 HTTPS 默认端口且没有用户凭据', () => {
    expect(parsePublicUrl('https://example.com/a#part').href).toBe('https://example.com/a');
    for (const url of [
      'http://example.com',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://user:pass@example.com',
      'https://example.com:444/',
      'https://localhost/',
      'https://127.1/',
      'https://[::1]/',
    ]) {
      expect(() => parsePublicUrl(url), url).toThrow();
    }
  });
  it('拒绝私网、保留网、IPv4 映射及转换网段', () => {
    for (const address of [
      '127.0.0.1',
      '0.0.0.0',
      '10.1.2.3',
      '169.254.169.254',
      '172.31.2.3',
      '192.168.1.2',
      '100.64.0.1',
      '192.0.0.9',
      '192.0.2.1',
      '198.18.0.1',
      '198.51.100.2',
      '203.0.113.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fc00::1',
      'fe80::1',
      'ff02::1',
      '::ffff:8.8.8.8',
      '64:ff9b::808:808',
      '64:ff9b:1::1',
      '2001:db8::1',
      '2002:0808:0808::1',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    for (const address of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888'])
      expect(isPublicAddress(address), address).toBe(true);
  });
  it('DNS 的所有地址都必须是公网，连接固定到已校验的 IP', async () => {
    const request = vi.fn(async () => response('<title>真实标题</title><body>real body</body>'));
    const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
    const document = await fetchPublicDocument('https://example.com/', { resolve, request });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'example.com' }),
      { address: '93.184.216.34', family: 4 },
      expect.any(AbortSignal),
    );
    expect(document.url).toBe('https://example.com/');
    expect(document.title).toBe('真实标题');
    expect(document.text).toBe('real body');
    request.mockClear();
    await expect(
      fetchPublicDocument('https://example.com/', {
        resolve: async () => [
          { address: '8.8.8.8', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
        request,
      }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('解析与请求受同一取消期限约束', async () => {
    const resolve = vi.fn(() => new Promise<never>(() => {}));
    const request = vi.fn();
    await expect(fetchPublicDocument('https://example.com/', { resolve, request }, AbortSignal.abort())).rejects.toThrow('超时或已取消');
    expect(request).not.toHaveBeenCalled();
  });
  it('每次重定向重新校验，不连接私网跳转', async () => {
    const request = vi.fn(async () => response('', 302, { location: 'https://127.0.0.1/secret' }));
    await expect(
      fetchPublicDocument('https://example.com/', { resolve: async () => [{ address: '8.8.8.8', family: 4 }], request }),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('保留实际最终 URL，限制跳转并拒绝 HTTP/编码/MIME/大小失败', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response('', 302, { location: '/final' }))
      .mockResolvedValueOnce(response('<title>Final</title><body>final body</body>'));
    const dependencies = { resolve: async () => [{ address: '8.8.8.8', family: 4 }], request };
    const doc = await fetchPublicDocument('https://example.com/start', dependencies);
    expect(doc.requestedUrl).toBe('https://example.com/start');
    expect(doc.url).toBe('https://example.com/final');
    for (const bad of [
      response('bad', 404),
      response('bad', 200, { 'content-type': 'application/pdf' }),
      response('bad', 200, { 'content-type': 'text/html; charset=gbk' }),
      response('bad', 200, { ...htmlHeaders, 'content-encoding': 'gzip' }),
      response('x'.repeat(2 * 1024 * 1024 + 1)),
    ]) {
      await expect(fetchPublicDocument('https://example.com/', { ...dependencies, request: async () => bad })).rejects.toThrow();
    }
    await expect(
      fetchPublicDocument('https://example.com/', { ...dependencies, request: async () => response('', 302, { location: '/loop' }) }),
    ).rejects.toThrow();
  });
});

describe('真实 HTML 转为无能力的只读文档', () => {
  it('可靠解析实体和恶意 HTML；原脚本、属性、预连接、表单和隐藏内容不进入输出', () => {
    const raw =
      '<html><head><title>Example &amp; title</title><link rel="preconnect" href="http://127.0.0.1"></head><body onload="evil()"><h1>Visible &lt;safe&gt;</h1><script>credential theft</script><style>css-secret</style><template>hidden-template</template><p hidden>hidden-secret</p><form action="http://localhost"><input value="secret">Form label</form><iframe src="http://localhost">frame-secret</iframe><p>Second &amp; final</p></body></html>';
    const doc = extractPublicDocument(Buffer.from(raw), 'https://example.com/', 'https://example.com/');
    expect(doc.title).toBe('Example & title');
    expect(doc.text).toContain('Visible <safe>');
    expect(doc.text).toContain('Second & final');
    expect(doc.text).not.toMatch(/credential theft|css-secret|hidden-template|hidden-secret|frame-secret/);
    expect(doc.sourceSha256).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(doc.contentSha256).toBe(createHash('sha256').update(doc.text).digest('hex'));
    const reader = renderReaderDocument(doc);
    expect(reader).toContain('Visible &lt;safe&gt;');
    expect(reader).not.toMatch(/<script|<iframe|<form|preconnect|onload|http:\/\/localhost/);
  });
  it('正文按 UTF-8 字节截断，保留完整字符并显式声明', () => {
    const doc = extractPublicDocument(
      Buffer.from(`<title>Large</title><body>${'文'.repeat(40000)}</body>`),
      'https://example.com/',
      'https://example.com/',
    );
    expect(Buffer.byteLength(doc.text)).toBeLessThanOrEqual(65536);
    expect(doc.text).not.toContain('\uFFFD');
    expect(doc.truncated).toBe(true);
  });
  it('大量兄弟节点仍然受控提取，不超过函数参数限制', () => {
    const doc = extractPublicDocument(
      Buffer.from(`<body>${'<b>x</b>'.repeat(180000)}</body>`),
      'https://example.com/',
      'https://example.com/',
    );
    expect(doc.text).toBe('x'.repeat(65536));
    expect(doc.truncated).toBe(true);
  });
  it('非法 UTF-8 与非 UTF-8 HTML 声明明确失败', () => {
    expect(() => extractPublicDocument(Buffer.from([0xff, 0xfe, 0xff]), 'https://example.com/', 'https://example.com/')).toThrow();
    expect(() =>
      extractPublicDocument(Buffer.from('<meta charset="gbk"><body>x</body>'), 'https://example.com/', 'https://example.com/'),
    ).toThrow();
  });
});
