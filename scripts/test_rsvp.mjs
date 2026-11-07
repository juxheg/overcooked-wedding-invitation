/* ============================================================================
 * 登记端点单元测试（无外部依赖，Node 18+）
 * 运行：node scripts/test_rsvp.mjs
 *
 * 用内存 MockKV 模拟 EdgeOne KV（put/get/delete/list 同签名），
 * 直接调用 edge-functions/api/ 下两个函数的 handler，覆盖：
 * 校验、蜜罐、限流、覆盖更新、导出鉴权、汇总、CSV、分页。
 * ========================================================================== */

import assert from 'node:assert/strict';
import * as rsvpApi from '../edge-functions/api/rsvp.js';
import * as rsvpsApi from '../edge-functions/api/rsvps.js';

const TOKEN = 'e2e-test-token-0123456789abcdef';

class MockKV {
  // forcePageLimit：模拟 list 强制小分页，验证游标遍历
  constructor({ forcePageLimit } = {}) {
    this.map = new Map();
    this.forcePageLimit = forcePageLimit || 256;
  }

  async put(key, value) {
    assert.match(key, /^[0-9A-Za-z_]+$/, `KV key 只允许字母数字下划线: ${key}`);
    assert.ok(key.length <= 512, 'KV key 超过 512B');
    this.map.set(key, String(value));
  }

  async get(key, opts) {
    const value = this.map.get(key);
    if (value === undefined) return null;
    const type = typeof opts === 'string' ? opts : opts && opts.type;
    return type === 'json' ? JSON.parse(value) : value;
  }

  async delete(key) {
    this.map.delete(key);
  }

  async list({ prefix = '', limit = 256, cursor } = {}) {
    let keys = Array.from(this.map.keys()).filter((k) => k.startsWith(prefix)).sort();
    if (cursor) keys = keys.filter((k) => k >= cursor);
    const size = Math.min(limit, this.forcePageLimit);
    const page = keys.slice(0, size);
    const complete = keys.length <= size;
    return {
      complete,
      cursor: complete ? null : keys[size],
      keys: page.map((key) => ({ key })),
    };
  }
}

const clientId = (i) => `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${String(i).padStart(2, '0')}`.slice(0, 32);

