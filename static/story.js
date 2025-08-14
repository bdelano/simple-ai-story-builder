let mediaRecorder;
let audioChunks = [];
let audioContext;

// Helper function to update button states, text, and show a loading spinner
function setButtonState(buttonId, text, isDisabled = false, showSpinner = false) {
    const button = document.getElementById(buttonId);
    button.disabled = isDisabled;

    button.innerHTML = '';

    if (showSpinner) {
        const spinner = document.createElement('span');
        spinner.className = 'spinner';
        spinner.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-loader"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>`;
        button.appendChild(spinner);
    }

    const textNode = document.createTextNode(text);
    button.appendChild(textNode);
}

// Function to display messages to the user
function displayMessage(message, type = 'info') {
    const messageDiv = document.getElementById("status-message");
    messageDiv.textContent = message;
    messageDiv.className = type;
    if (message === '') {
        messageDiv.style.display = 'none';
    } else {
        messageDiv.style.display = 'block';
    }
}

// Global state for audio queue
let audioQueue = [];
let isPlaying = false;
let audioTimeout;

async function handleFetch(url, options, loadingMessage, successMessage, errorMessage) {
    displayMessage(loadingMessage, 'info');
    try {
        const res = await fetch(url, options);
        if (!res.ok) {
            const errorData = await res.json().catch(() => ({ message: `HTTP error! Status: ${res.status}` }));
            throw new Error(errorData.error || `HTTP error! Status: ${res.status}`);
        }
        displayMessage(successMessage, 'success');
        return res;
    } catch (error) {
        console.error("Fetch error:", error);
        displayMessage(errorMessage + `: ${error.message}`, 'error');
        return null;
    }
}

// --- The NEW and IMPROVED TTS playback logic ---
// This function plays chunks from the queue one by one
function playNextChunk() {
    if (audioQueue.length > 0) {
        isPlaying = true;
        const chunk = audioQueue.shift();
        
        // Create an AudioBufferSourceNode
        const source = audioContext.createBufferSource();
        source.buffer = chunk;
        source.connect(audioContext.destination);

        // Start playing the chunk
        source.start();

        // After the chunk has played, play the next one
        source.onended = () => {
            playNextChunk();
        };
    } else {
        // Queue is empty, stop playing
        isPlaying = false;
        setButtonState("read", "🔊 Read Story");
        setButtonState("record", "🎤 Record Voice");
        setButtonState("generate", "📖 Generate Story");
        displayMessage("Story playback finished.", 'success');
    }
}

document.getElementById("read").onclick = async () => {
    const storyText = document.getElementById("story").value;
    if (!storyText) {
        displayMessage("Please generate a story first!", 'error');
        return;
    }
    
    setButtonState("read", "Reading...", true, true);
    setButtonState("record", "🎤 Record Voice", true);
    setButtonState("generate", "📖 Generate Story", true);
    displayMessage("Fetching audio stream...", 'info');

    try {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        
        // Reset the queue and playback state
        audioQueue = [];
        isPlaying = false;

        const res = await handleFetch("/tts_stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: storyText })
        }, "Fetching audio stream...", "Playback started!", "Text-to-speech failed");
        
        if (res) {
            const reader = res.body.getReader();
            let sourceSampleRate = null;
            let leftover = new Uint8Array(0);

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    // Start playback once all chunks are in the queue
                    if (!isPlaying) {
                        playNextChunk();
                    }
                    break;
                }

                const data = new Uint8Array(leftover.length + value.length);
                data.set(leftover, 0);
                data.set(value, leftover.length);

                let offset = 0;
                if (sourceSampleRate === null) {
                    const newlineIndex = data.indexOf(10);
                    if (newlineIndex !== -1) {
                        const header = new TextDecoder().decode(data.slice(0, newlineIndex));
                        if (header.startsWith("SR:")) {
                            sourceSampleRate = parseInt(header.slice(3), 10);
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
                    const aligned = data.slice(offset, offset + alignedBytes);
                    const floatChunk = new Float32Array(aligned.buffer);

                    // Create an audio buffer and add it to the queue
                    const audioBuffer = audioContext.createBuffer(1, floatChunk.length, sourceSampleRate);
                    audioBuffer.getChannelData(0).set(floatChunk);
                    audioQueue.push(audioBuffer);

                    // If not currently playing, start the playback loop
                    if (!isPlaying) {
                        playNextChunk();
                    }
                }
                leftover = data.slice(offset + alignedBytes);
            }
        }
    } catch (error) {
        console.error("TTS playback error:", error);
        displayMessage("An error occurred during text-to-speech.", 'error');
        setButtonState("read", "🔊 Read Story");
        setButtonState("record", "🎤 Record Voice");
        setButtonState("generate", "📖 Generate Story");
    }
};

