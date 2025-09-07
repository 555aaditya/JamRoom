document.addEventListener('DOMContentLoaded', () => {
    // ------------------- INITIALIZATION & SCOPE -------------------
    console.log('DOM Content Loaded. Initializing script.');
    const socket = io();
    
    // Global variables passed from Flask
    const roomKey = ROOM_KEY;
    const username = CURRENT_USER;
    const accessToken = SPOTIFY_ACCESS_TOKEN;
    const DEFAULT_ARTWORK = "{{ url_for('static', filename='default-album.png') }}";

    // HTML Elements
    const musicSearchInput = document.getElementById('music-search-input');
    const musicResultsContainer = document.getElementById('music-results-container');
    const playPauseButton = document.getElementById('play-pause-btn');
    const prevButton = document.getElementById('prev-btn');
    const nextButton = document.getElementById('next-btn');
    const playerArtwork = document.getElementById('player-artwork');
    const playerCurrentTrack = document.getElementById('player-current-track');
    const playerStatus = document.getElementById('player-status');
    const progressBar = document.getElementById('progress');
    const progressContainer = document.querySelector('.progress-bar');
    const currentTimeElement = document.getElementById('current-time');
    const durationElement = document.getElementById('duration');
    const volumeSlider = document.getElementById('volume-slider');
    const volumeDisplay = document.getElementById('volume-display');
    const messageForm = document.getElementById('message-form');
    const messageInput = document.getElementById('message-input');
    const messagesContainer = document.getElementById('messages-container');
    const listenerCountElement = document.getElementById('listener-count');
    const leaveRoomButton = document.getElementById('leave-room-button');
    
    // Spotify Web Playback SDK Player and State
    let player = null;
    let deviceId = null;
    let currentTrack = null;
    let isPlayingSource = false;
    let progressUpdateInterval = null; // Timer for progress updates
    
    // Rate limiting and deduplication
    let lastPlayedSongUri = null;
    let lastPlayTime = 0;
    const PLAY_COOLDOWN = 1000; // 1 second between play requests

    // ------------------- SPOTIFY WEB PLAYBACK SDK -------------------
    window.onSpotifyWebPlaybackSDKReady = () => {
        console.log('Spotify Web Playback SDK is ready.');
        if (!accessToken) {
            console.error('No Spotify access token available.');
            playerStatus.textContent = "Please connect to Spotify on the home page.";
            return;
        }

        player = new Spotify.Player({
            name: 'JamRoom Music Player',
            getOAuthToken: cb => { 
                console.log('Requesting OAuth token for SDK.');
                cb(accessToken); 
            },
            volume: 0.7
        });
        
        player.addListener('ready', ({ device_id }) => {
            console.log('Ready with Device ID', device_id);
            deviceId = device_id;
            playerStatus.textContent = "";
            socket.emit('sync_request', { room_key: roomKey });
            console.log('Emitted sync_request to server.');
        });
        
        player.addListener('not_ready', ({ device_id }) => {
            console.log('Device ID has gone offline', device_id);
            playerStatus.textContent = "";
        });

        player.addListener('initialization_error', ({ message }) => {
            console.error('Failed to initialize:', message);
            playerStatus.textContent = "";
        });
        player.addListener('authentication_error', ({ message }) => {
                console.error('Authentication error:', message);
                playerStatus.textContent = "";
        });

        player.addListener('playback_error', ({ message }) => {
            console.error('Playback error:', message);
            playerStatus.textContent = "";
        });

        player.addListener('player_state_changed', (state) => {
            console.log('Player state changed:', state);
            if (!state || !state.track_window.current_track) {
                console.log('Playback stopped. Resetting UI.');
                currentTrack = null;
                stopProgressUpdates();
                playerArtwork.src = DEFAULT_ARTWORK;
                playerCurrentTrack.textContent = 'Current Track: [No track playing]';
                playPauseButton.textContent = '▶️';
                progressBar.style.width = '0%';
                currentTimeElement.textContent = '0:00';
                durationElement.textContent = '0:00';
                return;
            }
            
            const track = state.track_window.current_track;
            currentTrack = track;
            playerArtwork.src = track.album.images[0].url;
            playerCurrentTrack.textContent = `${track.name} - ${track.artists[0].name}`;
            playPauseButton.textContent = state.paused ? '▶️' : '⏸️';
            
            if (!state.paused) {
                startProgressUpdates();
            } else {
                stopProgressUpdates();
            }

            if (isPlayingSource) {
                console.log('This client is the source, emitting song_update.');
                socket.emit('song_update', {
                    room_key: roomKey,
                    state: {
                        is_paused: state.paused,
                        track_uri: track.uri,
                        position_ms: state.position,
                        duration_ms: track.duration_ms, // Use track.duration_ms
                        track_info: {
                            title: track.name,
                            artist: track.artists[0].name,
                            artwork: track.album.images[0].url,
                            album: track.album.name,
                            duration: track.duration_ms
                        }
                    }
                });
            }
        });

        player.connect().then(success => {
            if (success) {
                console.log('The Web Playback SDK successfully connected to Spotify!');
            }
        });
    };
    
    // ------------------- PLAYBACK CONTROLS & LOGIC -------------------
    const playSong = (songUri, position_ms = 0) => {
        const now = Date.now();
        if (now - lastPlayTime < PLAY_COOLDOWN) {
            console.log('Rate limited. Too soon since last play request.');
            return;
        }
        
        if (!player || !deviceId) {
            console.error('Player not ready.');
            playerStatus.textContent = '';
            return;
        }

        lastPlayTime = now;
        lastPlayedSongUri = songUri;
        
        fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
            method: 'PUT',
            body: JSON.stringify({ uris: [songUri], position_ms }),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
        })
        .then(response => {
            if (!response.ok) {
                console.error('Spotify API error:', response.status);
                playerStatus.textContent = `Error playing song. Status: ${response.status}`;
            } else {
                playerStatus.textContent = '';
            }
        })
        .catch(error => {
            console.error('Fetch error:', error);
            playerStatus.textContent = 'An error occurred. Please check your network.';
        });
    };

    if (playPauseButton) {
        playPauseButton.addEventListener('click', () => {
            console.log('Play/Pause button clicked.');
            if (player) {
                player.togglePlay();
                // State change will be handled by the player_state_changed listener
            }
        });
    }

    // Previous/Next button functionality
    if (prevButton) prevButton.addEventListener('click', () => {
        if (player) {
            player.previousTrack();
            if (isPlayingSource) {
                // Emit a sync event for previous track if this client is the source
                socket.emit('player_previous_track', { room_key: roomKey });
            }
        }
    });
    if (nextButton) nextButton.addEventListener('click', () => {
        if (player) {
            player.nextTrack();
            if (isPlayingSource) {
                // Emit a sync event for next track if this client is the source
                socket.emit('player_next_track', { room_key: roomKey });
            }
        }
    });

    // Progress bar click to seek
    if (progressContainer) {
        progressContainer.addEventListener('click', (e) => {
            if (player && currentTrack && currentTrack.duration_ms) { // Ensure duration is available
                const rect = progressContainer.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                const width = rect.width;
                const clickPosition = (clickX / width);
                const seekToMs = Math.round(clickPosition * currentTrack.duration_ms);
                player.seek(seekToMs);
                if (isPlayingSource) {
                    socket.emit('player_seek', {
                        room_key: roomKey,
                        position_ms: seekToMs
                    });
                }
            }
        });
    }

    // Volume control
    if (volumeSlider) {
        volumeSlider.addEventListener('input', (e) => {
            const volume = e.target.value / 100;
            if (player) {
                player.setVolume(volume);
                volumeDisplay.textContent = `${e.target.value}%`;
            }
        });
    }
    
    // Helper function to format time
    function formatTime(ms) { // Changed to accept milliseconds
        const seconds = Math.floor(ms / 1000);
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    // Function to update progress bar and time display
    function updateProgress() {
        if (player) {
            player.getCurrentState().then(state => {
                if (state && state.track_window.current_track) {
                    const progress = (state.position / state.duration) * 100;
                    progressBar.style.width = `${progress}%`;
                    currentTimeElement.textContent = formatTime(state.position);
                    durationElement.textContent = formatTime(state.duration);
                }
            }).catch(error => {
                console.error('Error getting current state for progress update:', error);
            });
        }
    }

    function startProgressUpdates() {
        if (progressUpdateInterval) clearInterval(progressUpdateInterval);
        progressUpdateInterval = setInterval(updateProgress, 1000);
    }

    function stopProgressUpdates() {
        if (progressUpdateInterval) {
            clearInterval(progressUpdateInterval);
            progressUpdateInterval = null;
        }
    }

    // Function to get detailed track information from Spotify API
    function getTrackDetails(trackUri) {
        if (!trackUri || !accessToken) return Promise.resolve(null);
        const trackId = trackUri.replace('spotify:track:', '');
        
        return fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        })
        .then(response => {
            if (response.ok) return response.json();
            return null;
        })
        .catch(error => {
            console.error('Error fetching track details:', error);
            return null;
        });
    }

    // ------------------- MUSIC SEARCH LOGIC -------------------
    if (musicSearchInput && musicResultsContainer) {
        let searchTimeoutId = null;

        const renderResults = (songs) => {
            musicResultsContainer.innerHTML = '';
            if (!songs || songs.length === 0) {
                musicResultsContainer.innerHTML = '<p>No results found.</p>';
                return;
            }
            songs.forEach(song => {
                const card = document.createElement('div');
                card.className = 'music-card';
                card.dataset.songUri = song.uri;
                card.dataset.songTitle = song.title;
                card.dataset.songArtist = song.artist;
                card.dataset.songArtwork = song.artwork;
                
                // Construct the innerHTML for the card
                card.innerHTML = `
                    <img src="${song.artwork || DEFAULT_ARTWORK}" alt="Album Artwork" class="music-card-artwork">
                    <div class="music-card-info">
                        <span class="song-title">${song.title || 'Unknown Title'}</span>
                        <span class="song-artist">${song.artist || 'Unknown Artist'}</span>
                    </div>
                `;
                
                card.addEventListener('click', () => {
                    const songUri = card.dataset.songUri;
                    if (songUri) {
                        isPlayingSource = true;
                        playSong(songUri);
                    }
                });
                musicResultsContainer.appendChild(card);
            });
        };


        const fetchResults = (q) => {
            if (!q) { musicResultsContainer.innerHTML = ''; return; }
            fetch(`/api/search?q=${encodeURIComponent(q)}`)
                .then(r => {
                    if (!r.ok) {
                        throw new Error(`HTTP error! status: ${r.status}`);
                    }
                    return r.json();
                })
                .then(renderResults)
                .catch(error => { 
                    console.error('Error fetching music:', error);
                    musicResultsContainer.innerHTML = '<p>Failed to load music results.</p>'; 
                });
        };

        musicSearchInput.addEventListener('keyup', (e) => {
            const q = e.target.value.trim();
            clearTimeout(searchTimeoutId);
            searchTimeoutId = setTimeout(() => fetchResults(q), 500);
        });
    }

    // ------------------- SOCKET.IO EVENT HANDLERS -------------------
    socket.on('connect', () => {
        socket.emit('join', { username: username, room_key: roomKey });
    });

    socket.on('new_message', (data) => {
        const messageElement = document.createElement('div');
        messageElement.innerHTML = `<strong>${data.username}:</strong> ${data.msg}`;
        messagesContainer.appendChild(messageElement);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });

    socket.on('room_message', (data) => {
        const messageElement = document.createElement('div');
        messageElement.innerHTML = `<em>${data.msg}</em>`;
        messagesContainer.appendChild(messageElement);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        
        const match = data.msg.match(/\((\d+)\slisteners\)/);
        if (match) {
            listenerCountElement.innerHTML = match[1];
        }
    });

    socket.on('sync_toggle_play', (data) => {
        if (player) {
            if (data.is_paused) {
                player.pause();
            } else {
                player.resume();
            }
        }
    });
    
    socket.on('sync_seek', (data) => {
        if (player) {
            player.seek(data.position_ms);
        }
    });

    socket.on('song_play_sync', (data) => {
        // If this client is currently the source, do not sync from other clients
        if (isPlayingSource) {
            console.log("Already playing as source, ignoring song_play_sync from others.");
            return;
        }

        isPlayingSource = false; // Confirm this client is a listener
        if (data && data.song && data.song.uri) {
            // Update UI immediately for listeners
            if (data.song.title && data.song.artist) {
                playerCurrentTrack.textContent = `${data.song.title} - ${data.song.artist}`;
            }
            if (data.song.artwork) {
                playerArtwork.src = data.song.artwork;
            }
            playSong(data.song.uri, data.position_ms || 0);
        }
    });

    socket.on('sync_playback', (data) => {
        // This event is typically for initial sync when joining
        if (data && data.track_uri) {
            // Update UI immediately
            if (data.track_info) {
                playerCurrentTrack.textContent = `${data.track_info.title} - ${data.track_info.artist}`;
                playerArtwork.src = data.track_info.artwork || DEFAULT_ARTWORK;
            }
            playSong(data.track_uri, data.position_ms || 0);
            
            if (data.is_paused) {
                setTimeout(() => {
                    if (player) player.pause();
                }, 1000);
            }
        }
    });

    // Handle button click to leave the room
    leaveRoomButton.addEventListener('click', () => {
        console.log('Leave room button clicked.');
        stopProgressUpdates(); // Stop progress updates when leaving
        if (player) {
            player.disconnect(); // Disconnect Spotify player
        }
        socket.emit('leave', { username: username, room_key: roomKey });
        
        setTimeout(() => {
            console.log('Redirecting to home page.');
            window.location.href = '/home';
        }, 150);
    });

    // Clean up progress updates when page is unloaded
    window.addEventListener('beforeunload', () => {
        stopProgressUpdates();
        if (player) {
            player.disconnect(); // Ensure player is disconnected on page unload
        }
    });
});