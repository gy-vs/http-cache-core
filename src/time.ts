/**
 * HTTP 日期与年龄相关的纯函数工具。
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * 解析 HTTP-date（RFC 9110）。
 *
 * 规范格式是 IMF-fixdate：`Sun, 06 Nov 1994 08:49:37 GMT`。
 * 历史上还允许 RFC 850 / asctime 两种废弃格式，这里对解析失败的
 * 输入兜底交给 JS 引擎（V8 能识别 GMT 的 RFC1123 串）。
 * 解析失败返回 null —— 对 Expires 而言这等价于“没有显式过期时间”。
 */
export function parseHttpDate(value: string | null): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const imf = parseImfFixdate(trimmed);
  if (imf !== null) return imf;

  const fallback = Date.parse(trimmed);
  return Number.isNaN(fallback) ? null : fallback;
}

function parseImfFixdate(value: string): number | null {
  // 忽略可选的星期前缀，只吃 "day month year hour:min:sec GMT" 主体。
  const match = value.match(
    /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+GMT$/,
  );
  if (match == null) return null;
  const [, dayStr, mon, yearStr, hh, mm, ss] = match;
  const month = MONTH_NAMES.indexOf(mon);
  if (month === -1) return null;
  const day = Number(dayStr);
  const year = Number(yearStr);
  const h = Number(hh);
  const m = Number(mm);
  const s = Number(ss);
  if (day < 1 || day > 31 || h > 23 || m > 59 || s > 60) return null;

  const utc = Date.UTC(year, month, day, h, m, s);
  if (Number.isNaN(utc)) return null;

  // 校验星期（RFC 要求但实践里常有错，星期错不致命：容错忽略）。
  void DAY_NAMES;
  return utc;
}

/** 秒转毫秒。 */
export function secToMs(sec: number): number {
  return sec * 1000;
}

/** 毫秒差转整秒（向下取整），负数钳为 0。 */
export function elapsedSeconds(fromMs: number, toMs: number): number {
  const delta = toMs - fromMs;
  return delta <= 0 ? 0 : Math.floor(delta / 1000);
}
