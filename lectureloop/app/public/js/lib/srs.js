// 间隔重复（Leitner 盒子）：box 0 = 新卡；间隔 [0,1,3,7,14,30] 天。
import { DAY } from './util.js';

export const INTERVALS = [0, 1, 3, 7, 14, 30];
export const MAX_BOX = INTERVALS.length - 1;

export const newSrs = (now = Date.now()) => ({ box: 0, due: now, attempts: [] });
export const AGAIN_DELAY = 10 * 60 * 1000; // 没懂：10 分钟后可以再练
/** "听懂"后的下一个盒子：新卡（盒 0）第一次就听懂直接进盒 2 */
export const nextBox = (box) => (box === 0 ? 2 : Math.min(MAX_BOX, box + 1));

/**
 * rating: 'again' 没懂（盒 1，10 分钟后） | 'hard' 勉强（盒不变） | 'good' 听懂（升盒；新卡直接进盒 2）
 * 返回 { srs, status }（status 为 'open' | 'mastered'）
 */
export function review(srs, rating, { now = Date.now(), score = null, speed = null } = {}) {
  let box = srs.box;
  let status = 'open';
  if (rating === 'again') box = 1;
  else if (rating === 'hard') box = Math.max(1, box);
  else if (rating === 'good') {
    if (box >= MAX_BOX) status = 'mastered';
    box = nextBox(box);
  }
  const next = {
    box,
    due: status === 'mastered' ? Infinity : rating === 'again' ? now + AGAIN_DELAY : now + INTERVALS[box] * DAY,
    attempts: [...srs.attempts, { ts: now, rating, ...(score != null ? { score } : {}), ...(speed != null ? { speed } : {}) }].slice(-50),
  };
  return { srs: next, status };
}

export const isDue = (clip, now = Date.now()) => clip.status !== 'mastered' && clip.srs && clip.srs.due <= now;

/** 到期优先；同级按 due 升序，新卡(box 0)先于旧卡 */
export function queue(clips, now = Date.now()) {
  return clips
    .filter((c) => c.kind === 'stuck' || c.practice)
    .filter((c) => isDue(c, now))
    .sort((a, b) => a.srs.due - b.srs.due || a.srs.box - b.srs.box);
}

export const intervalLabel = (box) => (box <= 0 ? '今天' : `${INTERVALS[Math.min(box, MAX_BOX)]} 天后`);