function post(kvs, body, headers = {}) {
  const request = new Request('https://example.com/api/rsvp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return rsvpApi.onRequestPost({ request, env: { RSVP_KV: kvs } });
}

function get(kvs, query, env = {}) {
  const request = new Request(`https://example.com/api/rsvps${query}`, { method: 'GET' });
  return rsvpsApi.onRequestGet({ request, env: { RSVP_KV: kvs, RSVP_TOKEN: TOKEN, ...env } });
}

const ip = (addr) => ({ 'eo-client-ip': addr });

const validBody = (i, overrides = {}) => ({
  guestName: ' 张三 ',
  mobile: '13800000000',
  attending: 'yes',
  partySize: '2',
  childrenCount: '1',
  hotelNeed: 'one-night',
  transportNeed: 'both',
  dietary: '海鲜过敏',
  message: '新婚快乐！',
  clientId: clientId(i),
  ...overrides,
});

// ---- 微型测试运行器 ----
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- 提交端点 ----

test('合法提交：返回 ok，记录完整落库', async () => {
  const kv = new MockKV();
  const res = await post(kv, validBody(1));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  const record = await kv.get(`rsvp_${clientId(1)}`, { type: 'json' });
  assert.equal(record.guestName, '张三'); // 已 trim
  assert.equal(record.mobile, '13800000000');
  assert.equal(record.attending, 'yes');
  assert.equal(record.partySize, 2);
  assert.equal(record.childrenCount, 1);
  assert.equal(record.hotelNeed, 'one-night');
  assert.equal(record.transportNeed, 'both');
  assert.equal(record.dietary, '海鲜过敏');
  assert.equal(record.message, '新婚快乐！');
  assert.equal(record.clientId, clientId(1));
  assert.ok(Number.isFinite(record.submittedAt), 'submittedAt 应为毫秒时间戳');
});

test('非法 JSON / 非对象 body：返回 400', async () => {
  const kv = new MockKV();
  assert.equal((await post(kv, '{oops')).status, 400);
  assert.equal((await post(kv, '"just a string"')).status, 400);
  assert.equal((await post(kv, '[1,2]')).status, 400);
});

test('必填缺失：缺姓名 / attending 非法 / 手机号格式错 → 400', async () => {
  const kv = new MockKV();
  assert.equal((await post(kv, validBody(1, { guestName: '   ' }))).status, 400);
  assert.equal((await post(kv, validBody(1, { attending: 'maybe' }))).status, 400);
  assert.equal((await post(kv, validBody(1, { mobile: 'abc' }))).status, 400);
  assert.equal((await post(kv, validBody(1, { mobile: '123' }))).status, 400);
});

test('蜜罐字段命中：返回 ok 但不落库', async () => {
  const kv = new MockKV();
  const res = await post(kv, validBody(1, { website: 'http://spam.example' }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(await kv.get(`rsvp_${clientId(1)}`), null);
});

test('clientId 格式校验：带连字符 / 过短 / 缺失 → 400', async () => {
  const kv = new MockKV();
  const uuid = '0f4d3a2b-1c5e-4f6a-9b7d-8e2f1a0b3c4d';
  assert.equal((await post(kv, validBody(1, { clientId: uuid }))).status, 400);
  assert.equal((await post(kv, validBody(1, { clientId: 'abc123' }))).status, 400);
  assert.equal((await post(kv, validBody(1, { clientId: undefined }))).status, 400);
});

test('未知字段被丢弃，超长字段被截断', async () => {
  const kv = new MockKV();
  await post(kv, validBody(1, {
    guestName: '长'.repeat(50),
    evil: '<script>alert(1)</script>',
    clientId: clientId(1),
  }));
  const record = await kv.get(`rsvp_${clientId(1)}`, { type: 'json' });
  assert.equal(record.guestName.length, 30);
  assert.ok(!('evil' in record), '未知字段必须丢弃');
});

test('缺席提交：人数等字段取默认值', async () => {
  const kv = new MockKV();
  await post(kv, {
    guestName: '李四',
    mobile: '13911112222',
    attending: 'no',
    clientId: clientId(2),
  });
  const record = await kv.get(`rsvp_${clientId(2)}`, { type: 'json' });
  assert.equal(record.partySize, 1);
  assert.equal(record.childrenCount, 0);
  assert.equal(record.hotelNeed, 'none');
  assert.equal(record.transportNeed, 'none');
});

test('同一设备重复提交 = 覆盖更新（修改登记）', async () => {
  const kv = new MockKV();
  await post(kv, validBody(1, { partySize: '2' }));
  await post(kv, validBody(1, { partySize: '5', message: '改人数' }));
  const keys = Array.from(kv.map.keys()).filter((k) => k.startsWith('rsvp_'));
  assert.equal(keys.length, 1);
  const record = await kv.get(keys[0], { type: 'json' });
  assert.equal(record.partySize, 5);
  assert.equal(record.message, '改人数');
});

test('同 IP 每日限流：第 11 次被拒，其他 IP 不受影响', async () => {
  const kv = new MockKV();
  for (let i = 1; i <= 10; i += 1) {
    const res = await post(kv, validBody(i), ip('1.2.3.4'));
    assert.equal(res.status, 200);
  }
  const blocked = await post(kv, validBody(99), ip('1.2.3.4'));
  assert.equal(blocked.status, 429);
  const other = await post(kv, validBody(98), ip('5.6.7.8'));
  assert.equal(other.status, 200);
});

test('伪造 X-Forwarded-For 不能重置限流配额', async () => {
  const kv = new MockKV();
  for (let i = 1; i <= 10; i += 1) {
    await post(kv, validBody(i), ip('1.2.3.4'));
  }
  // 攻击者换伪造的 XFF 头重试：平台 IP 不变，仍应被限流
  const spoofed = await post(kv, validBody(97), { 'x-forwarded-for': '9.9.9.9', ...ip('1.2.3.4') });
  assert.equal(spoofed.status, 429);
});

test('纯符号手机号被拒绝', async () => {
  const kv = new MockKV();
  assert.equal((await post(kv, validBody(1, { mobile: '+-+- +' }))).status, 400);
});

test('KV 未绑定：返回 503 且提示配置', async () => {
  const request = new Request('https://example.com/api/rsvp', { method: 'POST', body: '{}' });
  const res = await rsvpApi.onRequestPost({ request, env: {} });
  assert.equal(res.status, 503);
});

// ---- 导出端点 ----

test('令牌校验：缺失 / 错误 → 401；未配置或过短 → 503', async () => {
  const kv = new MockKV();
  assert.equal((await get(kv, '')).status, 401);
  assert.equal((await get(kv, '?token=wrong')).status, 401);
  assert.equal((await get(kv, `?token=${TOKEN}`, { RSVP_TOKEN: '' })).status, 503);
  assert.equal((await get(kv, `?token=short-token`, { RSVP_TOKEN: 'short-token' })).status, 503);
});

test('正确令牌：返回记录与汇总统计', async () => {
  const kv = new MockKV();
  await post(kv, validBody(1, { partySize: '3', childrenCount: '2', hotelNeed: 'two-nights' }));
  await post(kv, { guestName: '王五', mobile: '13733334444', attending: 'no', clientId: clientId(2) });
  const res = await get(kv, `?token=${TOKEN}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.count, 2);
  assert.equal(data.summary.attendingYes, 1);
  assert.equal(data.summary.attendingNo, 1);
  assert.equal(data.summary.totalParty, 3);
  assert.equal(data.summary.totalChildren, 2);
  assert.equal(data.summary.hotel['two-nights'], 1);
  assert.ok(data.records[0].guestName === '张三' || data.records[0].guestName === '王五');
});

test('CSV 导出：BOM、表头、转义、公式注入中和齐全', async () => {
  const kv = new MockKV();
  await post(kv, validBody(1, { guestName: '含,逗号"引号', message: '多行\n祝福' }));
  await post(kv, validBody(3, { guestName: '=HYPERLINK("http://evil","点此")' }));
  const res = await get(kv, `?token=${TOKEN}&format=csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  // 注意：Response.text() 使用的 TextDecoder 默认剥离 BOM，必须做字节级检查
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.ok(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, 'CSV 应以 BOM（EF BB BF）开头');
  const text = new TextDecoder().decode(buf);
  assert.ok(text.includes('"姓名","联系电话","是否赴约"'));
  assert.ok(text.includes('"含,逗号""引号"'), '单元格必须转义');
  assert.ok(text.includes('多行 祝福'), '换行折叠为空格');
  assert.ok(text.includes("\"'=HYPERLINK("), '= 开头的公式必须前置撇号中和');
  assert.ok(!text.includes('"=HYPERLINK'), '不得残留未中和的公式开头');
});

test('导出端点限流：每 IP 每日 100 次，超出 429', async () => {
  const kv = new MockKV();
  let last = 200;
  for (let i = 0; i <= 100; i += 1) {
    last = (await get(kv, `?token=${TOKEN}`)).status;
  }
  assert.equal(last, 429);
});

test('list 分页遍历：小分页下不丢记录', async () => {
  const kv = new MockKV({ forcePageLimit: 2 });
  for (let i = 1; i <= 5; i += 1) {
    await post(kv, { guestName: `宾客${i}`, mobile: `1380000000${i}`, attending: 'yes', clientId: clientId(i) });
  }
  const data = await (await get(kv, `?token=${TOKEN}`)).json();
  assert.equal(data.count, 5);
});

test('限流计数 key 不混入登记名单', async () => {
  const kv = new MockKV();
  await post(kv, validBody(1), { 'x-forwarded-for': '1.2.3.4' });
  await post(kv, validBody(2), { 'x-forwarded-for': '1.2.3.4' });
  const data = await (await get(kv, `?token=${TOKEN}`)).json();
  assert.equal(data.count, 2);
  assert.ok(data.records.every((r) => !r.guestName.startsWith('rate')));
});

// ---- 执行 ----

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.stack ? error.stack.split('\n').slice(0, 4).join('\n    ') : error}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
if (failed > 0) process.exit(1);
