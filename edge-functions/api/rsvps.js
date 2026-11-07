/* ============================================================================
 * GET /api/rsvps?token=<令牌>[&format=csv] —— 登记名单查看 / 导出端点
 *
 * 供新人自己查看：浏览器直接打开即可看到汇总与全部登记；
 * 加 &format=csv 可下载表格（含 BOM，Excel 打开中文不乱码）。
 *
 * 部署约定：项目环境变量 RSVP_TOKEN 设置为一段足够长的随机字符串
 * （仅在 Makers 控制台配置，不要写进仓库）。未配置时本端点拒绝服务。
 * ========================================================================== */

const KEY_PREFIX = 'rsvp_';
const CSV_COLUMNS = [
  ['姓名', (r) => r.guestName],
  ['联系电话', (r) => r.mobile],
  ['是否赴约', (r) => (r.attending === 'yes' ? '赴约' : '缺席')],
  ['出席人数', (r) => r.partySize],
  ['儿童数量', (r) => r.childrenCount],
  ['酒店住宿', (r) => ({ none: '无需住宿', 'one-night': '1 晚', 'two-nights': '2 晚', pending: '待定' }[r.hotelNeed] || '未填')],
  ['交通接送', (r) => ({ none: '无需接送', arrival: '去程', departure: '返程', both: '往返', pending: '待定' }[r.transportNeed] || '未填')],
  ['忌口过敏', (r) => r.dietary],
  ['祝福', (r) => r.message],
  ['提交时间', (r) => (r.submittedAt ? new Date(r.submittedAt).toISOString() : '')],
];

const DAILY_EXPORT_LIMIT = 100;
const MIN_TOKEN_LENGTH = 16;

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', // 响应含宾客 PII，禁止任何中间层缓存
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function resolveKV(env) {
  return globalThis.RSVP_KV || (env && env.RSVP_KV) || null;
}

// 常数时间比较：令牌是本端点唯一鉴权，避免 timing 侧信道
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 与 rsvp.js 保持一致：只信平台注入的 IP 来源，X-Forwarded-For 可伪造
function clientIp(request) {
  const eo = request.eo;
  if (eo && typeof eo === 'object') {
    if (typeof eo.connectIp === 'string' && eo.connectIp) return eo.connectIp;
    if (typeof eo.clientIp === 'string' && eo.clientIp) return eo.clientIp;
  }
  return request.headers.get('eo-client-ip') || 'unknown';
}

function hashBucket(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

// CSV 单元格转义：引号包裹，内部引号翻倍，换行折叠为空格。
// 公式注入中和：Excel 会把以 = + - @ 或制表符开头的单元格当公式执行，前置撇号使其成为纯文本。
function csvCell(value) {
  let text = String(value == null ? '' : value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
}

function summarize(records) {
  const summary = {
    total: records.length,
    attendingYes: 0,
    attendingNo: 0,
    totalParty: 0,
    totalChildren: 0,
    hotel: { none: 0, 'one-night': 0, 'two-nights': 0, pending: 0 },
    transport: { none: 0, arrival: 0, departure: 0, both: 0, pending: 0 },
  };
  records.forEach((r) => {
    if (r.attending === 'yes') {
      summary.attendingYes += 1;
      summary.totalParty += Number(r.partySize) || 0;
      summary.totalChildren += Number(r.childrenCount) || 0;
    } else {
      summary.attendingNo += 1;
    }
    if (r.hotelNeed in summary.hotel) summary.hotel[r.hotelNeed] += 1;
    if (r.transportNeed in summary.transport) summary.transport[r.transportNeed] += 1;
  });
  return summary;
}

function csvResponse(records) {
  const head = CSV_COLUMNS.map(([label]) => csvCell(label)).join(',');
  const rows = records.map((r) => CSV_COLUMNS.map(([, pick]) => csvCell(pick(r))).join(','));
  // 引号内是 BOM 字符（U+FEFF，不可见）：保证 Excel 识别 UTF-8
  const body = '﻿' + [head].concat(rows).join('\r\n');
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="rsvps.csv"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const kv = resolveKV(env);
  if (!kv) {
    return json({ ok: false, error: '登记服务尚未配置存储。' }, 503);
  }

  const expected = (env && env.RSVP_TOKEN) || '';
  if (!expected) {
    return json({ ok: false, error: '登记查看服务尚未配置，请按部署文档完成初始化。' }, 503);
  }
  if (expected.length < MIN_TOKEN_LENGTH) {
    return json({ ok: false, error: '访问令牌强度不足，请更换为 16 位以上的随机字符串。' }, 503);
  }
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';
  if (!safeEqual(token, expected)) {
    return json({ ok: false, error: '令牌不正确。' }, 401);
  }

  // 导出端点限流：令牌走 URL 难免有泄露面，限流抬高暴力枚举成本
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rateKey = `exportrate_${day}_${hashBucket(clientIp(request))}`;
  const used = Number(await kv.get(rateKey)) || 0;
  if (used >= DAILY_EXPORT_LIMIT) {
    return json({ ok: false, error: '今日查询次数过多，请明天再试。' }, 429);
  }
  await kv.put(rateKey, String(used + 1));

  // 分页遍历全部登记记录
  const records = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: KEY_PREFIX, limit: 256, cursor });
    const keys = (page && page.keys) || [];
    for (let i = 0; i < keys.length; i += 1) {
      const record = await kv.get(keys[i].key, { type: 'json' });
      if (record && typeof record === 'object' && record.guestName) {
        records.push(record);
      }
    }
    cursor = page && page.complete ? null : page && page.cursor;
  } while (cursor);

  records.sort((a, b) => (a.submittedAt || 0) - (b.submittedAt || 0));

  if (url.searchParams.get('format') === 'csv') {
    return csvResponse(records);
  }
  return json({ ok: true, count: records.length, summary: summarize(records), records });
}
