let mediaRecorder;
let audioChunks = [];
let audioContext;

// Global state for audio queue and playback
let audioQueue = [];
let isPlaying = false;
let isPaused = false; 
let audioSourceNodes = []; 
let currentReader;

// Client-side message history for chat endpoint
let messageHistory = [];
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

// Function to stop all audio playback and clean up
function stopAudioPlayback() {
    if (currentReader) {
        currentReader.cancel().catch(e => console.error("Error canceling reader:", e));
        currentReader = null;
    }
    
    // Stop all currently playing audio source nodes
    audioSourceNodes.forEach(source => {
        try {
            source.stop();
            source.disconnect();
        } catch (e) {}
    });

    audioSourceNodes = [];
    audioQueue = [];
    isPlaying = false;
    isPaused = false;

    setButtonState("read", "🔊 Read Story");
    setButtonState("record", "🎤 Record Voice");
    setButtonState("generate", "📖 Generate Story");
    displayMessage("Playback stopped.", 'info');
}

// Function to pause audio playback
function pauseAudioPlayback() {
    if (audioContext && audioContext.state === 'running') {
        audioContext.suspend();
        isPaused = true;
        setButtonState("read", "▶️ Resume Reading");
        displayMessage("Playback paused.", 'info');
    }
}

// Function to resume audio playback
function resumeAudioPlayback() {
    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume();
        isPaused = false;
        setButtonState("read", "⏸️ Pause Reading", false, true);
        displayMessage("Playback resumed.", 'info');
    }
}


function playNextChunk() {
    if (audioQueue.length > 0 && isPlaying && !isPaused) {
        const chunk = audioQueue.shift();
        
        const source = audioContext.createBufferSource();
        source.buffer = chunk;
        source.connect(audioContext.destination);

        audioSourceNodes.push(source);

        source.start();

        source.onended = () => {
            const index = audioSourceNodes.indexOf(source);
            if (index > -1) {
                audioSourceNodes.splice(index, 1);
            }
            playNextChunk();
        };
    } else if (audioQueue.length === 0 && !currentReader && !isPaused) {
        isPlaying = false;
        setButtonState("read", "🔊 Read Story");
        setButtonState("record", "🎤 Record Voice");
        setButtonState("generate", "📖 Generate Story");
        displayMessage("Story playback finished.", 'success');
    }
}

// --- The NEW and IMPROVED read button logic ---
document.getElementById("read").onclick = async () => {
    // Case 1: Audio is currently playing, so pause it
    if (isPlaying && !isPaused) {
        pauseAudioPlayback();
        return;
    }
    
    // Case 2: Audio is paused, so resume it
    if (isPlaying && isPaused) {
        resumeAudioPlayback();
        return;
    }

    const storyText = document.getElementById("my-story").value;
    if (!storyText) {
        displayMessage("Please generate a story first!", 'error');
        return;
    }
    
    // Case 3: Audio is not playing, so start a new playback session
    setButtonState("read", "⏹️ Stop Reading", false, true); 
    setButtonState("record", "🎤 Record Voice", true);
    setButtonState("generate", "📖 Generate Story", true);
    displayMessage("Fetching audio stream...", 'info');
    
    isPlaying = true;

    try {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        
        const res = await handleFetch("/tts_stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: storyText })
        }, "Fetching audio stream...", "Playback started!", "Text-to-speech failed");
        
        if (res) {
            currentReader = res.body.getReader(); 
            let sourceSampleRate = null;
            let leftover = new Uint8Array(0);

            while (true) {
                const { done, value } = await currentReader.read();
                if (!isPlaying || done) {
                    if (done) currentReader = null;
                    break;
                }
                if (isPaused) {
                    // Pause the loop while the playback is paused
                    await new Promise(resolve => {
                        const checkPause = setInterval(() => {
                            if (!isPaused) {
                                clearInterval(checkPause);
                                resolve();
                            }
                        }, 100);
                    });
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

                    const audioBuffer = audioContext.createBuffer(1, floatChunk.length, sourceSampleRate);
                    audioBuffer.getChannelData(0).set(floatChunk);
                    audioQueue.push(audioBuffer);

                    if (audioSourceNodes.length === 0 && !isPaused) {
                        playNextChunk();
                    }
                }
                leftover = data.slice(offset + alignedBytes);
            }
        }
    } catch (error) {
        console.error("TTS playback error:", error);
        displayMessage("An error occurred during text-to-speech.", 'error');
        stopAudioPlayback();
    }
};

// ... (rest of the code remains the same)

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

// --- New function to update the chat history UI ---
function updateChatHistoryUI() {
    const chatHistoryDiv = document.getElementById("chat-history");
    chatHistoryDiv.innerHTML = ""; // Clear existing content

    messageHistory.forEach(msg => {
        const messageDiv = document.createElement("div");
        messageDiv.className = `chat-message ${msg.role}-message`;
        messageDiv.textContent = msg.content;
        chatHistoryDiv.appendChild(messageDiv);
    });

    // Scroll to the bottom of the chat history
    chatHistoryDiv.scrollTop = chatHistoryDiv.scrollHeight;
}

