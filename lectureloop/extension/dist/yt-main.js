(() => {
  // ../extension/src/yt-main.js
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.type !== "lectureloop:yt-request") return;
    let payload = null;
    try {
      const player = document.getElementById("movie_player");
      const r = player && typeof player.getPlayerResponse === "function" && player.getPlayerResponse() || window.ytInitialPlayerResponse;
      const caps = r?.captions?.playerCaptionsTracklistRenderer;
      payload = {
        videoId: r?.videoDetails?.videoId || null,
        title: r?.videoDetails?.title || "",
        tracks: (caps?.captionTracks || []).map((t) => ({ baseUrl: t.baseUrl, languageCode: t.languageCode, kind: t.kind || "", name: t.name?.simpleText || "" }))
      };
    } catch {
    }
    window.postMessage({ type: "lectureloop:yt-data", id: e.data.id, payload }, "*");
  });
})();
