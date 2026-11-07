/* ============================================================================
 * POST /api/rsvp —— 宾客登记提交端点（EdgeOne Pages Edge Function）
 *
 * 部署约定（详见 GUIDE.zh-CN.md「真实收集宾客登记」一节）：
 *   1. 项目绑定 KV 命名空间，变量名必须是 RSVP_KV；
 *   2. 前端 public/config.js 的 rsvpEndpoint 设为 '/api/rsvp' 后此端点才会被调用。
 *
 * 数据形态：key = rsvp_<32位十六进制设备标识>（KV key 仅允许字母/数字/下划线，
 * 因此客户端标识不含连字符），value = 登记字段 JSON。同一设备重复提交即覆盖，
 * 天然支持「修改登记信息」。
 *
 * 防护：蜜罐字段、字段白名单 + 长度裁剪、clientId 严格校验、同 IP 每日限流。
 * ========================================================================== */

const KEY_PREFIX = 'rsvp_';
const DAILY_SUBMIT_LIMIT = 10;
const CLIENT_ID_RE = /^[0-9a-f]{32}$/;
const MOBILE_RE = /^(?=(?:\D*\d){5})[\d\s+-]{5,20}$/; // 至少含 5 位数字，拒绝纯符号串

// 字段白名单：字符串 trim + 截断；整数夹取到区间；枚举只接受列出的值
const STRING_FIELDS = {
  guestName: 30,
  mobile: 20,
  dietary: 80,
  message: 200,
};
const INT_FIELDS = {
  partySize: { min: 1, max: 6, def: 1 },
  childrenCount: { min: 0, max: 5, def: 0 },
};
const ENUM_FIELDS = {
  attending: { values: ['yes', 'no'] }, // 必填：缺失即拒绝
  hotelNeed: { values: ['none', 'one-night', 'two-nights', 'pending'], def: 'none' },
  transportNeed: { values: ['none', 'arrival', 'departure', 'both', 'pending'], def: 'none' },
};

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// KV 绑定：控制台绑定命名空间时变量名为全局注入，同时兼容 env 上的绑定
function resolveKV(env) {
  return globalThis.RSVP_KV || (env && env.RSVP_KV) || null;
}

// 客户端 IP：只信平台注入的来源。X-Forwarded-For 首段可被客户端伪造，不用于限流。
function clientIp(request) {
  const eo = request.eo;
  if (eo && typeof eo === 'object') {
    if (typeof eo.connectIp === 'string' && eo.connectIp) return eo.connectIp;
    if (typeof eo.clientIp === 'string' && eo.clientIp) return eo.clientIp;
  }
  return request.headers.get('eo-client-ip') || 'unknown';
}

// FNV-1a：仅用于限流分桶，不需要密码学强度；哈希后不留存原始 IP
function hashBucket(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

// 白名单裁剪：未知字段全部丢弃，超长字段截断，缺失的枚举/整数给默认值
function sanitize(body) {
  const record = {};
  Object.keys(STRING_FIELDS).forEach((key) => {
    const max = STRING_FIELDS[key];
    const value = body[key];
    record[key] = typeof value === 'string' ? value.trim().slice(0, max) : '';
  });
  Object.keys(INT_FIELDS).forEach((key) => {
    const { min, max, def } = INT_FIELDS[key];
    const num = Number.parseInt(body[key], 10);
    record[key] = Number.isFinite(num) ? Math.min(max, Math.max(min, num)) : def;
  });
  Object.keys(ENUM_FIELDS).forEach((key) => {
    const { values, def } = ENUM_FIELDS[key];
    record[key] = values.includes(body[key]) ? body[key] : (def !== undefined ? def : null);
  });
  if (!record.guestName) return null;
  if (record.attending === null) return null;
  if (!MOBILE_RE.test(record.mobile)) return null;
  return record;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const kv = resolveKV(env);
  if (!kv) {
    return json({ ok: false, error: '登记服务尚未配置存储，请联系新人。' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: '请求数据格式不正确。' }, 400);
  }
  if (!body || typeof body !== 'object') {
    return json({ ok: false, error: '请求数据格式不正确。' }, 400);
  }

  // 蜜罐：正常访客看不到也不会填写 website 字段；命中则假装成功、不落库
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return json({ ok: true });
  }

  // clientId 严格校验（32 位十六进制），防止伪造 key 覆盖他人记录
  const clientId = typeof body.clientId === 'string' ? body.clientId.toLowerCase() : '';
  if (!CLIENT_ID_RE.test(clientId)) {
    return json({ ok: false, error: '登记标识不正确，请刷新页面后重试。' }, 400);
  }

  // 同 IP 每日限流（KV 为最终一致，计数是近似值，防滥用足够）。
  // 注意：KV key 仅允许字母/数字/下划线，日期需去掉连字符。
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rateKey = `rate_${day}_${hashBucket(clientIp(request))}`;
  const used = Number(await kv.get(rateKey)) || 0;
  if (used >= DAILY_SUBMIT_LIMIT) {
    return json({ ok: false, error: '今日提交次数过多，请稍后再试或直接联系新人。' }, 429);
  }
  await kv.put(rateKey, String(used + 1));

  const record = sanitize(body);
  if (!record) {
    return json({ ok: false, error: '请填写姓名、联系电话并选择是否赴约。' }, 400);
  }

  record.clientId = clientId;
  record.submittedAt = Date.now();
  await kv.put(KEY_PREFIX + clientId, JSON.stringify(record));

  return json({ ok: true });
}
