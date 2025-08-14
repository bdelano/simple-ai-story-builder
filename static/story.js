let recordedAudio;
let mediaRecorder, audioChunks = [];

document.getElementById("record").onclick = async () => {
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
        audioChunks = [];
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.start();
        document.getElementById("record").textContent = "⏹️ Stop Recording";
        mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
        mediaRecorder.onstop = async () => {
            const blob = new Blob(audioChunks, { type: "audio/wav" });
            const formData = new FormData();
            formData.append("audio", blob);
            const res = await fetch("/stt", { method: "POST", body: formData });
            const data = await res.json();
            document.getElementById("prompt").value = data.text;
            document.getElementById("record").textContent = "🎤 Record Voice";
        };
    } else {
        mediaRecorder.stop();
    }
};

document.getElementById("generate").onclick = async () => {
    const prompt = document.getElementById("prompt").value;
    const res = await fetch("/story", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt })
    });
    const reader = res.body.getReader();
    let text = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
        document.getElementById("story").value = text;
    }
};

// --- Streaming TTS (raw float32 PCM → AudioWorklet) ---
document.getElementById("read").onclick = async () => {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const queue = [];
  let playing = false;
  let sourceRate = null;
  let leftover = new Uint8Array(0);

  function resampleFloat32(float32Array, sourceRate, targetRate) {
    if (sourceRate === targetRate) return float32Array;
    const ratio = sourceRate / targetRate;
    const newLength = Math.round(float32Array.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const srcIndex = i * ratio;
      const i0 = Math.floor(srcIndex);
      const i1 = Math.min(i0 + 1, float32Array.length - 1);
      const t = srcIndex - i0;
      result[i] = float32Array[i0] * (1 - t) + float32Array[i1] * t;
    }
    return result;
  }

  async function playLoop() {
    while (queue.length > 0) {
      const chunk = queue.shift();
      const audioBuffer = ctx.createBuffer(1, chunk.length, ctx.sampleRate);
      audioBuffer.getChannelData(0).set(chunk);
      const src = ctx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(ctx.destination);
      src.start();
      await new Promise(r => setTimeout(r, (chunk.length / ctx.sampleRate) * 1000));
    }
    playing = false;
  }

  const resp = await fetch("/tts_stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: document.getElementById("story").value })
  });

  const reader = resp.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // Combine leftover bytes from previous read
    const data = new Uint8Array(leftover.length + value.length);
    data.set(leftover, 0);
    data.set(value, leftover.length);

    let offset = 0;

    if (sourceRate === null) {
      const newlineIndex = data.indexOf(10); // '\n'
      if (newlineIndex !== -1) {
        const header = new TextDecoder().decode(data.slice(0, newlineIndex));
        if (header.startsWith("SR:")) {
          sourceRate = parseInt(header.slice(3), 10);
          console.log("Source rate:", sourceRate);
        }
        offset = newlineIndex + 1;
      } else {
        leftover = data;
        continue;
      }
    }

    const bytesAvailable = data.length - offset;
    const alignedBytes = bytesAvailable - (bytesAvailable % 4);
    if (alignedBytes > 0) {
      // Ensure alignment by copying into a fresh ArrayBuffer
      const aligned = data.slice(offset, offset + alignedBytes);
      const floatChunk = new Float32Array(aligned.buffer);
      const resampled = resampleFloat32(floatChunk, sourceRate, ctx.sampleRate);
      queue.push(resampled);
      offset += alignedBytes;
      if (!playing) {
        playing = true;
        playLoop();
      }
    }

    leftover = data.slice(offset);
  }
}