// --- Story Generation ---
document.getElementById("generate").onclick = async () => {
    // ... (rest of the generate function is unchanged, it will still output to `generated-story-output`) ...
    const prompt = document.getElementById("prompt").value;
    if (!prompt) {
        displayMessage("Please enter a prompt first!", 'error');
        return;
    }
    
    messageHistory.push({ role: "user", content: prompt });
    document.getElementById("prompt").value = "";
    updateChatHistoryUI();

    setButtonState("generate", "Generating...", true, true);
    setButtonState("record", "🎤 Record Voice", true);
    setButtonState("read", "🔊 Read Story", true);
    document.getElementById("generated-story-output").value = "";

    const res = await handleFetch("/story", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: messageHistory }) 
    }, "Generating story...", "Story generation successful!", "Story generation failed");

    if (res) {
        const reader = res.body.getReader();
        let fullResponse = ""; 
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = new TextDecoder().decode(value);
            fullResponse += chunk;
            document.getElementById("generated-story-output").value += chunk;
        }
        messageHistory.push({ role: "assistant", content: fullResponse });
        updateChatHistoryUI();
    }

    setButtonState("generate", "📖 Generate Story");
    setButtonState("record", "🎤 Record Voice");
    setButtonState("read", "🔊 Read Story");
};

// --- New Copy Story Logic ---
document.getElementById("copy-story").onclick = () => {
    const generatedText = document.getElementById("generated-story-output").value;
    const myStoryTextarea = document.getElementById("my-story");

    if (generatedText) {
        // Append the generated text with a newline for separation
        const currentContent = myStoryTextarea.value;
        myStoryTextarea.value = currentContent + "\n\n" + generatedText;
        displayMessage("Generated story added to 'My Story'!", 'success');
        
        // Clear the generated output box after copying
        document.getElementById("generated-story-output").value = "";
    } else {
        displayMessage("No generated story to add.", 'info');
    }
};

// --- UI Event Handlers (modal-related code removed) ---
document.addEventListener("DOMContentLoaded", () => {
    const historyBtn = document.getElementById("history-toggle-btn");
    const closeBtn = document.getElementById("close-chat-btn");
    const chatContainer = document.getElementById("chat-history-container");
    
    historyBtn.addEventListener("click", () => {
        chatContainer.classList.add("visible");
        historyBtn.style.display = "none";
        updateChatHistoryUI();
    });
    
    closeBtn.addEventListener("click", () => {
        chatContainer.classList.remove("visible");
        historyBtn.style.display = "flex";
    });
});

// --- Save Story Logic ---
document.getElementById("save-story").onclick = async () => {
    const storyTitle = document.getElementById("story-title").value.trim();
    const storyText = document.getElementById("my-story").value;

    if (!storyTitle) {
        displayMessage("Please enter a title for your story before saving.", 'error');
        return;
    }
    
    if (!storyText) {
        displayMessage("There is no story content to save.", 'error');
        return;
    }

    const payload = {
        title: storyTitle,
        messages: messageHistory,
        story_text: storyText
    };

    const res = await handleFetch("/save_story", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    }, "Saving story...", "Story saved!", "Failed to save story");

    if (res) {
        const data = await res.json();
        console.log("Saved story:", data.filename);
        // We can now show the user the title of the saved story
        displayMessage(`'${storyTitle}' saved successfully!`, 'success');
    }
};

// --- Load Story Logic (Modal and Button) ---
const loadModal = document.getElementById("load-modal");
const closeModal = document.querySelector(".close-modal");

// --- Load Story Logic ---
const storyListContainer = document.getElementById("story-list-container");
const storyListDiv = document.getElementById("story-list");
const loadBtn = document.getElementById("load-story");

loadBtn.onclick = async () => {
    if (storyListContainer.style.display === "block") {
        storyListContainer.style.display = "none";
        displayMessage("Story list hidden.", "info");
        return;
    }
    
    const res = await handleFetch("/list_stories", { method: "GET" }, "Fetching stories...", "Stories loaded.", "Failed to load stories.");
    
    if (res) {
        const data = await res.json();
        storyListDiv.innerHTML = "";
        
        if (data.stories && data.stories.length > 0) {
            data.stories.forEach(story => {
                const item = document.createElement("button");
                item.className = "story-list-item";
                item.textContent = story.title;
                item.onclick = async () => {
                    await loadSelectedStory(story.filename);
                    storyListContainer.style.display = "none";
                };
                storyListDiv.appendChild(item);
            });
            displayMessage("Select a story to load.", "info");
        } else {
            storyListDiv.textContent = "No stories found.";
            displayMessage("No stories found.", "info");
        }
        storyListContainer.style.display = "block";
    }
};

closeModal.onclick = () => {
    loadModal.style.display = "none";
};

window.onclick = (event) => {
    if (event.target == loadModal) {
        loadModal.style.display = "none";
    }
};

async function loadSelectedStory(filename) {
    const res = await handleFetch(`/load_story/${filename}`, { method: "GET" }, "Loading story...", "Story loaded successfully!", "Failed to load story");
    
    if (res) {
        const data = await res.json();
        
        // Clear existing content
        messageHistory.length = 0; 
        document.getElementById("generated-story-output").value = "";
        
        // Populate with loaded data
        document.getElementById("story-title").value = data.title || "";
        messageHistory = data.chat_history || [];
        document.getElementById("my-story").value = data.story || "";
        
        // Update the UI
        updateChatHistoryUI();
        displayMessage(`'${data.title || 'Untitled'}' loaded.`, 'success');
    }
}