// 运行在 YouTube 页面自己的世界（manifest 里 world: "MAIN"）：只做一件事——把播放器里的字幕轨道列表交给内容脚本。
// 内容脚本在隔离的世界里，读不到页面的 JS 变量（ytInitialPlayerResponse / 播放器对象）。
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.type !== 'lectureloop:yt-request') return;
  let payload = null;
  try {
    const player = document.getElementById('movie_player');
    const r = (player && typeof player.getPlayerResponse === 'function' && player.getPlayerResponse()) || window.ytInitialPlayerResponse;
    const caps = r?.captions?.playerCaptionsTracklistRenderer;
    payload = {
      videoId: r?.videoDetails?.videoId || null,
      title: r?.videoDetails?.title || '',
      tracks: (caps?.captionTracks || []).map((t) => ({ baseUrl: t.baseUrl, languageCode: t.languageCode, kind: t.kind || '', name: t.name?.simpleText || '' })),
    };
  } catch { /* 取不到就回 null，内容脚本会走备用办法 */ }
  window.postMessage({ type: 'lectureloop:yt-data', id: e.data.id, payload }, '*');
});
