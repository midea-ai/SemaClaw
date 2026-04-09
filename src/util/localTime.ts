/**
 * 本地时间格式化工具
 *
 * Node.js 的 Date.toISOString() 始终输出 UTC 时间。
 * 这里提供基于本地时区的格式化函数，用于日志文件名、展示性时间戳等场合。
 * DB 存储与时间比较仍应使用 toISOString()（UTC）。
 */

const pad = (n: number): string => String(n).padStart(2, '0');

/** 返回本地日期字符串，格式 "YYYY-MM-DD" */
export function localDateString(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 返回本地时间字符串，格式 "HH:MM" */
export function localTimeString(d = new Date()): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 返回本地完整时间戳，格式 "YYYY-MM-DD HH:MM:SS"（用于日志展示） */
export function localISOString(d = new Date()): string {
  return `${localDateString(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