// --- Voice Recording and Transcription ---
document.getElementById("record").onclick = async () => {
    const recordButton = document.getElementById("record");
    
    // Check if a mediaRecorder instance exists and is currently recording
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
        try {
            // State: Start Recording
            setButtonState("record", "Stop Recording", true, true); // Change text to "Stop Recording" and disable other buttons
            setButtonState("generate", "📖 Generate Story", true);
            setButtonState("read", "🔊 Read Story", true);
            displayMessage("Recording started...", 'info');

            audioChunks = [];
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            
            mediaRecorder.ondataavailable = e => audioChunks.push(e.data);

            mediaRecorder.onstop = async () => {
                // This block is executed automatically after mediaRecorder.stop() is called
                setButtonState("record", "Transcribing...", true, true);
                displayMessage("Recording stopped. Transcribing audio...", 'info');

                const blob = new Blob(audioChunks, { type: "audio/wav" });
                const formData = new FormData();
                formData.append("audio", blob);

                const res = await handleFetch("/stt", { method: "POST", body: formData },
                    "Transcribing audio...",
                    "Transcription successful!",
                    "Transcription failed");

                if (res) {
                    const data = await res.json();
                    document.getElementById("prompt").value = data.text;
                }
                
                // Reset buttons and enable them for the next action
                setButtonState("record", "🎤 Record Voice");
                setButtonState("generate", "📖 Generate Story");
                setButtonState("read", "🔊 Read Story");
            };

            mediaRecorder.start(); // Now the recorder is started
            
            // Re-enable the record button so the user can click it to stop
            recordButton.disabled = false;
            setButtonState("record", "⏹️ Stop Recording");

        } catch (error) {
            console.error("Recording error:", error);
            displayMessage("Could not start recording. Check microphone permissions.", 'error');
            setButtonState("record", "🎤 Record Voice");
            setButtonState("generate", "📖 Generate Story");
            setButtonState("read", "🔊 Read Story");
        }
    } else {
        // State: Stop Recording
        // This is the new, user-triggered stop action
        mediaRecorder.stop();
        // The onstop handler will take over from here to process the audio
    }
};

// --- Story Generation ---
document.getElementById("generate").onclick = async () => {
    const prompt = document.getElementById("prompt").value;
    if (!prompt) {
        displayMessage("Please enter a prompt first!", 'error');
        return;
    }

    // **Visual Feedback:** Change button to "Generating..." with a spinner
    setButtonState("generate", "Generating...", true, true);
    setButtonState("record", "🎤 Record Voice", true);
    setButtonState("read", "🔊 Read Story", true);
    document.getElementById("story").value = "";

    const res = await handleFetch("/story", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt })
    }, "Generating story...", "Story generated!", "Story generation failed");

    if (res) {
        const reader = res.body.getReader();
        let text = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            text += new TextDecoder().decode(value);
            document.getElementById("story").value = text;
        }
    }

    // **Visual Feedback:** Reset buttons
    setButtonState("generate", "📖 Generate Story");
    setButtonState("record", "🎤 Record Voice");
    setButtonState("read", "🔊 Read Story");
};